import type { VaultProvider, ProviderContext, DownloadFile, AddTaskResult, DeleteTaskResult, ExecuteTaskResult, TaskErrorResult } from '@vault-flow/provider-api';
import { MediaType, FileStatus, DownloadStatus } from '@vault-flow/provider-api';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page } from 'puppeteer-core';
import { writeFileSync } from 'fs';
import { FetchItem, ApiData, getDetailUrl, getDownloadUrls } from './api';
import { COLLECTION_URL, unfavoritePage } from './actions';

puppeteer.use(StealthPlugin());

const STORAGE_KEY_COOKIES = 'cookies';

function sanitizeDirName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.+$/, '')
    .replace(/\s+$/, '')
    .trim() || 'unknown';
}

export class DouyinFavoriteProvider implements VaultProvider {
  constructor() { }

  private parseCookies(cookies: string): { name: string; value: string; domain: string; path: string }[] {
    return cookies.split(';').map(c => c.trim()).filter(Boolean).map(pair => {
      const [name, ...valueParts] = pair.split('=');
      return { name: name.trim(), value: valueParts.join('=').trim(), domain: '.douyin.com', path: '/' };
    }).filter(c => c.name && c.value);
  }

  private async checkLogin(ctx: ProviderContext, browser: Browser, timeout = 60000): Promise<{ username: string; userId: string }> {
    let username = '', userId = '';
    let page: Page | null = null;
    try {
      page = await browser.newPage();
      await page.goto(COLLECTION_URL, { waitUntil: 'networkidle2', timeout });
      for (let i = 0; i < 10; i++) {
        const result = await page.evaluate(() => {
          const nameEl = document.querySelector('[data-e2e="user-info"] h1')
            || document.querySelector('[class*="user-info"] [class*="name"]');
          const name = (nameEl as HTMLElement | null)?.innerText?.trim() || '';
          let uid = '';
          const infoEl = document.querySelector('[data-e2e="user-info"]');
          const allText = (infoEl as HTMLElement | null)?.innerText || '';
          const match = allText.match(/抖音号[：:](\S+)/);
          if (match) uid = match[1];
          return { name, uid };
        });
        if (result.name) { username = result.name; userId = result.uid; break; }
        await new Promise<void>(r => setTimeout(r, 1000));
      }
    } catch (err) {
      console.error('[douyin] checkLogin error:', (err as Error).message);
    } finally {
      if (page) await page.close().catch(() => { });
    }
    return { username, userId };
  }

  private msg(locale: string, key: string, fallback: string): string {
    const messages: Record<string, Record<string, string>> = {
      'cookie_required': { 'zh-CN': '请填写 Cookie', 'zh-TW': '請填寫 Cookie', 'en-US': 'Cookie is required' },
      'login_expired': { 'zh-CN': '抖音登录已过期', 'zh-TW': '抖音登入已過期', 'en-US': 'Douyin login expired' },
    };
    const m = messages[key];
    return m ? (m[locale] || m['en-US'] || fallback) : fallback;
  }

  async addTask(ctx: ProviderContext): Promise<AddTaskResult | TaskErrorResult> {
    const cookies = (ctx.config.cookies as string) || '';
    if (!cookies) {
      return { success: false, message: this.msg(ctx.locale, 'cookie_required', 'Cookie is required') };
    }
    const taskName = (ctx.config.taskName as string) || `Task-${new Date().toISOString().slice(0, 10)}`;
    return { success: true, name: taskName };
  }

  async deleteTask(ctx: ProviderContext, taskId: string): Promise<DeleteTaskResult | TaskErrorResult> {
    return { success: true };
  }

  async onTaskConfigUpdate(_ctx: ProviderContext, _taskId: string): Promise<DeleteTaskResult> {
    return { success: true };
  }

  private async collectItems(page: Page, maxItems = 100): Promise<FetchItem[]> {
    const allItems: FetchItem[] = [];
    const seenIds = new Set<string>();

    const handler = async (res: import('puppeteer-core').HTTPResponse) => {
      const url = res.url();
      if (!url.includes('listcollection')) return;
      try {
        const text = await res.text();
        let parsed: Record<string, unknown> | null = null;
        try { parsed = JSON.parse(text); } catch (_e) {
          const match = text.match(/=\s*({.+})\s*;?\s*$/s);
          if (match) { try { parsed = JSON.parse(match[1]); } catch (_e2) { /* */ } }
        }
        if (!parsed) return;
        const apiData = parsed as { aweme_list?: Array<{ aweme_id: string; aweme_type: number; desc?: string; author?: { nickname?: string }; author_user_id: number; video?: Record<string, unknown>; images?: Array<Record<string, unknown>> }> };
        for (const item of (apiData?.aweme_list || [])) {
          if (!seenIds.has(item.aweme_id)) {
            seenIds.add(item.aweme_id);
            allItems.push({
              id: item.aweme_id, type: item.aweme_type, desc: item.desc || '',
              author: item.author?.nickname || '', author_id: item.author_user_id,
              video: (item.video || null) as Record<string, unknown> | null,
              images: (item.images || []) as Array<Record<string, unknown>>,
              raw: item
            });
          }
        }
      } catch (_e) { /* */ }
    };

    page.on('response', handler);
    try {
      await page.goto(COLLECTION_URL, { waitUntil: 'networkidle2', timeout: 60000 });
      for (let i = 0; i < 15 && allItems.length === 0; i++) {
        await new Promise<void>(r => setTimeout(r, 1000));
      }
      while (allItems.length < maxItems) {
        const prevCount = allItems.length;
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
        await new Promise<void>(r => setTimeout(r, 2000));
        for (let i = 0; i < 5 && allItems.length === prevCount; i++) {
          await new Promise<void>(r => setTimeout(r, 1000));
        }
        if (allItems.length === prevCount) break;
      }
      console.log(`[douyin] collectItems: ${allItems.length} items collected`);
      return allItems.slice(0, maxItems);
    } finally {
      page.off('response', handler);
    }
  }

  async executeTask(ctx: ProviderContext): Promise<ExecuteTaskResult> {
    const startTime = Date.now();

    const cookies = (ctx.config.cookies as string) || '';
    const puppeteerCookies = this.parseCookies(cookies);
    const downloadPathTemplate = (ctx.config.downloadPath as string) || '{type}/{user}/{author_id}_{author}';

    let browser: Browser | null = null;
    let page: Page | null = null;
    try {
      browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] }) as Browser;
      if (puppeteerCookies.length > 0) await browser.setCookie(...puppeteerCookies);

      page = await browser!.newPage();
      await page.setViewport({ width: 1280, height: 800 });

      const { username, userId: uid } = await this.checkLogin(ctx, browser!, 60000);
      if (!username) {
        ctx.addLog('warn', 'Douyin login expired');
        return { state: 2 as any, message: this.msg(ctx.locale, 'login_expired', 'Douyin login expired'), downloaded: 0, failed: 0, total: 0, duration: Date.now() - startTime };
      }

      const unfavoriteWithNewPage = async (detailUrl: string): Promise<void> => {
        const actionPage = await browser!.newPage();
        await actionPage.setViewport({ width: 1280, height: 800 });
        try {
          await unfavoritePage(actionPage, detailUrl);
        } finally {
          await actionPage.close().catch(() => { });
        }
      };

      // Phase 1: Collect items
      const items = await this.collectItems(page!);
      await page!.close().catch(() => {});
      page = null;
      ctx.addLog('info', `Collected ${items.length} items`);

      // Phase 2: Download all items
      ctx.emitTaskProgress(0, items.length);
      let downloaded = 0, failed = 0;
      for (let i = 0; i < items.length; i++) {
        ctx.emitTaskProgress(i, items.length);
        const item = items[i];
        const detailUrl = getDetailUrl(item);
        if (ctx.hasSuccessfulDownloadRecord(item.id)) {
          await unfavoriteWithNewPage(detailUrl);
          continue;
        }
        const downloadUrls = getDownloadUrls(item);
        if (downloadUrls.length === 0) {
          ctx.addLog('warn', `No download URLs: ${item.id} (${item.author})`);
          ctx.addDownloadRecord({ id: item.id, author: item.author, authorId: String(item.author_id), desc: item.desc, state: DownloadStatus.Failed, stateMessage: 'no download urls', files: [], dataJson: { detailUrl, raw: item.raw } });
          failed++;
          continue;
        }
        try {
          const files: DownloadFile[] = [];
          const vars: Record<string, string> = {
            type: 'douyin', user: sanitizeDirName(username), id: uid,
            author: sanitizeDirName(item.author || 'unknown'), author_id: String(item.author_id || 'unknown')
          };
          const userDir = downloadPathTemplate.replace(/\{(\w+)\}/g, (_, k) => vars[k] || k);
          const fullUserDir = ctx.path.join(ctx.downloadDir, userDir);
          if (!ctx.fs.existsSync(fullUserDir)) ctx.fs.mkdirSync(fullUserDir, { recursive: true });
          for (const dl of downloadUrls) {
            files.push({ type: dl.type, filename: dl.filename, url: dl.urls[0] || '', fileSize: 0, fileExpectedSize: 0, fileStatus: FileStatus.Downloading });
          }
          ctx.addDownloadRecord({ id: item.id, author: item.author, authorId: String(item.author_id), desc: item.desc, state: DownloadStatus.Downloading, stateMessage: '', files, dataJson: { detailUrl, raw: item.raw } });

          await Promise.all(downloadUrls.map(async (dl, fi) => {
            const dest = ctx.path.join(fullUserDir, dl.filename);
            for (const url of dl.urls) {
              try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 30000);
                const resp = await fetch(url, {
                  headers: { 'Cookie': cookies, 'Referer': 'https://www.douyin.com/', 'Origin': 'https://www.douyin.com' },
                  signal: controller.signal,
                });
                clearTimeout(timeout);
                if (!resp.ok) continue;
                const buffer = Buffer.from(await resp.arrayBuffer());
                files[fi].fileSize = buffer.length;
                files[fi].fileExpectedSize = buffer.length;
                files[fi].url = url;
                writeFileSync(dest, buffer);
                files[fi].fileStatus = FileStatus.Success;
                ctx.updateDownloadRecord(item.id, { files });
                ctx.emitDownloadProgress(item.id, files);
                return;
              } catch (_e) { /* try next url */ }
            }
            files[fi].fileStatus = FileStatus.Failed;
            ctx.updateDownloadRecord(item.id, { files });
          }));

          const allSuccess = files.length > 0 && files.every(f => f.fileStatus === FileStatus.Success);
          if (allSuccess) {
            ctx.updateDownloadRecord(item.id, { state: DownloadStatus.Success, stateMessage: '', files });
            ctx.addLog('info', `Downloaded: ${item.author} (${item.author_id})/${item.id} | ${files.length} files`);
            downloaded++;
          } else {
            const failedFiles = files.filter(f => f.fileStatus !== FileStatus.Success).map(f => `${f.filename}(${f.fileStatus})`).join(', ');
            ctx.updateDownloadRecord(item.id, { state: DownloadStatus.Failed, stateMessage: `partial: ${failedFiles}`, files });
            ctx.addLog('warn', `Partial download failed: ${item.id} (${item.author}) | failed files: ${failedFiles}`);
            failed++;
          }
        } catch (err) {
          ctx.addLog('error', `Download error: ${item.id} - ${(err as Error).message}`);
          ctx.addDownloadRecord({ id: item.id, author: item.author, authorId: String(item.author_id), desc: item.desc, state: DownloadStatus.Failed, stateMessage: (err as Error).message.slice(0, 50), files: [], dataJson: { detailUrl, raw: item.raw } });
          failed++;
        }
        await unfavoriteWithNewPage(detailUrl);
        ctx.emitTaskProgress(i + 1, items.length);
      }

      // Refresh cookies after task execution
      try {
        const currentCookies = await browser!.cookies();
        const cookieStr = currentCookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
        if (cookieStr) {
          ctx.saveConfig({ ...ctx.config, cookies: cookieStr });
        }
      } catch (_e) { /* ignore cookie refresh errors */ }

      return {
        state: 1,
        message: 'ok',
        downloaded, failed,
        total: downloaded + failed,
        duration: Date.now() - startTime
      };
    } catch (err) {
      ctx.addLog('error', `Douyin task error: ${(err as Error).message}`);
      return { state: 0, message: (err as Error).message, downloaded: 0, failed: 0, total: 0, duration: Date.now() - startTime };
    } finally {
      if (page) await page.close().catch(() => { });
      if (browser) {
        await Promise.race([
          browser.close(),
          new Promise<void>(r => setTimeout(() => { try { (browser as any).process()?.kill(); } catch {} r(); }, 10000)),
        ]).catch(() => {});
      }
    }
  }
}

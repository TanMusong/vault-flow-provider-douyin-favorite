import type { VaultProvider, ProviderContext, DownloadFile, AddTaskParams, AddTaskResponse, ProviderResult } from '@vault-flow/provider-api';
import { MediaType, FileStatus, DownloadStatus } from '@vault-flow/provider-api';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page } from 'puppeteer-core';
import { writeFileSync } from 'fs';
import { FetchItem, ApiData, getDetailUrl, getDownloadUrls } from './api';
import { COLLECTION_URL, interceptApiResponse, unfavoritePage } from './actions';

puppeteer.use(StealthPlugin());

const STORAGE_KEY_COOKIES = 'cookies';

export class DouyinFavoriteProvider implements VaultProvider {
  constructor() { }

  private async checkLogin(ctx: ProviderContext, browser: Browser, timeout = 60000): Promise<{ username: string; userId: string }> {
    let username = '', userId = '';
    let page: Page | null = null;
    try {
      page = await browser.newPage();
      const cookies = ctx.storage.get<string>(STORAGE_KEY_COOKIES) || '';
      if (cookies) {
        const cookiePairs = cookies.split(';').map(c => c.trim()).filter(Boolean);
        const puppeteerCookies = cookiePairs.map(pair => {
          const [name, ...valueParts] = pair.split('=');
          return { name: name.trim(), value: valueParts.join('=').trim(), domain: '.douyin.com', path: '/' };
        }).filter(c => c.name && c.value);
        if (puppeteerCookies.length > 0) await page.setCookie(...puppeteerCookies);
      }
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

  async addTask(ctx: ProviderContext, params: AddTaskParams): Promise<AddTaskResponse> {
    const cookies = params.cookies as string || '';
    if (!cookies) {
      return { success: false, message: 'Cookie is required' };
    }
    let browser: Browser | null = null;
    try {
      browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] }) as Browser;
      const { username, userId } = await this.checkLogin(ctx, browser, 60000);
      if (!username) {
        return { success: false, message: 'Douyin login expired' };
      }
      ctx.storage.set(STORAGE_KEY_COOKIES, cookies);
      return { success: true, name: username };
    } catch (err) {
      return { success: false, message: (err as Error).message };
    } finally {
      if (browser) await browser.close().catch(() => { });
    }
  }

  async deleteTask(ctx: ProviderContext, taskId: string): Promise<ProviderResult> {
    return { success: true };
  }

  private async fetchItems(page: Page, skipIds?: string[]): Promise<{ items: FetchItem[]; has_more: 0 | 1 }> {
    const captured = await interceptApiResponse(page, 'listcollection', COLLECTION_URL);
    if (!captured) return { items: [], has_more: 0 };

    const apiData = captured as unknown as { aweme_list?: Array<{ aweme_id: string; aweme_type: number; desc?: string; author?: { nickname?: string }; author_user_id: number; video?: Record<string, unknown>; images?: Array<Record<string, unknown>> }>; has_more?: 0 | 1 };
    const has_more = apiData?.has_more || 0;
    const items: FetchItem[] = (apiData?.aweme_list || [])
      .filter(item => !skipIds || skipIds.indexOf(item.aweme_id) < 0)
      .map((item) => ({
        id: item.aweme_id,
        type: item.aweme_type,
        desc: item.desc || '',
        author: item.author?.nickname || '',
        author_id: item.author_user_id,
        video: (item.video || null) as Record<string, unknown> | null,
        images: (item.images || []) as Array<Record<string, unknown>>,
        raw: item
      }));

    return { items, has_more };
  }

  async executeTask(ctx: ProviderContext): Promise<{ state: number; message: string; downloaded: number; failed: number; total: number; duration: number }> {
    const startTime = Date.now();

    const cookies = ctx.storage.get<string>(STORAGE_KEY_COOKIES) || '';
    const downloadPathTemplate = ctx.storage.get<string>('downloadPath') || '{type}/{user}/{author_id}_{author}';

    let browser: Browser | null = null;
    let page: Page | null = null;
    try {
      browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] }) as Browser;
      page = await browser!.newPage();
      await page.setViewport({ width: 1280, height: 800 });

      if (cookies) {
        const cookiePairs = cookies.split(';').map(c => c.trim()).filter(Boolean);
        const puppeteerCookies = cookiePairs.map(pair => {
          const [name, ...valueParts] = pair.split('=');
          return { name: name.trim(), value: valueParts.join('=').trim(), domain: '.douyin.com', path: '/' };
        }).filter(c => c.name && c.value);
        if (puppeteerCookies.length > 0) await page.setCookie(...puppeteerCookies);
      }

      const { username, userId: uid } = await this.checkLogin(ctx, browser!, 60000);
      if (!username) {
        ctx.addLog('warn', 'Douyin login expired');
        return { state: 2 as any, message: 'status.login_expired', downloaded: 0, failed: 0, total: 0, duration: Date.now() - startTime };
      }
      let downloaded = 0, failed = 0;
      const skipIds: string[] = [];
      const unfavoriteWithNewPage = async (detailUrl: string): Promise<void> => {
        const actionPage = await browser!.newPage();
        const cookiePairs = cookies.split(';').map(c => c.trim()).filter(Boolean);
        const puppeteerCookies = cookiePairs.map(pair => {
          const [name, ...valueParts] = pair.split('=');
          return { name: name.trim(), value: valueParts.join('=').trim(), domain: '.douyin.com', path: '/' };
        }).filter(c => c.name && c.value);
        if (puppeteerCookies.length > 0) await actionPage.setCookie(...puppeteerCookies);
        await actionPage.setViewport({ width: 1280, height: 800 });
        try {
          await unfavoritePage(actionPage, detailUrl);
        } finally {
          await actionPage.close().catch(() => { });
        }
      };

      const processItem = async (item: FetchItem): Promise<void> => {
        skipIds.push(item.id);
        const detailUrl = getDetailUrl(item);
        if (ctx.hasSuccessfulDownloadRecord(item.id)) {
          await unfavoriteWithNewPage(detailUrl);
          return;
        }
        const downloadUrls = getDownloadUrls(item);
        if (downloadUrls.length === 0) {
          ctx.addLog('warn', `No download URLs: ${item.id} (${item.author})`);
          ctx.addDownloadRecord({ id: item.id, author: item.author, authorId: String(item.author_id), desc: item.desc, state: DownloadStatus.Failed, stateMessage: 'no download urls', files: [], dataJson: { detailUrl, raw: item.raw } });
          failed++;
          return;
        }
        try {
          const files: DownloadFile[] = [];
          const vars: Record<string, string> = {
            type: 'douyin',
            user: username,
            id: uid,
            author: item.author || 'unknown',
            author_id: String(item.author_id || 'unknown')
          };
          const userDir = downloadPathTemplate.replace(/\{(\w+)\}/g, (_, k) => vars[k] || k);
          const fullUserDir = ctx.path.join(ctx.configDir, 'downloads', userDir);
          if (!ctx.fs.existsSync(fullUserDir)) ctx.fs.mkdirSync(fullUserDir, { recursive: true });
          for (const dl of downloadUrls) {
            files.push({ type: dl.type, filename: dl.filename, url: dl.urls[0] || '', fileSize: 0, fileExpectedSize: 0, fileStatus: FileStatus.Downloading });
          }
          ctx.addDownloadRecord({ id: item.id, author: item.author, authorId: String(item.author_id), desc: item.desc, state: DownloadStatus.Downloading, stateMessage: '', files, dataJson: { detailUrl, raw: item.raw } });

          await Promise.all(downloadUrls.map(async (dl, fi) => {
            const dest = ctx.path.join(fullUserDir, dl.filename);
            for (const url of dl.urls) {
              try {
                const resp = await fetch(url, {
                  headers: { 'Cookie': cookies, 'Referer': 'https://www.douyin.com/', 'Origin': 'https://www.douyin.com' }
                });
                if (!resp.ok) continue;
                const contentLength = Number(resp.headers.get('content-length') || '0');
                files[fi].fileExpectedSize = contentLength;
                const buffer = Buffer.from(await resp.arrayBuffer());
                files[fi].fileSize = buffer.length;
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
          console.error('[douyin] download error:', (err as Error).message);
          ctx.addLog('error', `Download error: ${item.id} - ${(err as Error).message}`);
          ctx.addDownloadRecord({ id: item.id, author: item.author, authorId: String(item.author_id), desc: item.desc, state: DownloadStatus.Failed, stateMessage: (err as Error).message.slice(0, 50), files: [], dataJson: { detailUrl, raw: item.raw } });
          failed++;
        }
        await unfavoriteWithNewPage(detailUrl);
      };

      let fetched: { items: FetchItem[]; has_more: 0 | 1; };
      let maxRequestCount = 20;
      let processedCount = 0;
      do {
        fetched = await this.fetchItems(page!, skipIds);
        maxRequestCount--;
        const concurrency = 3;
        const items = fetched.items;
        for (let i = 0; i < items.length; i += concurrency) {
          await Promise.all(items.slice(i, i + concurrency).map(item => processItem(item)));
        }
        processedCount += fetched.items.length;
        ctx.emitTaskProgress(processedCount, processedCount);
      } while (fetched.items?.length !== 0 && fetched.has_more === 1 && maxRequestCount > 0);

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
      if (browser) await browser.close().catch(() => { });
    }
  }
}

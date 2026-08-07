import type { Page } from 'puppeteer-core';

export const COLLECTION_URL = 'https://www.douyin.com/user/self?showSubTab=video&showTab=favorite_collection';

export async function interceptApiResponse(
  page: Page,
  urlPattern: string,
  navigateUrl: string,
  maxWaitMs: number = 30000
): Promise<Record<string, unknown> | null> {
  let captured: Record<string, unknown> | null = null;

  const handler = async (res: import('puppeteer-core').HTTPResponse) => {
    if (captured) return;
    const url = res.url();
    if (!url.includes(urlPattern)) return;
    try {
      const text = await res.text();
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(text);
      } catch (_e) {
        const match = text.match(/=\s*({.+})\s*;?\s*$/s);
        if (match) {
          try { parsed = JSON.parse(match[1]); } catch (_e2) { /* */ }
        }
      }
      if (parsed) captured = parsed;
    } catch (_e) { /* */ }
  };

  page.on('response', handler);
  try {
    await page.goto(navigateUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    for (let i = 0; i < maxWaitMs / 1000 && !captured; i++) {
      await new Promise<void>(r => setTimeout(r, 1000));
    }
    return captured;
  } finally {
    page.off('response', handler);
  }
}

export async function unfavoritePage(page: Page, detailUrl: string): Promise<void> {
  for (let retry = 0; retry < 3; retry++) {
    await new Promise<void>(r => setTimeout(r, 3000));
    try {
      await page.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      const beforeState = await page.evaluate(() => {
        const btn = document.querySelector('[data-e2e="video-player-collect"]');
        return btn?.getAttribute('data-e2e-state') || 'none';
      });
      if (beforeState === 'none') continue;
      if (beforeState !== 'video-player-is-collected') return;
      await page.evaluate(() => {
        const btn = document.querySelector('[data-e2e="video-player-collect"]') as HTMLElement | null;
        if (btn) btn.click();
      });
      for (let i = 0; i < 10; i++) {
        await new Promise<void>(r => setTimeout(r, 1000));
        const afterState = await page.evaluate(() => {
          const btn = document.querySelector('[data-e2e="video-player-collect"]');
          return btn?.getAttribute('data-e2e-state') || 'none';
        });
        if (afterState === 'video-player-no-collect') return;
        if (afterState === 'none') break;
      }
    } catch (e) {
    }
  }
  console.error('[douyin] unfavorite error: failed to unfavorite after 10 seconds');
}

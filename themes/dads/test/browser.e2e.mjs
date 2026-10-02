// 実際の Miniflux にテーマを適用した状態で、ブラウザでの表示と上流 CSS との互換性を確認する（CI の theme-e2e ジョブ）。
//   MINIFLUX_URL=http://localhost:8080 ADMIN_USERNAME=admin ADMIN_PASSWORD=... node themes/dads/test/browser.e2e.mjs
// - 契約: Miniflux が配信するテーマ CSS の :root 変数と、このテーマが定義する変数が一致すること
//   （Miniflux の更新で変数名が変わると、テーマが静かに効かなくなるため）
// - 表示: ライト/ダークで背景色・文字色・フォント、Tab 移動時のフォーカス表示、狭い画面で横にはみ出さないこと
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.MINIFLUX_URL ?? 'http://localhost:8080';
const username = process.env.ADMIN_USERNAME ?? 'admin';
const password = process.env.ADMIN_PASSWORD;
assert.ok(password, 'ADMIN_PASSWORD is required');

const ours = readFileSync(new URL('../miniflux.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const ourMinifluxVars = new Set(
  [...ours.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]).filter((v) => !v.startsWith('--dads-') && !v.startsWith('--ftr-')),
);

const browser = await chromium.launch();
const failures = [];
const check = (label, fn) => {
  try {
    fn();
    console.log(`ok   ${label}`);
  } catch (err) {
    failures.push(label);
    console.log(`FAIL ${label}: ${err.message}`);
  }
};

try {
  // ---- ログイン（Miniflux は未ログイン時に / でログインフォームを表示し、POST /login で認証する） ----
  const context = await browser.newContext({ colorScheme: 'light' });
  const page = await context.newPage();
  await page.goto(`${base}/`);
  try {
    await page.fill('input[name="username"]', username, { timeout: 10_000 });
  } catch (err) {
    console.error(`login form not found at ${page.url()}:\n${(await page.content()).slice(0, 1500)}`);
    throw err;
  }
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForURL((url) => url.pathname !== '/' && !url.pathname.startsWith('/login')),
    page.click('button[type="submit"]'),
  ]);
  const storage = await context.storageState();

  // ---- 契約: 上流のテーマ変数 ----
  const cssHref = await page.$eval('link[rel="stylesheet"][href*="stylesheets/"]', (el) => el.href);
  const upstreamCss = await (await page.request.get(cssHref)).text();
  const upstreamVars = new Set(
    [...upstreamCss.matchAll(/:root\s*\{([^}]*)\}/g)].flatMap((m) => [...m[1].matchAll(/(--[\w-]+)\s*:/g)].map((v) => v[1])),
  );
  check(`upstream theme variables found (${upstreamVars.size}) in ${new URL(cssHref).pathname}`, () => assert.ok(upstreamVars.size >= 50));
  check('all variables we override exist upstream (no renamed/removed variables)', () => {
    assert.deepEqual([...ourMinifluxVars].filter((v) => !upstreamVars.has(v)), []);
  });
  check('we override every upstream theme variable (no variable falls back to the stock theme)', () => {
    assert.deepEqual([...upstreamVars].filter((v) => !ourMinifluxVars.has(v)), []);
  });

  // ---- 表示 ----
  const styleOf = (p, selector) => p.$eval(selector, (el) => {
    const s = getComputedStyle(el);
    return { color: s.color, background: s.backgroundColor, font: s.fontFamily };
  });

  const light = await styleOf(page, 'body');
  check('light: body background is DADS white', () => assert.equal(light.background, 'rgb(255, 255, 255)'));
  check('light: body text is DADS Solid Gray 800', () => assert.equal(light.color, 'rgb(51, 51, 51)'));
  check('light: font stack starts with Noto Sans JP', () => assert.match(light.font, /^"?Noto Sans JP/));

  await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement);
    return { tag: document.activeElement.tagName, outlineStyle: s.outlineStyle, outlineColor: s.outlineColor, shadow: s.boxShadow };
  });
  check(`light: keyboard focus (${focus.tag}) shows black outline + yellow ring`, () => {
    assert.equal(focus.outlineStyle, 'solid');
    assert.equal(focus.outlineColor, 'rgb(0, 0, 0)');
    assert.match(focus.shadow, /rgb\(255, 212, 61\)/);
  });

  const dark = await browser.newContext({ colorScheme: 'dark', storageState: storage });
  const darkPage = await dark.newPage();
  await darkPage.goto(`${base}/unread`);
  const darkBody = await styleOf(darkPage, 'body');
  check('dark: body background is DADS Solid Gray 900', () => assert.equal(darkBody.background, 'rgb(26, 26, 26)'));
  check('dark: body text is DADS Solid Gray 50', () => assert.equal(darkBody.color, 'rgb(242, 242, 242)'));

  const mobile = await browser.newContext({ viewport: { width: 360, height: 740 }, storageState: storage });
  const mobilePage = await mobile.newPage();
  for (const path of ['/unread', '/feeds', '/settings']) {
    await mobilePage.goto(`${base}${path}`);
    const overflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`mobile 360px: no horizontal overflow on ${path}`, () => assert.ok(overflow <= 0, `${overflow}px`));
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall browser checks passed');

// テーマの色の組み合わせが WCAG 2.2 AA のコントラスト比を満たすか検証する。
//   node --test "themes/**/*.test.js"
// 検証するのは下の PAIRS に挙げた色の組み合わせのみ（テーマ全体の WCAG 適合を保証するものではない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../miniflux.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function declarations(block) {
  const vars = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

function rootBlocks(source) {
  return [...source.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1]);
}

const darkMedia = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}\s*\}/.exec(css);
const lightRoots = rootBlocks(css.replace(darkMedia?.[0] ?? '', ''));
const lightVars = declarations(lightRoots.join('\n'));
const darkOverrides = declarations(darkMedia?.[1] ?? '');
const darkVars = { ...lightVars, ...darkOverrides };

function resolve(vars, name, depth = 0) {
  assert.ok(depth < 10, `circular var: ${name}`);
  const value = vars[name];
  assert.ok(value !== undefined, `undefined variable ${name}`);
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  if (ref) return resolve(vars, ref[1], depth + 1);
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  assert.ok(hex, `${name} must be a 6-digit hex color or var(): ${value}`);
  return hex[1].toLowerCase();
}

function luminance(hex) {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

// 文字色を置く主な背景（本文・パネル・未読行・エラー行）
const SURFACES = [
  '--body-background',
  '--panel-background',
  '--feed-has-unread-background-color',
  '--category-has-unread-background-color',
  '--feed-parsing-error-background-color',
];
const TEXT_ON_SURFACES = [
  '--body-color', '--title-color', '--link-color', '--link-hover-color', '--link-visited-color',
  '--item-status-read-title-link-color', '--item-meta-li-color', '--item-meta-focus-color',
  '--entry-header-title-link-color', '--counter-color',
];

// [前景, 背景, 必要なコントラスト比]（文字は 4.5、UI 部品の境界・フォーカス表示は 3）
const PAIRS = [
  ...TEXT_ON_SURFACES.flatMap((fg) => SURFACES.map((bg) => [fg, bg, 4.5])),
  ['--header-link-color', '--body-background', 4.5],
  ['--header-active-link-color', '--body-background', 4.5],
  ['--page-header-title-color', '--body-background', 4.5],
  ['--table-th-color', '--table-th-background', 4.5],
  ['--table-tr-hover-color', '--table-tr-hover-background-color', 4.5],
  ['--link-color', '--table-tr-hover-background-color', 4.5],
  ['--button-primary-color', '--button-primary-background', 4.5],
  ['--button-primary-color', '--button-primary-focus-background', 4.5],
  ['--input-color', '--input-background', 4.5],
  ['--input-placeholder-color', '--input-background', 4.5],
  ['--alert-color', '--alert-background-color', 4.5],
  ['--alert-success-color', '--alert-success-background-color', 4.5],
  ['--alert-error-color', '--alert-error-background-color', 4.5],
  ['--alert-info-color', '--alert-info-background-color', 4.5],
  ['--panel-color', '--panel-background', 4.5],
  ['--pagination-link-color', '--body-background', 4.5],
  ['--category-color', '--category-background-color', 4.5],
  ['--category-link-color', '--category-background-color', 4.5],
  ['--entry-content-color', '--body-background', 4.5],
  ['--entry-content-quote-color', '--body-background', 4.5],
  ['--entry-content-code-color', '--entry-content-code-background', 4.5],
  ['--parsing-error-color', '--feed-parsing-error-background-color', 4.5],
  ['--keyboard-shortcuts-li-color', '--body-background', 4.5],
  // 非テキスト（1.4.11）: 入力欄の枠、選択中の記事の枠
  ['--ftr-input-border-color', '--input-background', 3],
  ['--ftr-input-border-color', '--body-background', 3],
  ['--current-item-border-color', '--body-background', 3],
  ['--input-focus-border-color', '--input-background', 3],
  // フォーカス表示（2.4.7 / 2.4.13）: 外側の枠（要素から 2px 外）は周囲の背景と、
  // 内側のリング（要素に接する）は枠および要素自体（主要ボタン）と区別できること
  ...SURFACES.map((bg) => ['--ftr-focus-outline', bg, 3]),
  ['--ftr-focus-ring', '--ftr-focus-outline', 3],
  ['--ftr-focus-ring', '--button-primary-background', 3],
];

for (const [mode, vars] of [['light', lightVars], ['dark', darkVars]]) {
  for (const [fg, bg, min] of PAIRS) {
    test(`${mode}: ${fg} on ${bg} >= ${min}:1`, () => {
      const [f, b] = [resolve(vars, fg), resolve(vars, bg)];
      const ratio = contrast(f, b);
      assert.ok(ratio >= min, `${ratio.toFixed(2)}:1 (#${f} on #${b})`);
    });
  }
}

// ---- 解析そのものが壊れていないことの確認（壊れているとテストが素通りするため） ----

test('ライトの :root は 1 つだけで、ダークの上書きブロックが解析できている', () => {
  assert.equal(lightRoots.length, 1);
  assert.ok(darkMedia, 'dark mode block not found');
  assert.ok(Object.keys(darkOverrides).length >= 50, `dark overrides: ${Object.keys(darkOverrides).length}`);
  assert.notEqual(resolve(lightVars, '--body-background'), resolve(darkVars, '--body-background'));
});

test('CSS 内で参照しているすべての var() が定義されている', () => {
  const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  const undefinedVars = [...used].filter((name) => !(name in lightVars));
  assert.deepEqual(undefinedVars, []);
});

test('フォーカス表示と動きを減らす設定のルールがある', () => {
  assert.match(css, /:focus-visible[\s\S]*?outline:\s*2px solid var\(--ftr-focus-outline\)/);
  assert.match(css, /box-shadow:\s*0 0 0 4px var\(--ftr-focus-ring\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

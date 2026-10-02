// テーマの色の組み合わせが WCAG 2.2 AA のコントラスト比を満たすか検証する。
//   node --test themes/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../miniflux.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function declarations(block) {
  const vars = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

function rootBlock(source) {
  const m = /:root\s*\{([^}]*)\}/.exec(source);
  assert.ok(m, ':root block not found');
  return m[1];
}

const darkMedia = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*?\})\s*\}/.exec(css);
assert.ok(darkMedia, 'dark mode block not found');
const lightVars = declarations(rootBlock(css.replace(darkMedia[0], '')));
const darkVars = { ...lightVars, ...declarations(rootBlock(darkMedia[1])) };

function resolve(vars, name, depth = 0) {
  assert.ok(depth < 10, `circular var: ${name}`);
  const value = vars[name];
  assert.ok(value !== undefined, `undefined variable ${name}`);
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  if (ref) return resolve(vars, ref[1], depth + 1);
  const hex = /#([0-9a-f]{6})\b/i.exec(value);
  assert.ok(hex, `${name} is not a hex color: ${value}`);
  return hex[1];
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

// [前景, 背景, 必要なコントラスト比]（文字は 4.5、UI 部品の境界・フォーカス表示は 3）
const PAIRS = [
  ['--body-color', '--body-background', 4.5],
  ['--title-color', '--body-background', 4.5],
  ['--link-color', '--body-background', 4.5],
  ['--link-hover-color', '--body-background', 4.5],
  ['--link-visited-color', '--body-background', 4.5],
  ['--header-link-color', '--body-background', 4.5],
  ['--header-active-link-color', '--body-background', 4.5],
  ['--page-header-title-color', '--body-background', 4.5],
  ['--table-th-color', '--table-th-background', 4.5],
  ['--table-tr-hover-color', '--table-tr-hover-background-color', 4.5],
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
  ['--item-status-read-title-link-color', '--body-background', 4.5],
  ['--item-meta-li-color', '--body-background', 4.5],
  ['--entry-header-title-link-color', '--body-background', 4.5],
  ['--entry-content-color', '--body-background', 4.5],
  ['--entry-content-quote-color', '--body-background', 4.5],
  ['--entry-content-code-color', '--entry-content-code-background', 4.5],
  ['--parsing-error-color', '--feed-parsing-error-background-color', 4.5],
  ['--counter-color', '--body-background', 4.5],
  ['--keyboard-shortcuts-li-color', '--body-background', 4.5],
  ['--current-item-border-color', '--body-background', 3],
  ['--input-focus-border-color', '--input-background', 3],
  ['--ftr-focus-outline', '--body-background', 3],
];

for (const [mode, vars] of [['light', lightVars], ['dark', darkVars]]) {
  for (const [fg, bg, min] of PAIRS) {
    test(`${mode}: ${fg} on ${bg} >= ${min}:1`, () => {
      const ratio = contrast(resolve(vars, fg), resolve(vars, bg));
      assert.ok(ratio >= min, `${ratio.toFixed(2)}:1 (#${resolve(vars, fg)} on #${resolve(vars, bg)})`);
    });
  }
}

test('フォーカスリング（黄）は枠（黒/白）と区別できる', () => {
  for (const vars of [lightVars, darkVars]) {
    assert.ok(contrast(resolve(vars, '--ftr-focus-ring'), resolve(vars, '--ftr-focus-outline')) >= 3);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCreatedAt } from '../src/date.js';

test('IFTTT 形式の CreatedAt をタイムゾーン付きで解釈する', () => {
  const d = parseCreatedAt('October 02, 2026 at 10:15PM', '+09:00');
  assert.equal(d.toISOString(), '2026-10-02T13:15:00.000Z');
});

test('12AM / 12PM を正しく扱う', () => {
  assert.equal(parseCreatedAt('January 05, 2026 at 12:00AM', '+00:00').toISOString(), '2026-01-05T00:00:00.000Z');
  assert.equal(parseCreatedAt('January 05, 2026 at 12:30PM', '+00:00').toISOString(), '2026-01-05T12:30:00.000Z');
});

test('ISO 8601 はそのまま解釈する', () => {
  assert.equal(parseCreatedAt('2026-10-02T01:02:03Z').toISOString(), '2026-10-02T01:02:03.000Z');
});

test('解釈できない値は null', () => {
  assert.equal(parseCreatedAt(''), null);
  assert.equal(parseCreatedAt('yesterday'), null);
  assert.equal(parseCreatedAt(undefined), null);
});

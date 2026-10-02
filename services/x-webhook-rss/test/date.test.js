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

test('ISO 8601 のオフセット付きも解釈する', () => {
  assert.equal(parseCreatedAt('2026-10-02T09:00:00+09:00').toISOString(), '2026-10-02T00:00:00.000Z');
});

test('存在しない日付・時刻は null', () => {
  assert.equal(parseCreatedAt('February 31, 2026 at 10:00AM', '+09:00'), null);
  assert.equal(parseCreatedAt('January 05, 2026 at 13:00PM', '+09:00'), null);
  assert.equal(parseCreatedAt('January 05, 2026 at 00:30AM', '+09:00'), null);
  assert.equal(parseCreatedAt('Smarch 05, 2026 at 10:00AM', '+09:00'), null);
});

test('マイナスのタイムゾーン（UTC で翌日になるケース）', () => {
  assert.equal(parseCreatedAt('December 31, 2026 at 11:30PM', '-05:00').toISOString(), '2027-01-01T04:30:00.000Z');
});

test('日付が UTC で前日になるケースも正しく判定する', () => {
  assert.equal(parseCreatedAt('March 01, 2026 at 02:00AM', '+09:00').toISOString(), '2026-02-28T17:00:00.000Z');
});

test('解釈できない値は null', () => {
  assert.equal(parseCreatedAt(''), null);
  assert.equal(parseCreatedAt('yesterday'), null);
  assert.equal(parseCreatedAt(undefined), null);
});

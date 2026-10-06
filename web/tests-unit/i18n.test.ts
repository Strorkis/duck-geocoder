// 画面の言語 (src/i18n) の単体テスト。地図も DuckDB も要らないので、E2E ではなくここで確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectLang, urlWithLang } from '../src/i18n/index.ts';
import { HTML_EN, MESSAGES } from '../src/i18n/messages.ts';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const htmlKeys = new Set(
  [...html.matchAll(/data-i18n(?:-html|-title|-placeholder|-aria-label)?="([^"]+)"/g)].map((match) => match[1]),
);

test('index.html の data-i18n のキーは、どれも英語の辞書にある', () => {
  const missing = [...htmlKeys].filter((key) => !(key in HTML_EN));
  assert.deepEqual(missing, []);
});

test('英語の辞書に、index.html で使っていないキーが無い', () => {
  const unused = Object.keys(HTML_EN).filter((key) => !htmlKeys.has(key));
  assert.deepEqual(unused, []);
});

test('日本語と英語の辞書は同じキーを持つ (型と同じことを、実行時にも確かめる)', () => {
  assert.deepEqual(Object.keys(MESSAGES.en).sort(), Object.keys(MESSAGES.ja).sort());
});

test('表の形の文言 (コード → 呼び名) は、日英で同じコードを持つ', () => {
  for (const [key, value] of Object.entries(MESSAGES.ja)) {
    if (typeof value !== 'object' || Array.isArray(value)) continue;
    const en = (MESSAGES.en as Record<string, unknown>)[key] as Record<string, string>;
    assert.deepEqual(Object.keys(en).sort(), Object.keys(value).sort(), key);
  }
});

test('言語は URL の lang が先、無ければブラウザの言語 (日本語でなければ英語)', () => {
  assert.equal(detectLang('?lang=en', ['ja-JP']), 'en');
  assert.equal(detectLang('?lang=ja', ['en-US']), 'ja');
  assert.equal(detectLang('', ['ja-JP', 'en']), 'ja');
  assert.equal(detectLang('', ['ja']), 'ja');
  assert.equal(detectLang('', ['en-US', 'ja']), 'en');
  assert.equal(detectLang('', []), 'en');
  // 知らない言語は無視してブラウザの言語に戻る。
  assert.equal(detectLang('?lang=fr', ['ja-JP']), 'ja');
});

test('言語の切り替えは lang だけを差し替え、ほかの URL はそのまま', () => {
  assert.equal(
    urlWithLang('https://example.com/duck-geocoder/?lang=ja#map', 'en'),
    'https://example.com/duck-geocoder/?lang=en#map',
  );
  assert.equal(urlWithLang('https://example.com/duck-geocoder/', 'en'), 'https://example.com/duck-geocoder/?lang=en');
});

// Regression coverage for the document language used by the main window.
//
// Chromium derives CJK font fallback from <html lang>. The shell used to ship
// lang="en", so Linux (locale=en_US) picked a Latin-metric font for 「。」 and
// 「、」 and drew them tiny and raised. The UI switch is still 'zh' | 'en', but
// every DOM language must be a full BCP 47 tag, and the language must come
// from the same in-app setting the rest of the app uses.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  uiLanguageToDocumentLang,
  detectContentLanguage,
  bootDocumentLanguage,
  readStoredUiLanguage,
  storeUiLanguage,
  applyDocumentLanguage
} from '../src/lib/uiLanguage.js'
import { buildDocumentPrintHtml } from '../src/lib/documentPrint.js'

const fakeStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value))
  }
}

test('the UI language maps to a full BCP 47 document tag', () => {
  assert.equal(uiLanguageToDocumentLang('zh'), 'zh-CN', 'a bare zh is not enough for font matching')
  assert.equal(uiLanguageToDocumentLang('zh-CN'), 'zh-CN')
  assert.equal(uiLanguageToDocumentLang('zh-Hans'), 'zh-CN')
  assert.equal(uiLanguageToDocumentLang('zh-TW'), 'zh-TW')
  assert.equal(uiLanguageToDocumentLang('zh-Hant'), 'zh-TW')
  assert.equal(uiLanguageToDocumentLang('zh-HK'), 'zh-TW')
  assert.equal(uiLanguageToDocumentLang('en'), 'en')
  assert.equal(uiLanguageToDocumentLang('en-US'), 'en')
  assert.equal(uiLanguageToDocumentLang('fr-FR'), 'fr-FR', 'other languages keep their full tag')
  assert.equal(uiLanguageToDocumentLang(''), 'zh-CN')
  assert.equal(uiLanguageToDocumentLang('not a tag!'), 'zh-CN')
})

test('content in a Chinese note is tagged Chinese even when the UI is English', () => {
  assert.equal(detectContentLanguage('测试。测试、测试', 'en'), 'zh-CN')
  assert.equal(detectContentLanguage('# 项目说明\n\n这是一篇中文笔记。', 'en'), 'zh-CN')
  assert.equal(detectContentLanguage('測試。測試、測試', 'en'), 'zh-TW')
  assert.equal(detectContentLanguage('# 專案說明\n\n這是一篇繁體中文筆記。', 'en'), 'zh-TW')
})

test('a Chinese note that quotes a little Japanese or Korean keeps its Chinese glyphs', () => {
  // the tag picks the font for every Han character of the note: one kana or
  // Hangul word must not hand the whole note to a Japanese/Korean face
  assert.equal(detectContentLanguage('这本书的作者是列夫・托尔斯泰，我很喜欢他写的小说和散文。', 'zh'), 'zh-CN')
  assert.equal(detectContentLanguage('今天的晚饭の照片，味道还不错，下次还来这家店。', 'zh'), 'zh-CN')
  assert.equal(detectContentLanguage('我们公司新开了一家咖啡店，名字叫做 コーヒー 小站，环境很好。', 'zh'), 'zh-CN')
  assert.equal(detectContentLanguage('韩国泡菜叫 김치，是一种很常见的发酵食品，做法也不难学。', 'en'), 'zh-CN')
  assert.equal(detectContentLanguage('這本書的作者是列夫・托爾斯泰，我很喜歡他寫的小說。', 'en'), 'zh-TW')
})

test('Japanese and Korean notes are still tagged as such', () => {
  assert.equal(detectContentLanguage('これは日本語のメモです。今日はいい天気ですね。', 'zh'), 'ja')
  // kanji-heavy Japanese still has a real share of kana
  assert.equal(detectContentLanguage('東京都内の気象情報を確認します。', 'zh'), 'ja')
  assert.equal(detectContentLanguage('이것은 한국어 메모입니다. 오늘 날씨가 좋네요.', 'zh'), 'ko')
})

test('English content in a Chinese UI is tagged English', () => {
  assert.equal(detectContentLanguage('Hello world. This is an English note.', 'zh'), 'en')
  assert.equal(detectContentLanguage('A paragraph with only 中文 in it.', 'zh'), 'en')
})

test('empty or language-neutral content follows the UI language', () => {
  assert.equal(detectContentLanguage('', 'zh'), 'zh-CN')
  assert.equal(detectContentLanguage('123 456 +-*/', 'en'), 'en')
  assert.equal(detectContentLanguage('123 456', 'zh-TW'), 'zh-TW')
})

test('boot language prefers the stored UI setting, then the browser, then zh-CN', () => {
  assert.equal(bootDocumentLanguage({ storage: fakeStorage({ 'knote-ui-lang-v1': 'en' }), navLanguage: 'zh-TW' }), 'en')
  assert.equal(bootDocumentLanguage({ storage: fakeStorage({ 'knote-ui-lang-v1': 'zh' }), navLanguage: 'en-US' }), 'zh-CN')
  assert.equal(bootDocumentLanguage({ storage: fakeStorage(), navLanguage: 'zh-TW' }), 'zh-TW')
  assert.equal(bootDocumentLanguage({ storage: fakeStorage(), navLanguage: 'en-US' }), 'en')
  assert.equal(bootDocumentLanguage({ storage: fakeStorage(), navLanguage: '' }), 'zh-CN')
})

test('the persisted UI language only accepts the values the app actually supports', () => {
  const storage = fakeStorage({ 'knote-ui-lang-v1': 'en' })
  assert.equal(readStoredUiLanguage(storage), 'en')
  storeUiLanguage('zh', storage)
  assert.equal(readStoredUiLanguage(storage), 'zh')
  storage.setItem('knote-ui-lang-v1', 'zh-TW')
  assert.equal(readStoredUiLanguage(storage), '', 'unsupported values fall back to the default UI')
  storage.setItem('knote-ui-lang-v1', 'bogus')
  assert.equal(readStoredUiLanguage(storage), '')
})

test('applyDocumentLanguage writes the mapped tag onto the document element', () => {
  const documentElement = { lang: 'en' }
  applyDocumentLanguage('zh', { documentElement })
  assert.equal(documentElement.lang, 'zh-CN')
  applyDocumentLanguage('en', { documentElement })
  assert.equal(documentElement.lang, 'en')
})

test('the static shell never ships the old lang="en" default', async () => {
  const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8')
  const shell = await read('index.html')
  assert.match(shell, /<html lang="zh-CN"/, 'index.html must start from the Simplified Chinese default')
  assert.doesNotMatch(shell, /<html lang="en"/)
  const print = await read('print.html')
  assert.match(print, /<html lang="zh-CN"/, 'the print window default must be a full BCP 47 tag too')
})

test('the export/print template normalizes its lang argument to BCP 47', () => {
  const base = { bodyHtml: '<p>测试。测试、测试</p>', title: 'Knote' }
  assert.match(buildDocumentPrintHtml({ ...base, lang: 'zh' }), /<html lang="zh-CN"/)
  assert.match(buildDocumentPrintHtml({ ...base, lang: 'zh-TW' }), /<html lang="zh-TW"/)
  assert.match(buildDocumentPrintHtml({ ...base, lang: 'en' }), /<html lang="en"/)
  assert.match(buildDocumentPrintHtml(base), /<html lang="zh-CN"/, 'the default argument still means Simplified Chinese')
})

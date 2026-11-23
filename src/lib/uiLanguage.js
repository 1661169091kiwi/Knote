// Document language policy shared by the shell, the editor and the export
// paths.
//
// Chromium chooses the CJK font fallback from the *document* language, not
// from the process locale or --lang. A shell that declares lang="en" makes it
// lay out 「。」 and 「、」 with Western metrics on Linux (small and raised),
// and a bare lang="zh" can miss the Simplified Chinese face in some font
// matchers. Everything written to the DOM therefore uses a full BCP 47 tag.
//
// The in-app switch itself stays 'zh' | 'en' (all translation lookups compare
// those two values); this module only widens the value at the DOM boundary.

export const DEFAULT_UI_LANG = 'zh'
export const DEFAULT_DOCUMENT_LANG = 'zh-CN'
export const UI_LANG_STORAGE_KEY = 'knote-ui-lang-v1'

// The app only ships these two UI translations today. Anything else in storage
// is ignored so a stale/corrupt value cannot leave the UI without strings.
const SUPPORTED_UI_LANGS = new Set(['zh', 'en'])

const normalizeTag = (value) => String(value ?? '').trim().replace(/_/g, '-')
const isWellFormedTag = (tag) => /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(tag)
const isTraditionalChineseTag = (tag) => /^(?:zh-(?:tw|hk|mo)|zh-hant)(?:-|$)/i.test(tag)
const isSimplifiedChineseTag = (tag) => /^(?:zh|zh-(?:cn|sg|my)|zh-hans)(?:-|$)/i.test(tag)

// UI language -> the tag the DOM must carry. Simplified and Traditional
// Chinese are distinct values: zh/zh-Hans -> zh-CN, zh-Hant/zh-TW/HK/MO ->
// zh-TW. English stays "en" (the plain tag; en-US is not equivalent for CJK
// fallback). Unknown well-formed tags pass through, malformed values fall back
// to the app default.
export const uiLanguageToDocumentLang = (value) => {
  const tag = normalizeTag(value)
  if (!tag) return DEFAULT_DOCUMENT_LANG
  if (isTraditionalChineseTag(tag)) return 'zh-TW'
  if (isSimplifiedChineseTag(tag)) return 'zh-CN'
  if (/^en(?:-|$)/i.test(tag)) return 'en'
  return isWellFormedTag(tag) ? tag : DEFAULT_DOCUMENT_LANG
}

export const readStoredUiLanguage = (storage = globalThis.localStorage) => {
  try {
    const value = storage?.getItem?.(UI_LANG_STORAGE_KEY)
    return SUPPORTED_UI_LANGS.has(value) ? value : ''
  } catch {
    return ''
  }
}

export const storeUiLanguage = (value, storage = globalThis.localStorage) => {
  const lang = SUPPORTED_UI_LANGS.has(value) ? value : ''
  try {
    if (lang) storage?.setItem?.(UI_LANG_STORAGE_KEY, lang)
  } catch {
    /* storage may be unavailable (private mode / file:// restrictions) */
  }
  return lang
}

// Boot-time value for the main window, before Vue has mounted. Priority:
// in-app language setting > navigator.language > Simplified Chinese. App.vue
// re-applies the live UI language immediately after mount, so this only has to
// keep the pre-mount document (an empty #app) honest.
export const bootDocumentLanguage = ({
  storage = globalThis.localStorage,
  navLanguage = globalThis.navigator?.language
} = {}) => {
  const stored = readStoredUiLanguage(storage)
  if (stored) return uiLanguageToDocumentLang(stored)
  const navigatorTag = normalizeTag(navLanguage)
  if (navigatorTag) return uiLanguageToDocumentLang(navigatorTag)
  return DEFAULT_DOCUMENT_LANG
}

export const applyDocumentLanguage = (value, doc = globalThis.document) => {
  const lang = uiLanguageToDocumentLang(value)
  if (doc?.documentElement) doc.documentElement.lang = lang
  return lang
}

// Character-level Simplified/Traditional detection. The pairs are
// unambiguous forms; shared characters (系, 里, ...) are deliberately absent.
const SCRIPT_PAIRS = [
  ['这', '這'], ['来', '來'], ['个', '個'], ['们', '們'], ['说', '說'], ['对', '對'],
  ['时', '時'], ['会', '會'], ['为', '為'], ['与', '與'], ['学', '學'], ['国', '國'],
  ['开', '開'], ['关', '關'], ['点', '點'], ['么', '麼'], ['样', '樣'], ['发', '發'],
  ['后', '後'], ['进', '進'], ['还', '還'], ['让', '讓'], ['觉', '覺'], ['过', '過'],
  ['从', '從'], ['当', '當'], ['现', '現'], ['实', '實'], ['体', '體'], ['处', '處'],
  ['务', '務'], ['东', '東'], ['车', '車'], ['长', '長'], ['门', '門'], ['问', '問'],
  ['间', '間'], ['无', '無'], ['万', '萬'], ['专', '專'], ['业', '業'], ['义', '義'],
  ['欢', '歡'], ['乐', '樂'], ['岁', '歲'], ['龙', '龍'], ['马', '馬'], ['鸟', '鳥'],
  ['鱼', '魚'], ['书', '書'], ['见', '見'], ['贝', '貝'], ['页', '頁'], ['风', '風'],
  ['飞', '飛'], ['气', '氣'], ['电', '電'], ['话', '話'], ['语', '語'], ['读', '讀'],
  ['写', '寫'], ['听', '聽'], ['认', '認'], ['识', '識'], ['记', '記'], ['忆', '憶'],
  ['机', '機'], ['构', '構'], ['权', '權'], ['极', '極'], ['标', '標'], ['准', '準'],
  ['计', '計'], ['划', '劃'], ['论', '論'], ['证', '證'], ['试', '試'], ['验', '驗'],
  ['类', '類'], ['别', '別'], ['单', '單'], ['双', '雙'], ['数', '數'], ['据', '據'],
  ['网', '網'], ['络', '絡'], ['线', '線'], ['级', '級'], ['层', '層'], ['图', '圖'],
  ['档', '檔'], ['户', '戶'], ['统', '統'], ['项', '項'], ['笔', '筆'], ['测', '測'],
  ['简', '簡'], ['历', '歷'], ['钟', '鐘'], ['块', '塊'], ['边', '邊'], ['备', '備'],
  ['报', '報'], ['传', '傳'], ['输', '輸']
]
const TRADITIONAL_SET = new Set(SCRIPT_PAIRS.map(([, traditional]) => traditional))
const SIMPLIFIED_SET = new Set(SCRIPT_PAIRS.map(([simplified]) => simplified))

const isHanCodePoint = (code) =>
  (code >= 0x3400 && code <= 0x4dbf) ||
  (code >= 0x4e00 && code <= 0x9fff) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0x20000 && code <= 0x2fa1f)

// The document body's own language, tagged on the content containers so an
// English UI with a Chinese note (or the reverse) keeps correct glyph metrics.
// A meaningful amount of Han wins over the UI language; Kana/Hangul are
// reported explicitly; otherwise Latin content is English and language-neutral
// content follows the UI.
export const detectContentLanguage = (text, uiLang = DEFAULT_UI_LANG) => {
  const sample = String(text ?? '').slice(0, 4000)
  let han = 0
  let latin = 0
  let traditional = 0
  let simplified = 0
  for (const ch of sample) {
    const code = ch.codePointAt(0)
    if (isHanCodePoint(code)) {
      han++
      if (TRADITIONAL_SET.has(ch)) traditional++
      else if (SIMPLIFIED_SET.has(ch)) simplified++
    } else if (code >= 0x3040 && code <= 0x30ff) {
      return 'ja'
    } else if (code >= 0xac00 && code <= 0xd7af) {
      return 'ko'
    } else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      latin++
    }
  }
  if (han >= 20 || (han > 0 && han * 2 >= latin)) return traditional > simplified ? 'zh-TW' : 'zh-CN'
  if (latin > 0) return 'en'
  return uiLanguageToDocumentLang(uiLang)
}

// Build-time fix for one DaisyUI rule.
//
// DaisyUI hides the focus ring of a dropdown's content with
//   .dropdown > :not(:has( ~ [class*="dropdown-content"])):focus
// A [class*=] match inside a sibling :has() cannot be invalidated selectively
// in Chromium, so ANY class change on ANY element restyled the whole document
// (~90ms with a 160-message Agent chat; scrolling, streaming and editing all
// paid it). Rewritten to the same elements without :has(): the dropdown
// content and whatever follows it. Matches the raw, minified and JS-string
// (dev server) forms of the rule.
const DAISY_DROPDOWN_FOCUS = /:not\(:has\(\s*~\s*\[class\*=\\?["']?dropdown-content\\?["']?\]\)\)/g
const DROPDOWN_FOCUS_TARGETS = ':is(.dropdown-content, .dropdown-content ~ *)'

export const rewriteDaisyDropdownFocus = (css) => String(css).replace(DAISY_DROPDOWN_FOCUS, DROPDOWN_FOCUS_TARGETS)

export const daisyDropdownFocus = () => ({
  name: 'knote:daisy-dropdown-focus',
  enforce: 'post',
  transform(code, id) {
    if (!/\.css(?:$|\?)/.test(id) || !code.includes('dropdown-content')) return null
    const next = rewriteDaisyDropdownFocus(code)
    return next === code ? null : { code: next, map: null }
  },
  generateBundle(_options, bundle) {
    for (const file of Object.values(bundle)) {
      if (file.type === 'asset' && file.fileName.endsWith('.css') && typeof file.source === 'string') {
        file.source = rewriteDaisyDropdownFocus(file.source)
      }
    }
  }
})

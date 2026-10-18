export const CURSOR_PREFERENCE_KEY = 'knote-custom-cursors-v1'

export function readCustomCursors(storage) {
  try { return (storage ?? globalThis.localStorage).getItem(CURSOR_PREFERENCE_KEY) !== '0' } catch { return true }
}

export function persistCustomCursors(enabled, storage) {
  try {
    (storage ?? globalThis.localStorage).setItem(CURSOR_PREFERENCE_KEY, enabled ? '1' : '0')
    return true
  } catch { return false }
}

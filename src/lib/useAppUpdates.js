import { computed, onBeforeUnmount, onMounted, shallowRef } from 'vue'

export const useAppUpdates = () => {
  const bridge = window.knoteDesktop
  const supported = !!bridge?.getUpdateState
  const state = shallowRef({ phase: 'idle', autoCheck: true, currentVersion: '', release: null, received: 0, total: 0, error: null })
  let stop = null, disposed = false, revision = 0
  const accept = (value) => { if (!disposed && value?.phase) state.value = value }
  const run = async (action) => {
    try { accept(await action()) } catch (error) { if (!disposed) state.value = { ...state.value, phase: 'error', error: String(error.message || error) } }
  }
  const activate = () => {
    if (!supported || ['checking', 'downloading'].includes(state.value.phase)) return
    if (state.value.phase === 'downloaded') return bridge.revealDownloadedUpdate()
    return run(() => state.value.release ? bridge.downloadUpdate() : bridge.checkForUpdates())
  }
  const toggleAutoCheck = () => supported && run(() => bridge.setAutoUpdateCheck(!state.value.autoCheck))
  const refresh = () => {
    if (!supported || ['checking', 'downloading'].includes(state.value.phase)) return
    return run(() => bridge.checkForUpdates())
  }
  onMounted(async () => {
    if (!supported) return
    stop = bridge.onUpdateState((value) => { revision++; accept(value) })
    const before = revision
    try { const value = await bridge.getUpdateState(); if (before === revision) accept(value) } catch { /* startup failures stay silent */ }
  })
  onBeforeUnmount(() => { disposed = true; stop?.() })
  return { supported, state, activate, refresh, toggleAutoCheck, available: computed(() => !!state.value.release) }
}

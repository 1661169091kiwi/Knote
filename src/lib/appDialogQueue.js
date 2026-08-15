const defaultOwner = (mode, id) => `${mode || 'dialog'}:${id}`

export const createAppDialogQueue = ({ onActivate = () => {} } = {}) => {
  let sequence = 0
  let active = null
  let disposed = false
  const pending = []

  const publicRequest = (request) => request
    ? {
        id: request.id,
        owner: request.owner,
        mode: request.mode,
        title: request.title,
        message: request.message,
        tone: request.tone,
        value: request.value
      }
    : null

  const publish = () => onActivate(publicRequest(active))
  const activateNext = () => {
    if (active || disposed) return
    active = pending.shift() || null
    publish()
  }
  const finish = (request, value) => {
    if (!request || request.settled) return false
    request.settled = true
    if (request.signal && request.onAbort) request.signal.removeEventListener('abort', request.onAbort)
    request.resolve(value)
    return true
  }

  const cancel = (id) => {
    if (active?.id === id) {
      const request = active
      active = null
      finish(request, null)
      activateNext()
      return true
    }
    const index = pending.findIndex((request) => request.id === id)
    if (index < 0) return false
    return finish(pending.splice(index, 1)[0], null)
  }

  const request = (options = {}) => {
    if (disposed) return Promise.resolve(null)
    const id = `app-dialog-${++sequence}`
    const mode = options.mode === 'confirm' || options.mode === 'alert' ? options.mode : 'prompt'
    return new Promise((resolve) => {
      const queued = {
        id,
        owner: String(options.owner || defaultOwner(mode, id)),
        mode,
        title: String(options.title || ''),
        message: String(options.message || ''),
        tone: ['success', 'partial', 'failure'].includes(options.tone) ? options.tone : '',
        value: String(options.value == null ? '' : options.value),
        signal: options.signal || null,
        onAbort: null,
        settled: false,
        resolve
      }
      if (queued.signal?.aborted) {
        finish(queued, null)
        return
      }
      if (queued.signal?.addEventListener) {
        queued.onAbort = () => cancel(id)
        queued.signal.addEventListener('abort', queued.onAbort, { once: true })
      }
      pending.push(queued)
      activateNext()
    })
  }

  const settle = (id, value) => {
    if (!active || active.id !== id) return false
    const request = active
    active = null
    finish(request, value)
    activateNext()
    return true
  }

  const cancelOwner = (owner) => {
    const wanted = String(owner || '')
    if (!wanted) return 0
    const cancelled = []
    if (active?.owner === wanted) {
      cancelled.push(active)
      active = null
    }
    for (let index = pending.length - 1; index >= 0; index--) {
      if (pending[index].owner === wanted) cancelled.push(pending.splice(index, 1)[0])
    }
    for (const queued of cancelled) finish(queued, null)
    if (!active) activateNext()
    return cancelled.length
  }

  const cancelAll = () => {
    const requests = active ? [active, ...pending] : [...pending]
    active = null
    pending.length = 0
    publish()
    for (const queued of requests) finish(queued, null)
    return requests.length
  }

  const dispose = () => {
    const cancelled = cancelAll()
    disposed = true
    return cancelled
  }

  return {
    request,
    settle,
    cancel,
    cancelOwner,
    cancelAll,
    dispose,
    current: () => publicRequest(active),
    size: () => pending.length + (active ? 1 : 0)
  }
}

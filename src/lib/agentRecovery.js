const eventOrder = (event) => Number(event?.order || (Number(event?.at) || 0) * 1000)

const TERMINAL_RUN_EVENTS = new Set(['run.completed', 'run.interrupted', 'run.recovered'])

export const latestAgentEventOrder = (events) => (Array.isArray(events) ? events : [])
  .reduce((latest, event) => Math.max(latest, eventOrder(event)), 0)

export const terminalMessageRecoveryCandidates = ({ messages, events }) => {
  const ordered = [...(Array.isArray(events) ? events : [])].sort((left, right) => (
    eventOrder(left) - eventOrder(right) || String(left?.id || '').localeCompare(String(right?.id || ''))
  ))
  const existing = new Set((messages || []).map((message) => String(message?.id || '')))
  const promptIds = new Map()
  for (const event of ordered) {
    if (event?.type !== 'run.started') continue
    const runId = String(event.payload?.runId || '')
    const promptId = String(event.payload?.promptId || '')
    if (runId && promptId) promptIds.set(runId, promptId)
  }

  const candidates = []
  for (const event of ordered) {
    if (event?.type !== 'run.completed' && event?.type !== 'run.interrupted') continue
    const runId = String(event.payload?.runId || '')
    const promptId = String(event.payload?.promptId || promptIds.get(runId) || '')
    const messageId = String(event.payload?.messageId || '')
    const text = typeof event.payload?.text === 'string' ? event.payload.text : ''
    if (!promptId || !messageId || !text || existing.has(messageId)) continue
    if (!(messages || []).some((message) => message?.role === 'user' && String(message?.id || '') === promptId)) continue
    candidates.push(event)
    existing.add(messageId)
  }
  return candidates
}

export const uncertainSteerRecoveryCandidates = ({ messages, queue, events }) => {
  const ordered = [...(Array.isArray(events) ? events : [])].sort((left, right) => (
    eventOrder(left) - eventOrder(right) || String(left?.id || '').localeCompare(String(right?.id || ''))
  ))
  const startedRuns = new Set()
  const terminalRuns = new Set()
  const settledPrompts = new Set()
  const admissions = new Map()
  for (const event of ordered) {
    const runId = String(event?.payload?.runId || '')
    const promptId = String(event?.payload?.promptId || '')
    if (event?.type === 'run.started' && runId) startedRuns.add(runId)
    if (TERMINAL_RUN_EVENTS.has(event?.type) && runId) terminalRuns.add(runId)
    if ((event?.type === 'prompt.recovered' || event?.type === 'prompt.recovery_blocked') && promptId) settledPrompts.add(promptId)
    if (event?.type === 'prompt.admitted' && promptId) admissions.set(promptId, event)
  }
  const unfinishedRuns = new Set([...startedRuns].filter((runId) => !terminalRuns.has(runId)))
  const queuedPrompts = new Set((queue || []).map((item) => String(item?.id || '')))
  const found = new Set()
  const candidates = []
  for (const event of ordered) {
    if (event?.type !== 'prompt.steered') continue
    const promptId = String(event.payload?.promptId || '')
    const runId = String(event.payload?.runId || '')
    if (!promptId || !unfinishedRuns.has(runId) || settledPrompts.has(promptId) || queuedPrompts.has(promptId) || found.has(promptId)) continue
    const message = (messages || []).find((item) => item?.role === 'user' && String(item?.id || '') === promptId)
    if (!message) continue
    candidates.push({ event, message, admission: admissions.get(promptId) || null })
    found.add(promptId)
  }
  return candidates
}

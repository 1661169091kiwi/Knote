'use strict'

const crypto = require('node:crypto')
const {
  AGENT_SANDBOX_DOCUMENT_URL,
  agentSandboxWindowOptions,
  applyAgentSandboxSessionPolicy,
  applyAgentSandboxWindowPolicy
} = require('./agent-sandbox-policy.cjs')

const TASK_STATES = Object.freeze(['queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out'])
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'timed_out'])
const ACTIVE_STATES = new Set(['queued', 'running'])
const TASK_ID_RE = /^sbx_[A-Za-z0-9_-]{43}$/
const OWNER_UNSAFE_RE = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u

const DEFAULT_LIMITS = Object.freeze({
  maxCodeBytes: 128 * 1024,
  maxInputBytes: 256 * 1024,
  maxOutputBytes: 256 * 1024,
  maxValueBytes: 128 * 1024,
  maxEmittedValues: 64,
  maxStructuredDepth: 32,
  maxStructuredNodes: 20_000,
  minTimeoutMs: 100,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 300_000,
  maxWaitMs: 30_000,
  maxSleepMs: 30_000,
  maxConcurrent: 2,
  maxQueued: 32,
  maxWaitersPerTask: 16,
  maxTasks: 128,
  terminalTtlMs: 15 * 60_000
})

const ISOLATION = Object.freeze({
  backend: 'chromium-renderer',
  os_sandbox: true,
  node: false,
  network: 'unverified',
  filesystem: 'denied',
  clipboard: 'denied',
  persistent_storage: false
})

const DISABLED_REASON = Object.freeze({
  code: 'NETWORK_ISOLATION_UNVERIFIED',
  message: 'Chromium renderer execution is disabled because no-network isolation cannot be proven.'
})

class AgentSandboxError extends Error {
  constructor (code, message) {
    super(String(message || code || 'Agent sandbox error'))
    this.name = 'AgentSandboxError'
    this.code = String(code || 'SANDBOX_ERROR')
  }
}

const sandboxError = (code, message) => new AgentSandboxError(code, message)
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

const assertExactObject = (value, allowed, required = allowed) => {
  if (!plainObject(value)) throw sandboxError('INVALID_REQUEST', 'request must be an object')
  const allowedSet = new Set(allowed)
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw sandboxError('INVALID_REQUEST', 'request contains unsupported fields')
  if (required.some((key) => !own(value, key))) throw sandboxError('INVALID_REQUEST', 'request is missing required fields')
}

const normalizeOwner = (value) => {
  assertExactObject(value, ['chatKey', 'sessionId', 'runId'])
  const limits = { chatKey: 512, sessionId: 192, runId: 192 }
  const owner = {}
  for (const key of Object.keys(limits)) {
    const field = value[key]
    if (typeof field !== 'string' || !field || field.length > limits[key] || OWNER_UNSAFE_RE.test(field)) {
      throw sandboxError('INVALID_OWNER', `owner.${key} is invalid`)
    }
    owner[key] = field
  }
  return Object.freeze(owner)
}

const ownerMatches = (left, right) => !!left && !!right &&
  left.chatKey === right.chatKey && left.sessionId === right.sessionId && left.runId === right.runId

const normalizeStructured = (value, {
  maxBytes,
  maxDepth = DEFAULT_LIMITS.maxStructuredDepth,
  maxNodes = DEFAULT_LIMITS.maxStructuredNodes,
  code = 'INVALID_STRUCTURED_VALUE'
} = {}) => {
  let nodes = 0
  const ancestors = new WeakSet()
  const visit = (current, depth) => {
    nodes += 1
    if (nodes > maxNodes) throw sandboxError(code, 'structured value exceeds the node budget')
    if (depth > maxDepth) throw sandboxError(code, 'structured value exceeds the depth budget')
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw sandboxError(code, 'structured values require finite numbers')
      return current
    }
    if (!current || typeof current !== 'object') throw sandboxError(code, 'structured value is not JSON-compatible')
    if (ancestors.has(current)) throw sandboxError(code, 'structured value is cyclic')
    ancestors.add(current)
    if (Object.getOwnPropertySymbols(current).length) throw sandboxError(code, 'structured values may not contain symbol properties')
    const descriptors = Object.getOwnPropertyDescriptors(current)
    let output
    if (Array.isArray(current)) {
      output = []
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = descriptors[String(index)]
        if (!descriptor) {
          output.push(null)
          continue
        }
        if (!own(descriptor, 'value')) throw sandboxError(code, 'structured arrays may not contain accessors')
        output.push(visit(descriptor.value, depth + 1))
      }
      const extra = Object.keys(descriptors).filter((key) => key !== 'length' && !/^(?:0|[1-9]\d*)$/.test(key))
      if (extra.length) throw sandboxError(code, 'structured arrays may not contain named properties')
    } else {
      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) throw sandboxError(code, 'structured objects must be plain objects')
      output = {}
      for (const key of Object.keys(descriptors)) {
        const descriptor = descriptors[key]
        if (!descriptor.enumerable) continue
        if (!own(descriptor, 'value')) throw sandboxError(code, 'structured objects may not contain accessors')
        Object.defineProperty(output, key, {
          value: visit(descriptor.value, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true
        })
      }
    }
    ancestors.delete(current)
    return output
  }
  const normalized = visit(value, 0)
  const json = JSON.stringify(normalized)
  const bytes = Buffer.byteLength(json, 'utf8')
  if (Number.isSafeInteger(maxBytes) && bytes > maxBytes) throw sandboxError(code, `structured value exceeds ${maxBytes} UTF-8 bytes`)
  return { value: normalized, bytes, json }
}

const cloneStructured = (value) => value == null ? value : JSON.parse(JSON.stringify(value))

const mergedLimits = (overrides = {}) => {
  const limits = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!own(limits, key) || !Number.isSafeInteger(value) || value <= 0) continue
    limits[key] = value
  }
  limits.maxConcurrent = Math.max(1, limits.maxConcurrent)
  limits.maxQueued = Math.max(1, limits.maxQueued)
  limits.maxTasks = Math.max(limits.maxQueued + limits.maxConcurrent, limits.maxTasks)
  limits.maxTimeoutMs = Math.max(limits.minTimeoutMs, limits.maxTimeoutMs)
  limits.defaultTimeoutMs = Math.min(limits.maxTimeoutMs, Math.max(limits.minTimeoutMs, limits.defaultTimeoutMs))
  limits.maxWaitMs = Math.min(30_000, limits.maxWaitMs)
  return Object.freeze(limits)
}

const executionSource = ({ code, inputJson, channelToken, limits }) => {
  const blockedNames = [
    'window', 'globalThis', 'self', 'top', 'parent', 'frames', 'opener', 'document', 'navigator', 'location', 'history', 'origin',
    'external', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'importScripts', 'Worker', 'SharedWorker',
    'ServiceWorker', 'BroadcastChannel', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'localStorage', 'sessionStorage', 'indexedDB',
    'caches', 'open', 'print', 'File', 'FileList', 'FileReader', 'FileSystemHandle', 'FileSystemFileHandle', 'FileSystemDirectoryHandle',
    'requestFileSystem', 'webkitRequestFileSystem', 'launchQueue',
    'showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker', 'chooseFileSystemEntries', 'Notification', 'WebAssembly', 'console',
    'Function', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
    'requestIdleCallback', 'cancelIdleCallback', 'Image', 'Audio', 'ShadowRealm', 'DOMParser', 'Range',
    'require', 'module', 'exports', 'process', 'Buffer', 'Deno', 'Bun', 'chrome', 'electron', 'ipcRenderer'
  ]
  return `(() => {
    'use strict';
    const nativeConsoleLog = console.log.bind(console);
    const nativeSetTimeout = setTimeout.bind(globalThis);
    const NativePromise = Promise;
    const objectFreeze = Object.freeze.bind(Object);
    const objectKeys = Object.keys.bind(Object);
    const objectGetPrototypeOf = Object.getPrototypeOf.bind(Object);
    const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors.bind(Object);
    const objectGetOwnPropertySymbols = Object.getOwnPropertySymbols.bind(Object);
    const objectDefineProperty = Object.defineProperty.bind(Object);
    const objectPrototype = Object.prototype;
    const arrayIsArray = Array.isArray.bind(Array);
    const arrayPush = Function.call.bind(Array.prototype.push);
    const hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);
    const jsonStringify = JSON.stringify.bind(JSON);
    const jsonParse = JSON.parse.bind(JSON);
    const textEncode = Function.call.bind(TextEncoder.prototype.encode, new TextEncoder());
    const numberIsFinite = Number.isFinite.bind(Number);
    const numberIsSafeInteger = Number.isSafeInteger.bind(Number);
    const NativeWeakSet = WeakSet;
    const weakSetHas = Function.call.bind(WeakSet.prototype.has);
    const weakSetAdd = Function.call.bind(WeakSet.prototype.add);
    const weakSetDelete = Function.call.bind(WeakSet.prototype.delete);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const maxOutputBytes = ${limits.maxOutputBytes};
    const maxValueBytes = ${limits.maxValueBytes};
    const maxEmittedValues = ${limits.maxEmittedValues};
    const maxDepth = ${limits.maxStructuredDepth};
    const maxNodes = ${limits.maxStructuredNodes};
    const maxSleepMs = ${limits.maxSleepMs};
    const channelPrefix = ${JSON.stringify(`__KNOTE_AGENT_SANDBOX_${channelToken}:`)};
    let outputBytes = 0;
    let emittedCount = 0;
    let latestCheckpoint = null;
    let hasCheckpoint = false;
    const emitted = [];
    let fatalCode = '';

    for (const intrinsic of [Object, Array, Number, String, Boolean, RegExp, JSON, WeakSet]) {
      try { if (intrinsic.prototype) objectFreeze(intrinsic.prototype); } catch {}
      try { objectFreeze(intrinsic); } catch {}
    }
    const disable = (target, name) => {
      try { objectDefineProperty(target, name, { value: undefined, writable: false, enumerable: false, configurable: false }); } catch {}
    };
    const root = globalThis;
    for (const name of ${JSON.stringify(blockedNames.filter((name) => !['window', 'globalThis', 'self', 'top', 'parent', 'frames', 'opener', 'document', 'navigator', 'location', 'history', 'origin'].includes(name)))}) disable(root, name);
    for (const name of ['clipboard', 'sendBeacon', 'serviceWorker', 'mediaDevices', 'geolocation', 'credentials', 'usb', 'serial', 'hid', 'bluetooth', 'locks', 'storage', 'wakeLock', 'gpu']) {
      try { disable(Navigator.prototype, name); } catch {}
      try { disable(root.navigator, name); } catch {}
    }
    for (const [prototype, names] of [
      [Document.prototype, ['createElement', 'createElementNS', 'createRange', 'write', 'writeln', 'execCommand', 'append', 'prepend', 'replaceChildren']],
      [DocumentFragment.prototype, ['append', 'prepend', 'replaceChildren']],
      [Node.prototype, ['appendChild', 'insertBefore', 'replaceChild']],
      [Element.prototype, ['append', 'prepend', 'before', 'after', 'replaceWith', 'replaceChildren', 'insertAdjacentElement', 'insertAdjacentHTML', 'innerHTML', 'outerHTML']]
    ]) {
      for (const name of names) disable(prototype, name);
    }
    disable(root, 'eval');

    const deepFreeze = (value, seen = new NativeWeakSet()) => {
      if (!value || typeof value !== 'object' || weakSetHas(seen, value)) return value;
      weakSetAdd(seen, value);
      for (const key of objectKeys(value)) deepFreeze(value[key], seen);
      return objectFreeze(value);
    };
    const normalize = (value) => {
      let nodes = 0;
      const ancestors = new NativeWeakSet();
      const visit = (current, depth) => {
        nodes += 1;
        if (nodes > maxNodes || depth > maxDepth) throw new TypeError('Structured value exceeds its safety budget');
        if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
        if (typeof current === 'number') {
          if (!numberIsFinite(current)) throw new TypeError('Structured values require finite numbers');
          return current;
        }
        if (!current || typeof current !== 'object') throw new TypeError('Value is not JSON-compatible');
        if (weakSetHas(ancestors, current)) throw new TypeError('Structured value is cyclic');
        weakSetAdd(ancestors, current);
        if (objectGetOwnPropertySymbols(current).length) throw new TypeError('Symbol properties are not supported');
        const descriptors = objectGetOwnPropertyDescriptors(current);
        let output;
        if (arrayIsArray(current)) {
          output = [];
          for (let index = 0; index < current.length; index += 1) {
            const descriptor = descriptors[String(index)];
            if (!descriptor) { arrayPush(output, null); continue; }
            if (!hasOwn(descriptor, 'value')) throw new TypeError('Accessors are not supported');
            arrayPush(output, visit(descriptor.value, depth + 1));
          }
          const extras = objectKeys(descriptors).filter((key) => key !== 'length' && !/^(?:0|[1-9]\\d*)$/.test(key));
          if (extras.length) throw new TypeError('Named array properties are not supported');
        } else {
          const prototype = objectGetPrototypeOf(current);
          if (prototype !== objectPrototype && prototype !== null) throw new TypeError('Only plain structured objects are supported');
          output = {};
          for (const key of objectKeys(descriptors)) {
            const descriptor = descriptors[key];
            if (!descriptor.enumerable) continue;
            if (!hasOwn(descriptor, 'value')) throw new TypeError('Accessors are not supported');
            objectDefineProperty(output, key, { value: visit(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true });
          }
        }
        weakSetDelete(ancestors, current);
        return output;
      };
      const structured = visit(value, 0);
      const json = jsonStringify(structured);
      const bytes = textEncode(json).byteLength;
      if (bytes > maxValueBytes) {
        fatalCode = 'OUTPUT_LIMIT';
        throw new RangeError('Structured output value exceeds its byte budget');
      }
      return { structured: deepFreeze(structured), bytes };
    };
    const publish = (type, value) => {
      if (fatalCode) throw new RangeError('Task output budget has already been exceeded');
      const normalized = normalize(value);
      if (type === 'emit' && emittedCount >= maxEmittedValues) {
        fatalCode = 'OUTPUT_LIMIT';
        throw new RangeError('Task emitted too many values');
      }
      if (outputBytes + normalized.bytes > maxOutputBytes) {
        fatalCode = 'OUTPUT_LIMIT';
        throw new RangeError('Task output exceeds its total byte budget');
      }
      outputBytes += normalized.bytes;
      if (type === 'checkpoint') {
        latestCheckpoint = normalized.structured;
        hasCheckpoint = true;
      } else {
        emittedCount += 1;
        arrayPush(emitted, normalized.structured);
      }
      nativeConsoleLog(channelPrefix + jsonStringify({ type, value: normalized.structured, bytes: normalized.bytes, totalBytes: outputBytes }));
      return normalized.structured;
    };
    const sleep = objectFreeze((milliseconds) => {
      if (!numberIsSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > maxSleepMs) {
        throw new RangeError('sleep(ms) requires an integer within the advertised limit');
      }
      return new NativePromise((resolve) => nativeSetTimeout(resolve, milliseconds));
    });
    const checkpoint = objectFreeze((value) => publish('checkpoint', value));
    const emit = objectFreeze((value) => publish('emit', value));
    const input = jsonParse(${JSON.stringify(inputJson)});
    const api = objectFreeze({ input: deepFreeze(input), sleep, checkpoint, emit });
    const blocked = ${JSON.stringify(blockedNames)};
    const blockedValues = blocked.map(() => undefined);
    const body = '"use strict"; const { input, sleep, checkpoint, emit } = api;\\n' + ${JSON.stringify(code)};
    return (async () => {
      try {
        const fn = new AsyncFunction('api', ...blocked, body);
        const returned = await fn(api, ...blockedValues);
        if (fatalCode) return { ok: false, error: { code: fatalCode, message: 'Task output exceeded its safety budget.' } };
        const result = normalize(returned === undefined ? null : returned);
        if (outputBytes + result.bytes > maxOutputBytes) return { ok: false, error: { code: 'OUTPUT_LIMIT', message: 'Task result exceeded its total output budget.' } };
        outputBytes += result.bytes;
        return { ok: true, result: result.structured, checkpoint: hasCheckpoint ? latestCheckpoint : null, hasCheckpoint, emitted, outputBytes };
      } catch (error) {
        if (fatalCode) return { ok: false, error: { code: fatalCode, message: 'Task output exceeded its safety budget.' } };
        const name = typeof error?.name === 'string' ? error.name.slice(0, 80) : 'Error';
        const message = typeof error?.message === 'string' ? error.message.slice(0, 512) : 'JavaScript execution failed';
        return { ok: false, error: { code: name === 'SyntaxError' ? 'CODE_COMPILE_ERROR' : 'EXECUTION_ERROR', name, message } };
      }
    })();
  })()`
}

class AgentSandboxService {
  constructor ({
    BrowserWindow,
    session,
    allowUnverifiedExecution = false,
    limits = {},
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    randomBytes = crypto.randomBytes,
    queueTask = queueMicrotask
  } = {}) {
    if (typeof BrowserWindow !== 'function') throw new TypeError('BrowserWindow dependency is required')
    if (!session || typeof session.fromPartition !== 'function') throw new TypeError('session.fromPartition dependency is required')
    this.BrowserWindow = BrowserWindow
    this.session = session
    this.allowUnverifiedExecution = allowUnverifiedExecution === true
    this.limits = mergedLimits(limits)
    this.now = now
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.randomBytes = randomBytes
    this.queueTask = queueTask
    this.tasks = new Map()
    this.queue = []
    this.pumpScheduled = false
    this.closed = false
  }

  capabilities () {
    const limits = this.limits
    return {
      ok: true,
      capabilities: {
        available: false,
        version: 1,
        languages: [],
        reason_code: DISABLED_REASON.code,
        reason: DISABLED_REASON.message,
        api: ['input', 'sleep(ms)', 'checkpoint(value)', 'emit(value)'],
        states: [...TASK_STATES],
        isolation: { ...ISOLATION },
        limits: {
          resource_safety: {
            code_bytes_max: limits.maxCodeBytes,
            input_bytes_max: limits.maxInputBytes,
            timeout_ms_default: limits.defaultTimeoutMs,
            timeout_ms_min: limits.minTimeoutMs,
            timeout_ms_max: limits.maxTimeoutMs,
            wait_ms_max: limits.maxWaitMs,
            sleep_ms_max: limits.maxSleepMs,
            concurrent_tasks_max: limits.maxConcurrent,
            queued_tasks_max: limits.maxQueued,
            waiters_per_task_max: limits.maxWaitersPerTask,
            retained_tasks_max: limits.maxTasks,
            terminal_retention_ms: limits.terminalTtlMs,
            structured_depth_max: limits.maxStructuredDepth,
            structured_nodes_max: limits.maxStructuredNodes
          },
          structured_output: {
            total_bytes_max: limits.maxOutputBytes,
            value_bytes_max: limits.maxValueBytes,
            emitted_values_max: limits.maxEmittedValues,
            overflow: 'task_fails_with_OUTPUT_LIMIT'
          }
        }
      }
    }
  }

  start (ownerValue, requestValue) {
    this._assertExecutionEnabled()
    if (this.closed) throw sandboxError('SANDBOX_UNAVAILABLE', 'agent sandbox service is shutting down')
    this._prune()
    const owner = normalizeOwner(ownerValue)
    assertExactObject(requestValue, ['language', 'code', 'input', 'timeoutMs'], ['language', 'code'])
    if (requestValue.language !== 'javascript') throw sandboxError('UNSUPPORTED_LANGUAGE', 'only javascript is supported')
    if (typeof requestValue.code !== 'string' || !requestValue.code.trim()) throw sandboxError('INVALID_CODE', 'code must be a nonempty string')
    const codeBytes = Buffer.byteLength(requestValue.code, 'utf8')
    if (codeBytes > this.limits.maxCodeBytes) throw sandboxError('CODE_LIMIT', `code exceeds ${this.limits.maxCodeBytes} UTF-8 bytes`)
    const timeoutMs = requestValue.timeoutMs === undefined ? this.limits.defaultTimeoutMs : requestValue.timeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < this.limits.minTimeoutMs || timeoutMs > this.limits.maxTimeoutMs) {
      throw sandboxError('INVALID_TIMEOUT', `timeoutMs must be an integer from ${this.limits.minTimeoutMs} to ${this.limits.maxTimeoutMs}`)
    }
    const input = normalizeStructured(own(requestValue, 'input') ? requestValue.input : null, {
      maxBytes: this.limits.maxInputBytes,
      maxDepth: this.limits.maxStructuredDepth,
      maxNodes: this.limits.maxStructuredNodes,
      code: 'INPUT_LIMIT'
    })
    const queued = this.queue.filter((task) => task.state === 'queued').length
    if (queued >= this.limits.maxQueued) throw sandboxError('TASK_QUEUE_FULL', 'agent sandbox task queue is full')
    if (this.tasks.size >= this.limits.maxTasks) throw sandboxError('TASK_CAPACITY', 'agent sandbox retained-task capacity is full')

    let id
    do { id = `sbx_${this.randomBytes(32).toString('base64url')}` } while (this.tasks.has(id))
    const now = this.now()
    const task = {
      id,
      owner,
      state: 'queued',
      code: requestValue.code,
      inputJson: input.json,
      codeHash: crypto.createHash('sha256').update(requestValue.code, 'utf8').digest('hex'),
      timeoutMs,
      createdAt: now,
      startedAt: 0,
      finishedAt: 0,
      version: 0,
      checkpoint: null,
      hasCheckpoint: false,
      emitted: [],
      result: null,
      error: null,
      outputBytes: 0,
      channelBytes: 0,
      channelEmits: 0,
      window: null,
      sandboxSession: null,
      partition: '',
      rendererPid: 0,
      watchdog: null,
      policyCleanup: [],
      waiters: new Set()
    }
    this.tasks.set(id, task)
    this.queue.push(task)
    this._schedulePump()
    return { ok: true, task: this._snapshot(task) }
  }

  status (ownerValue, taskId) {
    this._assertExecutionEnabled()
    const task = this._ownedTask(ownerValue, taskId)
    return { ok: true, task: this._snapshot(task) }
  }

  wait (ownerValue, taskId, waitMsValue = this.limits.maxWaitMs) {
    this._assertExecutionEnabled()
    const task = this._ownedTask(ownerValue, taskId)
    if (!Number.isSafeInteger(waitMsValue) || waitMsValue < 0 || waitMsValue > this.limits.maxWaitMs) {
      throw sandboxError('INVALID_WAIT', `waitMs must be an integer from 0 to ${this.limits.maxWaitMs}`)
    }
    if (TERMINAL_STATES.has(task.state) || waitMsValue === 0) return Promise.resolve({ ok: true, task: this._snapshot(task) })
    if (task.waiters.size >= this.limits.maxWaitersPerTask) throw sandboxError('WAIT_LIMIT', 'too many concurrent wait requests for this task')
    return new Promise((resolve) => {
      let timer = null
      const finish = () => {
        if (!task.waiters.delete(finish)) return
        if (timer) this.clearTimer(timer)
        resolve({ ok: true, task: this._snapshot(task) })
      }
      task.waiters.add(finish)
      timer = this.setTimer(finish, waitMsValue)
    })
  }

  cancel (ownerValue, taskId, code = 'CANCELLED') {
    this._assertExecutionEnabled()
    const task = this._ownedTask(ownerValue, taskId)
    if (ACTIVE_STATES.has(task.state)) {
      this._settle(task, 'cancelled', { code, message: 'Task was cancelled.' }, { forceRendererExit: true })
    }
    return { ok: true, task: this._snapshot(task) }
  }

  cancelAll (code = 'APP_QUIT') {
    for (const task of this.tasks.values()) {
      if (ACTIVE_STATES.has(task.state)) this._settle(task, 'cancelled', { code, message: 'Task was cancelled by the application.' }, { forceRendererExit: true })
    }
    return Promise.resolve()
  }

  shutdown () {
    this.closed = true
    return this.cancelAll('APP_QUIT')
  }

  _assertExecutionEnabled () {
    if (!this.allowUnverifiedExecution) {
      throw sandboxError('SANDBOX_UNAVAILABLE', DISABLED_REASON.message)
    }
  }

  _ownedTask (ownerValue, taskIdValue) {
    const owner = normalizeOwner(ownerValue)
    const taskId = String(taskIdValue || '')
    if (!TASK_ID_RE.test(taskId)) throw sandboxError('TASK_NOT_FOUND', 'sandbox task was not found for this owner')
    const task = this.tasks.get(taskId)
    if (!task || !ownerMatches(task.owner, owner)) throw sandboxError('TASK_NOT_FOUND', 'sandbox task was not found for this owner')
    return task
  }

  _snapshot (task) {
    const snapshot = {
      taskId: task.id,
      state: task.state,
      code_hash: task.codeHash,
      created_at: task.createdAt,
      started_at: task.startedAt || null,
      finished_at: task.finishedAt || null,
      timeout_ms: task.timeoutMs,
      output_bytes: task.outputBytes,
      checkpoint: task.hasCheckpoint ? cloneStructured(task.checkpoint) : null,
      emitted: cloneStructured(task.emitted),
      isolation: { ...ISOLATION }
    }
    if (task.state === 'completed') snapshot.result = cloneStructured(task.result)
    if (task.error) snapshot.error = { ...task.error }
    return snapshot
  }

  _notify (task) {
    task.version += 1
    for (const waiter of [...task.waiters]) waiter()
  }

  _schedulePump () {
    if (this.pumpScheduled || this.closed) return
    this.pumpScheduled = true
    this.queueTask(() => {
      this.pumpScheduled = false
      this._pump()
    })
  }

  _pump () {
    if (this.closed) return
    let running = [...this.tasks.values()].filter((task) => task.state === 'running').length
    while (running < this.limits.maxConcurrent) {
      const task = this.queue.shift()
      if (!task) break
      if (task.state !== 'queued') continue
      running += 1
      void this._run(task)
    }
  }

  async _run (task) {
    if (task.state !== 'queued') return
    task.state = 'running'
    task.startedAt = this.now()
    task.watchdog = this.setTimer(() => {
      if (task.state === 'running') this._settle(task, 'timed_out', { code: 'TIMED_OUT', message: 'Task exceeded its runtime safety timeout.' }, { forceRendererExit: true })
    }, task.timeoutMs)
    this._notify(task)

    try {
      task.partition = `knote-agent-sandbox-${this.randomBytes(18).toString('hex')}`
      task.sandboxSession = this.session.fromPartition(task.partition, { cache: false })
      task.policyCleanup.push(applyAgentSandboxSessionPolicy(task.sandboxSession))
      task.window = new this.BrowserWindow(agentSandboxWindowOptions(task.partition))
      task.policyCleanup.push(applyAgentSandboxWindowPolicy(task.window))
      const webContents = task.window.webContents
      const rendererGone = (_event, details = {}) => {
        if (task.state !== 'running') return
        const reason = String(details.reason || 'renderer_gone').slice(0, 80)
        this._settle(task, 'failed', { code: 'SANDBOX_RENDERER_GONE', message: `Sandbox renderer exited (${reason}).` }, { forceRendererExit: false })
      }
      const unresponsive = () => {
        if (task.state === 'running') this._settle(task, 'failed', { code: 'SANDBOX_UNRESPONSIVE', message: 'Sandbox renderer became unresponsive.' }, { forceRendererExit: true })
      }
      const consoleMessage = (_event, ...args) => this._handleConsoleMessage(task, args)
      webContents.on('render-process-gone', rendererGone)
      webContents.on('unresponsive', unresponsive)
      webContents.on('console-message', consoleMessage)
      task.policyCleanup.push(() => {
        webContents.removeListener?.('render-process-gone', rendererGone)
        webContents.removeListener?.('unresponsive', unresponsive)
        webContents.removeListener?.('console-message', consoleMessage)
      })

      await task.window.loadURL(AGENT_SANDBOX_DOCUMENT_URL)
      if (task.state !== 'running') return
      try { task.rendererPid = webContents.getOSProcessId?.() || 0 } catch { task.rendererPid = 0 }
      const channelToken = this.randomBytes(24).toString('base64url')
      task.channelPrefix = `__KNOTE_AGENT_SANDBOX_${channelToken}:`
      let source = executionSource({
        code: task.code,
        inputJson: task.inputJson,
        channelToken,
        limits: this.limits
      })
      task.code = null
      task.inputJson = null
      const execution = webContents.executeJavaScript(source, false)
      source = ''
      const envelope = await execution
      if (task.state !== 'running') return
      this._consumeEnvelope(task, envelope)
    } catch (error) {
      if (task.state !== 'running') return
      this._settle(task, 'failed', {
        code: error instanceof AgentSandboxError ? error.code : 'SANDBOX_START_FAILED',
        message: error instanceof AgentSandboxError ? error.message : 'The isolated Chromium renderer could not execute the task.'
      }, { forceRendererExit: true })
    }
  }

  _handleConsoleMessage (task, args) {
    if (task.state !== 'running' || !task.channelPrefix) return
    const first = args[0]
    const message = plainObject(first) ? first.message : args.length >= 2 ? args[1] : first
    if (typeof message !== 'string' || !message.startsWith(task.channelPrefix)) return
    const raw = message.slice(task.channelPrefix.length)
    if (Buffer.byteLength(raw, 'utf8') > this.limits.maxValueBytes * 2) {
      this._settle(task, 'failed', { code: 'OUTPUT_LIMIT', message: 'Task output exceeded its safety budget.' }, { forceRendererExit: true })
      return
    }
    try {
      const frame = JSON.parse(raw)
      assertExactObject(frame, ['type', 'value', 'bytes', 'totalBytes'])
      if (!['checkpoint', 'emit'].includes(frame.type)) throw sandboxError('SANDBOX_PROTOCOL_ERROR', 'invalid sandbox output frame')
      const normalized = normalizeStructured(frame.value, {
        maxBytes: this.limits.maxValueBytes,
        maxDepth: this.limits.maxStructuredDepth,
        maxNodes: this.limits.maxStructuredNodes,
        code: 'OUTPUT_LIMIT'
      })
      if (frame.bytes !== normalized.bytes || !Number.isSafeInteger(frame.totalBytes)) throw sandboxError('SANDBOX_PROTOCOL_ERROR', 'invalid sandbox output accounting')
      const channelBytes = task.channelBytes + normalized.bytes
      if (frame.totalBytes !== channelBytes) throw sandboxError('SANDBOX_PROTOCOL_ERROR', 'non-monotonic sandbox output accounting')
      task.channelBytes = channelBytes
      if (task.channelBytes > this.limits.maxOutputBytes) throw sandboxError('OUTPUT_LIMIT', 'task output exceeds its total byte budget')
      if (frame.type === 'checkpoint') {
        task.checkpoint = normalized.value
        task.hasCheckpoint = true
      } else {
        task.channelEmits += 1
        if (task.channelEmits > this.limits.maxEmittedValues) throw sandboxError('OUTPUT_LIMIT', 'task emitted too many values')
        task.emitted.push(normalized.value)
      }
      task.outputBytes = Math.max(task.outputBytes, task.channelBytes, frame.totalBytes)
      if (task.outputBytes > this.limits.maxOutputBytes) throw sandboxError('OUTPUT_LIMIT', 'task output exceeds its total byte budget')
      this._notify(task)
    } catch (error) {
      const code = error instanceof AgentSandboxError ? error.code : 'SANDBOX_PROTOCOL_ERROR'
      this._settle(task, 'failed', {
        code,
        message: code === 'OUTPUT_LIMIT' ? 'Task output exceeded its safety budget.' : 'Sandbox output protocol validation failed.'
      }, { forceRendererExit: true })
    }
  }

  _consumeEnvelope (task, envelope) {
    try {
      if (!plainObject(envelope) || typeof envelope.ok !== 'boolean') throw sandboxError('SANDBOX_PROTOCOL_ERROR', 'invalid execution envelope')
      if (!envelope.ok) {
        const error = plainObject(envelope.error) ? envelope.error : {}
        const code = ['OUTPUT_LIMIT', 'CODE_COMPILE_ERROR', 'EXECUTION_ERROR'].includes(error.code) ? error.code : 'EXECUTION_ERROR'
        this._settle(task, 'failed', {
          code,
          message: String(error.message || 'JavaScript execution failed.').slice(0, 512)
        }, { forceRendererExit: code === 'OUTPUT_LIMIT' })
        return
      }
      const result = normalizeStructured(envelope.result, {
        maxBytes: this.limits.maxValueBytes,
        maxDepth: this.limits.maxStructuredDepth,
        maxNodes: this.limits.maxStructuredNodes,
        code: 'OUTPUT_LIMIT'
      })
      const checkpoint = envelope.hasCheckpoint
        ? normalizeStructured(envelope.checkpoint, {
            maxBytes: this.limits.maxValueBytes,
            maxDepth: this.limits.maxStructuredDepth,
            maxNodes: this.limits.maxStructuredNodes,
            code: 'OUTPUT_LIMIT'
          })
        : null
      if (!Array.isArray(envelope.emitted) || envelope.emitted.length > this.limits.maxEmittedValues) throw sandboxError('OUTPUT_LIMIT', 'task emitted too many values')
      const emitted = envelope.emitted.map((value) => normalizeStructured(value, {
        maxBytes: this.limits.maxValueBytes,
        maxDepth: this.limits.maxStructuredDepth,
        maxNodes: this.limits.maxStructuredNodes,
        code: 'OUTPUT_LIMIT'
      }))
      const retainedBytes = result.bytes + (checkpoint?.bytes || 0) + emitted.reduce((total, item) => total + item.bytes, 0)
      if (!Number.isSafeInteger(envelope.outputBytes) || envelope.outputBytes < retainedBytes || envelope.outputBytes > this.limits.maxOutputBytes || retainedBytes > this.limits.maxOutputBytes) {
        throw sandboxError('OUTPUT_LIMIT', 'task output exceeds its total byte budget')
      }
      task.result = result.value
      task.checkpoint = checkpoint?.value || null
      task.hasCheckpoint = !!envelope.hasCheckpoint
      task.emitted = emitted.map((item) => item.value)
      task.outputBytes = Math.max(task.channelBytes, envelope.outputBytes)
      this._settle(task, 'completed', null, { forceRendererExit: false })
    } catch (error) {
      const code = error instanceof AgentSandboxError ? error.code : 'SANDBOX_PROTOCOL_ERROR'
      this._settle(task, 'failed', {
        code,
        message: code === 'OUTPUT_LIMIT' ? 'Task output exceeded its safety budget.' : 'Sandbox result protocol validation failed.'
      }, { forceRendererExit: true })
    }
  }

  _settle (task, state, error = null, { forceRendererExit = false } = {}) {
    if (!ACTIVE_STATES.has(task.state)) return false
    if (!TERMINAL_STATES.has(state)) throw new TypeError(`invalid terminal task state: ${state}`)
    task.state = state
    task.finishedAt = this.now()
    task.error = error ? { code: String(error.code || 'TASK_FAILED'), message: String(error.message || 'Task failed.').slice(0, 512) } : null
    task.code = null
    task.inputJson = null
    if (task.watchdog) {
      this.clearTimer(task.watchdog)
      task.watchdog = null
    }
    this._disposeRenderer(task, forceRendererExit)
    this._notify(task)
    this._schedulePump()
    return true
  }

  _disposeRenderer (task, forceRendererExit) {
    const window = task.window
    const sandboxSession = task.sandboxSession
    for (const cleanup of task.policyCleanup.splice(0).reverse()) {
      try { cleanup() } catch { /* renderer is already being discarded */ }
    }
    if (window) {
      if (forceRendererExit) {
        // Close from the browser process rather than deliberately crashing the
        // renderer. A crash can create a minidump containing task memory; this
        // unique-partition window has no other view, so destroy tears down the
        // whole renderer without persisting user code in crash diagnostics.
        try { window.webContents?.close?.({ waitForBeforeUnload: false }) } catch { /* destroy below is authoritative */ }
      }
      try { if (!window.isDestroyed?.()) window.destroy() } catch { /* already destroyed */ }
    }
    task.window = null
    task.sandboxSession = null
    task.partition = ''
    task.channelPrefix = ''
    try { sandboxSession?.closeAllConnections?.() } catch { /* temporary session is gone */ }
    try { void sandboxSession?.clearStorageData?.().catch?.(() => {}) } catch { /* temporary session is gone */ }
  }

  _prune () {
    const cutoff = this.now() - this.limits.terminalTtlMs
    for (const [id, task] of this.tasks) {
      if (TERMINAL_STATES.has(task.state) && task.finishedAt && task.finishedAt < cutoff) this.tasks.delete(id)
    }
    if (this.tasks.size < this.limits.maxTasks) return
    const terminal = [...this.tasks.values()]
      .filter((task) => TERMINAL_STATES.has(task.state))
      .sort((left, right) => left.finishedAt - right.finishedAt)
    while (this.tasks.size >= this.limits.maxTasks && terminal.length) this.tasks.delete(terminal.shift().id)
  }
}

const ipcFailure = (error) => ({
  ok: false,
  code: error instanceof AgentSandboxError ? error.code : 'SANDBOX_INTERNAL_ERROR',
  error: error instanceof AgentSandboxError ? error.message : 'Agent sandbox request failed.',
  isolation: { ...ISOLATION }
})

const installAgentSandboxIpc = ({ ipcMain, service, validateSender }) => {
  if (!ipcMain || typeof ipcMain.handle !== 'function') throw new TypeError('ipcMain dependency is required')
  if (!(service instanceof AgentSandboxService)) throw new TypeError('AgentSandboxService instance is required')
  const senderAllowed = typeof validateSender === 'function' ? validateSender : () => false
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (event, payload) => {
      if (!senderAllowed(event?.sender)) return ipcFailure(sandboxError('UNAUTHORIZED_SENDER', 'agent sandbox IPC sender is not authorized'))
      try { return await fn(payload) } catch (error) { return ipcFailure(error) }
    })
  }

  handle('knote:agent-sandbox-capabilities', (payload) => {
    assertExactObject(payload, [], [])
    return service.capabilities()
  })
  handle('knote:agent-sandbox-start', (payload) => {
    assertExactObject(payload, ['owner', 'request'])
    return service.start(payload.owner, payload.request)
  })
  handle('knote:agent-sandbox-status', (payload) => {
    assertExactObject(payload, ['owner', 'taskId'])
    return service.status(payload.owner, payload.taskId)
  })
  handle('knote:agent-sandbox-wait', (payload) => {
    assertExactObject(payload, ['owner', 'taskId', 'waitMs'])
    return service.wait(payload.owner, payload.taskId, payload.waitMs)
  })
  handle('knote:agent-sandbox-cancel', (payload) => {
    assertExactObject(payload, ['owner', 'taskId'])
    return service.cancel(payload.owner, payload.taskId)
  })
}

module.exports = {
  AgentSandboxError,
  AgentSandboxService,
  DEFAULT_LIMITS,
  DISABLED_REASON,
  ISOLATION,
  TASK_ID_RE,
  TASK_STATES,
  installAgentSandboxIpc,
  normalizeOwner,
  normalizeStructured
}

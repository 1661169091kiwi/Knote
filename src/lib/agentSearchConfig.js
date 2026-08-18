export const SEARCH_ENGINE_IDS = Object.freeze(['bing', 'duckduckgo', 'mojeek'])

const SEARCH_ENGINE_SET = new Set(SEARCH_ENGINE_IDS)
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

export const normalizeEnabledSearchEngines = (value) => {
  const selected = new Set(Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [])
  return SEARCH_ENGINE_IDS.filter((engine) => selected.has(engine))
}

export const migrateAgentSearchConfig = (value = {}) => {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const hasEnabledList = hasOwn(source, 'enabledSearchEngines')
  let enabledSearchEngines

  if (hasEnabledList) {
    enabledSearchEngines = normalizeEnabledSearchEngines(source.enabledSearchEngines)
  } else {
    const legacy = typeof source.searchEngine === 'string' ? source.searchEngine.trim().toLowerCase() : ''
    if (SEARCH_ENGINE_SET.has(legacy)) enabledSearchEngines = [legacy]
    else if (!legacy || legacy === 'auto') enabledSearchEngines = [...SEARCH_ENGINE_IDS]
    else enabledSearchEngines = []
  }

  const migrated = {
    ...source,
    webSearch: source.webSearch !== false && enabledSearchEngines.length > 0,
    enabledSearchEngines
  }
  delete migrated.searchEngine
  return migrated
}

export const freezeEnabledSearchEngines = (value) => Object.freeze([
  ...normalizeEnabledSearchEngines(value)
])

export const snapshotAgentSearchSettings = (config = {}) => {
  const enabledSearchEngines = freezeEnabledSearchEngines(config.enabledSearchEngines)
  return Object.freeze({
    webSearch: config.webSearch !== false && enabledSearchEngines.length > 0,
    enabledSearchEngines,
    searchRegion: typeof config.searchRegion === 'string' ? config.searchRegion : 'auto',
    jinaKey: typeof config.jinaKey === 'string' ? config.jinaKey : ''
  })
}

export const runtimeExecutableSearchEngines = ({ native = false, jina = false } = {}) => (
  native ? [...SEARCH_ENGINE_IDS] : jina ? ['duckduckgo'] : []
)

export const enabledExecutableSearchEngines = (enabled, executable) => {
  const executableSet = new Set(normalizeEnabledSearchEngines(executable))
  return normalizeEnabledSearchEngines(enabled).filter((engine) => executableSet.has(engine))
}

export const webSearchEngineEnum = (enabled, executable) => {
  const concrete = enabledExecutableSearchEngines(enabled, executable)
  return concrete.length ? [...concrete, 'all'] : []
}

export const isConcreteSearchEngine = (value) => SEARCH_ENGINE_SET.has(value)

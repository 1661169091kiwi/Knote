import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  SEARCH_ENGINE_IDS,
  migrateAgentSearchConfig,
  snapshotAgentSearchSettings,
  webSearchEngineEnum
} from '../src/lib/agentSearchConfig.js'

test('legacy scalar search settings migrate to canonical engine arrays', () => {
  assert.deepEqual(migrateAgentSearchConfig({ webSearch: true, searchEngine: 'bing' }), {
    webSearch: true,
    enabledSearchEngines: ['bing']
  })
  assert.deepEqual(migrateAgentSearchConfig({ searchEngine: 'auto' }).enabledSearchEngines, SEARCH_ENGINE_IDS)
  assert.deepEqual(migrateAgentSearchConfig({}).enabledSearchEngines, SEARCH_ENGINE_IDS)
  assert.deepEqual(migrateAgentSearchConfig({ searchEngine: 'unknown' }), {
    webSearch: false,
    enabledSearchEngines: []
  })
})

test('canonical migration removes duplicates and unknown engines without restoring an explicit empty grant', () => {
  const migrated = migrateAgentSearchConfig({
    webSearch: true,
    enabledSearchEngines: ['mojeek', 'unknown', 'bing', 'mojeek']
  })
  assert.deepEqual(migrated.enabledSearchEngines, ['bing', 'mojeek'])
  assert.equal(migrated.webSearch, true)

  const empty = migrateAgentSearchConfig({ webSearch: true, enabledSearchEngines: [] })
  assert.deepEqual(empty.enabledSearchEngines, [])
  assert.equal(empty.webSearch, false)
})

test('run search snapshots deep-clone and freeze enabled engine authorization', () => {
  const source = ['bing', 'duckduckgo']
  const snapshot = snapshotAgentSearchSettings({
    webSearch: true,
    enabledSearchEngines: source,
    searchRegion: 'en',
    jinaKey: 'secret'
  })
  source.splice(0, source.length, 'mojeek')
  assert.deepEqual(snapshot.enabledSearchEngines, ['bing', 'duckduckgo'])
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot.enabledSearchEngines), true)
  assert.throws(() => snapshot.enabledSearchEngines.push('mojeek'), TypeError)
})

test('dynamic web-search enums include only enabled executable engines plus all', () => {
  assert.deepEqual(
    webSearchEngineEnum(['bing', 'duckduckgo', 'mojeek'], ['duckduckgo']),
    ['duckduckgo', 'all']
  )
  assert.deepEqual(webSearchEngineEnum(['bing'], ['duckduckgo']), [])
  assert.deepEqual(webSearchEngineEnum(['mojeek', 'bing'], ['bing', 'mojeek']), ['bing', 'mojeek', 'all'])
})

test('store and settings use array authorization rather than the legacy scalar selector', () => {
  const store = fs.readFileSync(new URL('../src/lib/agentStore.js', import.meta.url), 'utf8')
  const panel = fs.readFileSync(new URL('../src/components/AgentPanel.vue', import.meta.url), 'utf8')
  assert.match(store, /enabledSearchEngines: \[\.\.\.SEARCH_ENGINE_IDS\]/)
  assert.match(store, /enabledSearchEngines: search\.enabledSearchEngines/)
  assert.match(store, /engine: \{ \.\.\.tool\.parameters\.properties\.engine, enum: engineEnum \}/)
  assert.doesNotMatch(store, /agentConfig\.searchEngine|provider\.searchEngine/)
  assert.match(panel, /v-for="option in searchEngineOptions"/)
  assert.match(panel, /type="checkbox"[\s\S]{0,180}:checked="enabledSearchEngineSet\.has\(option\.id\)"/)
  assert.doesNotMatch(panel, /v-model="agentConfig\.searchEngine"/)
})

test('capabilities are bound to protocol, base URL, and model identity', () => {
  const store = fs.readFileSync(new URL('../src/lib/agentStore.js', import.meta.url), 'utf8')
  assert.match(store, /providerCapabilityIdentity = \(config = agentConfig\)/)
  assert.match(store, /watch\(\(\) => providerCapabilityIdentity\(\), \(identity\) => invalidateCapabilities\(identity\), \{ flush: 'sync' \}\)/)
  assert.match(store, /storedCapabilities\.identity === identity/)
  assert.match(store, /providerCapabilityIdentity\(\) === probeIdentity/)
})

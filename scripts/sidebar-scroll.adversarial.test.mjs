import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const readRepo = (relative) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8')
const app = readRepo('src/App.vue')
const agent = readRepo('src/components/AgentPanel.vue')
const css = readRepo('src/style.css')

test('the gutter and sidebar rail share whole-sidebar wheel handling', () => {
  assert.match(app, /class="knote-sidebar-wheel-zone[^"]*"[\s\S]{0,180}@wheel="onSidebarWheel"/)
  assert.match(app, /ref="sidebarRailRef"[\s\S]{0,220}@wheel="onSidebarWheel"/)
  assert.equal((app.match(/@wheel="onSidebarWheel"/g) || []).length, 2)
  assert.match(app, /const rail = sidebarRailRef\.value/)
  assert.doesNotMatch(app, /const rail = event\.currentTarget/)
})

test('the outer rail stays visually hidden while accepting boundary handoff', () => {
  assert.match(app, /ref="sidebarRailRef"[\s\S]{0,180}overflow-y-hidden/)
  assert.match(app, /ref="sidebarRailRef"[\s\S]{0,220}@wheel=/)
})

test('a card keeps its wheel until it reaches the relevant boundary', () => {
  assert.match(app, /target\.closest\('\.knote-sidebar-card-scroll, \.knote-agent-input'\)/)
  assert.match(app, /cardScroller\.scrollTop > 1/)
  assert.match(app, /cardScroller\.scrollTop < cardMax - 1/)
  assert.match(app, /if \(canKeepScrollingCard\) return/)
})

test('outline, both file modes, and Agent each have independent scroll containment', () => {
  assert.ok((app.match(/knote-sidebar-card-scroll/g) || []).length >= 3)
  assert.ok((agent.match(/knote-sidebar-card-scroll/g) || []).length >= 2)
  assert.match(css, /\.knote-sidebar-card-scroll[\s\S]{0,180}overscroll-behavior:\s*contain/)
})

test('the gutter ends at the centered workspace boundary', () => {
  assert.match(css, /\.knote-sidebar-wheel-zone[\s\S]{0,240}width:\s*max\(1rem,\s*calc\(\(100vw - 72rem\) \/ 2\)\)/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fitSidebarWidths, normalizeSidebarWidths } from '../src/lib/sidebarWidths.js'

test('independent sidebar widths fit the editor budget without widening the left rail', () => {
  assert.deepEqual(normalizeSidebarWidths(), { left: 280, agent: 420, editor: 848 })
  const fit = (wanted, ...rest) => {
    const { left, agent } = fitSidebarWidths(wanted, ...rest)
    return { left, agent }
  }
  assert.deepEqual(fit({ left: 280, agent: 600 }, 1600), { left: 280, agent: 600 })
  const narrow = fitSidebarWidths({ left: 400, agent: 700 }, 992)
  assert.ok(narrow.left + narrow.agent + 32 + 320 <= 992)
  assert.equal(fitSidebarWidths({ left: 280, agent: 1000 }, 1600).agent, 720)
  assert.deepEqual(fit({ left: 400, agent: 360 }, 992, true, true, 'left'), { left: 280, agent: 360 })
  assert.equal(fitSidebarWidths({ left: 280, agent: 420 }, 992, false, true).left, 280)
  assert.deepEqual(fit({ left: 400, agent: 700 }, 992, true, true, '', true), { left: 320, agent: 320 })
  assert.deepEqual(fit({ left: 280, agent: 700 }, 1600, true, true, '', true), { left: 280, agent: 624 })
  assert.deepEqual(normalizeSidebarWidths({ left: -10, agent: Infinity }), { left: 240, agent: 1200, editor: 848 })
})

test('the editor column is a third draggable width, bounded by the window and never overlapping a rail', () => {
  // the middle column can be pulled wider than its default, up to whatever the
  // rails leave (so the user — not a fixed cap — decides how much of the window
  // the editor takes), and never below the readability floor
  const roomy = fitSidebarWidths({ left: 263, agent: 320, editor: 1400 }, 1990)
  assert.equal(roomy.editor, 1375, 'the editor takes exactly what the rails leave')
  assert.ok(roomy.left + roomy.agent + roomy.editor + 32 <= 1990)
  const tooWide = fitSidebarWidths({ left: 400, agent: 900, editor: 1600 }, 1200)
  assert.ok(tooWide.editor >= 320, 'the editor keeps its floor')
  assert.ok(tooWide.left + tooWide.agent + tooWide.editor + 32 <= 1200, 'rails and editor still fit the window')
  const tiny = fitSidebarWidths({ left: 280, agent: 420, editor: 10 }, 1600)
  assert.equal(tiny.editor, 320, 'the editor column is clamped up to its floor')
  // the centered branch keeps the same editor contract
  assert.equal(fitSidebarWidths({ left: 280, agent: 700, editor: 1000 }, 1600, true, true, '', true).editor, 1000)
})

const readRepo = (relative) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8')
const app = readRepo('src/App.vue')
const agent = readRepo('src/components/AgentPanel.vue')
const editor = readRepo('src/components/RichEditor.vue')
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
  assert.match(css, /\.knote-sidebar-wheel-zone[\s\S]{0,240}width:\s*max\(1rem,\s*calc\(\(100vw - var\(--knote-workbench-width\)\) \/ 2\)\)/)
  assert.match(css, /data-editor-centered="true"[\s\S]{0,220}var\(--knote-centered-workbench-width\)/)
})

test('the question rail avoids high-frequency reactive layout work', () => {
  const railCss = agent.slice(
    agent.indexOf('.knote-agent-question-rail{'),
    agent.indexOf('.knote-agent-empty-state')
  )
  assert.doesNotMatch(agent, /questionRailScrolling\s*=\s*ref/)
  assert.doesNotMatch(agent, /collapsedQuestionIndexes/)
  assert.doesNotMatch(agent, /--question-rail-(?:collapsed|expanded)-height/)
  assert.doesNotMatch(railCss, /transition:[^;}]*\bheight\b/)
  assert.match(agent, /classList\.add\('is-user-scrolling'\)/)
  assert.match(agent, /@wheel\.stop\.passive="revealQuestionRailScrollbar"/)
  assert.match(agent, /list\.scrollHeight - list\.clientHeight/)
  assert.match(agent, /data-knote-local-scrollbar="true"/)
  assert.match(app, /closest\('\[data-knote-local-scrollbar\]'\)/)
  assert.doesNotMatch(agent, /knote-agent-message-list\{[^}]*scroll-behavior:smooth/)
})

test('the desktop workspace sidebar uses independent compact width tokens', () => {
  assert.match(app, /data-testid="workspace-sidebar"[\s\S]{0,140}class="hidden lg:block shrink-0/)
  assert.match(css, /--knote-sidebar-width:\s*280px/)
  assert.match(css, /--knote-agent-sidebar-width:\s*420px/)
  assert.match(css, /--knote-workbench-width:\s*74rem/)
  assert.match(css, /--knote-centered-workbench-width:\s*115rem/)
  assert.match(css, /--knote-sidebar-max-width:\s*30rem/)
  assert.match(css, /\.knote-workspace-sidebar\s*\{[^}]*width:\s*var\(--knote-sidebar-width,280px\)/)
  assert.match(agent, /\.knote-agent-session-popover\{[^}]*width:min\(300px,calc\(100cqw - 18px\)\)[^}]*box-sizing:border-box/)
  assert.doesNotMatch(app, /data-testid="workspace-sidebar"[\s\S]{0,140}\bw-56\b/)
})

test('rails keep independent widths while centered mode compensates only asymmetry', () => {
  assert.match(css, /\.knote-workspace-sidebar[^}]*flex-grow:0/)
  assert.match(css, /\.knote-agent-sidebar[^}]*flex-grow:0/)
  assert.match(css, /data-sidebar-visible="true"\]\[data-agent-sidebar="false"\]::after[^}]*var\(--knote-sidebar-width,280px\)/)
  assert.match(css, /data-sidebar-visible="false"\]\[data-agent-sidebar="true"\]::before[^}]*var\(--knote-agent-sidebar-width,420px\)/)
  assert.match(css, /data-sidebar-visible="true"\]\[data-agent-sidebar="true"\] \.knote-workspace-sidebar[^}]*margin-right:max\(0px,calc\(var\(--knote-agent-sidebar-width,420px\) - var\(--knote-sidebar-width,280px\)\)\)/)
  assert.match(app, /startSidebarResize\('left', \$event\)/)
  assert.match(app, /startSidebarResize\('agent', \$event\)/)
})
test('the editor centering preference is explicit, persisted, and disabled on Android', () => {
  assert.match(app, /EDITOR_CENTERED_KEY = 'knote-editor-centered-v1'/)
  assert.match(app, /data-testid="center-editor-toggle"/)
  assert.match(app, /role="menuitemcheckbox"/)
  assert.match(app, /!isAndroidNative && viewMode === 'single'/)
  assert.match(app, /data-editor-centered=/)
  assert.match(css, /data-editor-centered="true"\][^}]*max-width:var\(--knote-centered-workbench-width\)/)
  assert.match(css, /data-editor-centered="true"\] \.knote-editor-column[^}]*margin-inline:auto/)
})

test('whole Markdown documents use the outer scroller while bounded chunks scroll locally', () => {
  assert.match(editor, /class="knote-doc-scroll pt-6/)
  assert.doesNotMatch(editor, /knote-doc-scroll[^"\n]*overflow-y-auto/)
  assert.match(css, /\.knote-doc-scroll\s*\{[^}]*overflow:\s*visible[^}]*scrollbar-gutter:\s*auto/)
  assert.match(css, /\.knote-rich-editor-bounded \.knote-doc-scroll\s*\{[^}]*overflow-y:\s*auto[^}]*scrollbar-gutter:\s*stable/)
  assert.match(app, /class="knote-rich-editor-bounded flex-1 min-h-0"/)
  assert.match(app, /\(pdfView \|\| docPreviewHtml\) \? 'min-h-0 overflow-hidden' : ''/)
})

test('queued prompts use aligned numbered rows on a neutral surface', () => {
  assert.match(agent, /v-for="\(item, queueIndex\) in activeAgentQueue"/)
  assert.match(agent, /class="knote-agent-queue-index"[^>]*>\{\{ queueIndex \+ 1 \}\}/)
  assert.match(agent, /\.knote-agent-queue-index\{[^}]*line-height:1\.375[^}]*font-weight:750/)
  assert.match(agent, /\.knote-agent-queue-card\{[^}]*var\(--color-base-content\)[^}]*var\(--color-base-100\)/)
  assert.doesNotMatch(agent, /knote-agent-queue-card[^\n>]*bg-base-200\/30/)
})

test('the Agent welcome uses visible text branding without a mascot', () => {
  const welcomeStart = agent.indexOf('<div v-if="!chatMessages.length" class="knote-agent-empty-state">')
  const welcomeEnd = agent.indexOf('<template v-for=', welcomeStart)
  assert.ok(welcomeStart >= 0 && welcomeEnd > welcomeStart, 'Agent welcome block must remain statically inspectable')
  const welcome = agent.slice(welcomeStart, welcomeEnd)

  assert.match(welcome, /<div[^>]*class="knote-agent-empty-brand"[^>]*lang="en"[^>]*>Knote Agent<\/div>/)
  assert.doesNotMatch(welcome, /KiwiMascot|knote-agent-empty-(?:mascot|kicker)/)
  assert.doesNotMatch(agent, /import KiwiMascot/)
})

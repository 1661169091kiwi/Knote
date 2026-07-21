<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { agentConfig, capabilities, persistConfig, probeCapabilities } from '../lib/agentStore.js'
import KiwiMascot from './KiwiMascot.vue'

const props = defineProps({
  lang: { type: String, default: 'zh' },
  icon: { type: String, required: true }
})
const emit = defineEmits(['complete', 'change-lang'])

const step = ref(0)
const configNote = ref('')
const demoOpen = ref(true)
const copy = computed(() => props.lang === 'en' ? {
  skip: 'Skip tour', back: 'Back', next: 'Continue', start: 'Start writing',
  languageHint: '切换语言 / Switch language',
  kicker: ['A more effortless way to write', 'Bring your own model', 'A writing assistant, on call', 'Everything is ready'],
  title: ['Markdown, with an AI built in.', 'Connect Knote Agent.', 'Click. Hold. Move. Click again.', 'Welcome to Knote.'],
  body: [
    'A focused Markdown editor and a reviewable AI assistant — kept together in one calm workspace.',
    'Knote connects to an OpenAI-compatible or Anthropic endpoint. Your credentials stay on this device.',
    'Click the kiwi to open the assistant. Hold the left button to move it. Click once more to hide it.',
    'Capture ideas instantly. Everything stays connected.'
  ],
  editor: 'Markdown editor', assistant: 'AI assistant', review: 'Review every change',
  protocol: 'Protocol', baseUrl: 'API base URL', apiKey: 'API key', model: 'Model name',
  saveCheck: 'Save & check', checking: 'Checking…', skipConfig: 'Set up later',
  missing: 'Fill in the API address, key and model first.', ok: 'Connected. Knote Agent is ready.',
  failed: 'Saved, but the connection check failed. You can adjust it later in Agent settings.',
  open: 'Click to open', drag: 'Hold to move', hide: 'Click to hide',
  ready: 'Your workspace is ready', private: 'Credentials stay local', editable: 'Edits stay reviewable'
} : {
  skip: '跳过教程', back: '上一步', next: '继续', start: '开始使用',
  languageHint: '切换语言 / Switch language',
  kicker: ['一种更省心的写作方式', '连接你自己的模型', '写作助手，随叫随到', '一切已经就绪'],
  title: ['Markdown，与 AI 助手合二为一。', '配置 Knote 助手。', '左键打开，按住拖动，再次左键隐藏。', '欢迎使用 Knote。'],
  body: [
    '专注的 Markdown 编辑工具，加上所有改动均可审核的内置 AI 助手，共处于一个轻盈的工作空间。',
    'Knote 可连接 OpenAI 兼容接口或 Anthropic 接口。你的配置与密钥只保存在当前设备。',
    '左键点击猕猴桃打开助手，按住鼠标左键即可拖动，再次左键点击便会隐藏窗口。',
    '随时捕捉想法，让内容始终彼此连接。'
  ],
  editor: 'Markdown 编辑器', assistant: '内置 AI 助手', review: '每次修改均可审核',
  protocol: '接口协议', baseUrl: 'API 地址', apiKey: 'API Key', model: '模型名称',
  saveCheck: '保存并检测', checking: '正在检测…', skipConfig: '稍后配置',
  missing: '请先填写 API 地址、密钥和模型名称。', ok: '连接成功，Knote 助手已准备好。',
  failed: '配置已保存，但连接检测未通过。之后可在助手设置中继续调整。',
  open: '左键打开', drag: '按住拖动', hide: '再次隐藏',
  ready: '你的工作空间已准备好', private: '密钥仅在本地保存', editable: '助手改动始终可审核'
})

const c = (key) => copy.value[key]
const configured = computed(() => !!(agentConfig.baseUrl && agentConfig.apiKey && agentConfig.model))
const progress = computed(() => `${((step.value + 1) / 4) * 100}%`)
const toggleLanguage = () => emit('change-lang', props.lang === 'en' ? 'zh' : 'en')

const next = () => {
  if (step.value === 1) persistConfig()
  if (step.value < 3) step.value++
  else emit('complete')
}
const previous = () => { if (step.value > 0) step.value-- }
const saveAndCheck = async () => {
  persistConfig()
  if (!configured.value) { configNote.value = c('missing'); return }
  configNote.value = ''
  try {
    await probeCapabilities()
    configNote.value = capabilities.chat ? c('ok') : c('failed')
  } catch {
    configNote.value = c('failed')
  }
}
const onKey = (event) => {
  if (event.key === 'Escape') emit('complete')
  if (event.key === 'ArrowRight' && event.target?.tagName !== 'INPUT') next()
  if (event.key === 'ArrowLeft' && event.target?.tagName !== 'INPUT') previous()
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  // The desktop shell reserves a stable scrollbar rail. While the full-screen
  // tour is open that rail would remain above the fixed overlay and look like
  // a clipped strip on the right, so temporarily remove every root scroller.
  document.documentElement.classList.add('knote-onboarding-active')
  document.body.classList.add('knote-onboarding-active')
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  document.documentElement.classList.remove('knote-onboarding-active')
  document.body.classList.remove('knote-onboarding-active')
})
</script>

<template>
  <div class="knote-onboarding" role="dialog" aria-modal="true" :aria-label="c('title')[step]">
    <div class="onboarding-aurora onboarding-aurora-a"></div>
    <div class="onboarding-aurora onboarding-aurora-b"></div>
    <div class="onboarding-aurora onboarding-aurora-c"></div>
    <div class="onboarding-fog"></div>

    <header class="onboarding-topbar">
      <div class="onboarding-brand"><img :src="icon" alt="" /><span>Knote</span></div>
      <div class="onboarding-progress-label">
        <span>0{{ step + 1 }}</span><i><b :style="{ width: progress }"></b></i><span>04</span>
      </div>
      <div class="onboarding-top-actions">
        <div v-if="step === 0" class="onboarding-language-hint"><span>{{ c('languageHint') }}</span></div>
        <button v-if="step === 0" class="onboarding-language-switch" @click="toggleLanguage">
          <span :class="{ active: lang === 'zh' }">中</span><i></i><span :class="{ active: lang === 'en' }">EN</span>
        </button>
        <button class="onboarding-skip" @click="emit('complete')">{{ c('skip') }}</button>
      </div>
    </header>

    <main class="onboarding-stage">
      <Transition name="onboarding-scene" mode="out-in">
        <section :key="step" class="onboarding-scene" :class="`is-step-${step}`">
          <div class="onboarding-copy">
            <p class="onboarding-kicker">{{ c('kicker')[step] }}</p>
            <h1>{{ c('title')[step] }}</h1>
            <p class="onboarding-body">{{ c('body')[step] }}</p>

            <div v-if="step === 0" class="onboarding-feature-row">
              <span>{{ c('editor') }}</span><span>{{ c('assistant') }}</span><span>{{ c('review') }}</span>
            </div>
            <div v-else-if="step === 3" class="onboarding-ready-list">
              <span><i>✓</i>{{ c('private') }}</span>
              <span><i>✓</i>{{ c('editable') }}</span>
            </div>
          </div>

          <!-- Product model -->
          <div v-if="step === 0" class="onboarding-product-model" aria-hidden="true">
            <div class="model-window">
              <div class="model-window-top"><b></b><span>Ideas.md</span><i></i><i></i></div>
              <div class="model-window-body">
                <aside><span></span><span></span><span></span><span></span></aside>
                <article>
                  <small>IDEAS / TODAY</small>
                  <h3><span class="model-md-token">#</span><span class="model-type-line"> A calmer place to write.</span><i class="model-type-caret"></i></h3>
                  <p></p><p></p><p class="short"></p>
                  <div class="model-review-diff">
                    <div class="model-review-label"><span></span>AI EDIT · {{ lang === 'en' ? 'REVIEW' : '待审核' }}</div>
                    <div class="model-diff-row is-remove"><b>−</b><span>Ideas should be written quickly and clearly.</span></div>
                    <div class="model-diff-row is-add"><b>+</b><span>Capture ideas clearly, the moment they arrive.</span></div>
                  </div>
                </article>
              </div>
            </div>
            <div class="model-keyboard" aria-label="Keyboard typing animation">
              <div class="keyboard-row"><i>Q</i><i>W</i><i class="key-press-1">E</i><i>R</i><i class="key-press-3">T</i><i>Y</i><i>U</i><i>I</i><i>O</i><i>P</i></div>
              <div class="keyboard-row"><i>A</i><i class="key-press-2">S</i><i>D</i><i>F</i><i>G</i><i>H</i><i>J</i><i>K</i><i>L</i></div>
              <div class="keyboard-row"><i>Z</i><i>X</i><i>C</i><i class="keyboard-space key-press-4"></i><i>V</i><i>B</i><i>N</i><i>M</i></div>
            </div>
            <div class="model-agent-launcher"><KiwiMascot state="idle" :size="62" static /></div>
            <div class="model-action-cursor"><svg viewBox="0 0 24 24"><path d="M5 3l13 9-6 1 3 6-3 1-3-6-4 4z"/></svg></div>
            <div class="model-agent-card">
              <div class="model-agent-head"><KiwiMascot state="waiting" :size="28" static /><b>Knote Agent</b><span>●</span></div>
              <div class="model-agent-context"><i></i><span>Ideas.md · {{ c('editor') }}</span></div>
              <p>{{ lang === 'en' ? 'I tightened the sentence and kept its meaning. Review the highlighted edit.' : '我已精简这句话并保留原意，请审核高亮修改。' }}</p>
            </div>
          </div>

          <!-- Real agent configuration -->
          <div v-else-if="step === 1" class="onboarding-config-card">
            <div class="config-card-head"><span>Agent setup</span><i :class="{ ready: configured }"></i></div>
            <div class="config-protocols">
              <button :class="{ active: agentConfig.protocol === 'openai' }" @click="agentConfig.protocol = 'openai'">OpenAI 兼容</button>
              <button :class="{ active: agentConfig.protocol === 'anthropic' }" @click="agentConfig.protocol = 'anthropic'">Anthropic</button>
            </div>
            <label><span>{{ c('baseUrl') }}</span><input v-model.trim="agentConfig.baseUrl" placeholder="https://api.deepseek.com" /></label>
            <label><span>{{ c('apiKey') }}</span><input v-model.trim="agentConfig.apiKey" type="password" placeholder="sk-…" /></label>
            <label><span>{{ c('model') }}</span><input v-model.trim="agentConfig.model" placeholder="deepseek-chat" /></label>
            <div class="config-card-actions">
              <button class="config-later" @click="next">{{ c('skipConfig') }}</button>
              <button class="config-check" :disabled="capabilities.checking" @click="saveAndCheck">
                <span v-if="capabilities.checking" class="config-spinner"></span>{{ capabilities.checking ? c('checking') : c('saveCheck') }}
              </button>
            </div>
            <p v-if="configNote" class="config-note" :class="{ success: capabilities.chat }">{{ configNote }}</p>
          </div>

          <!-- Animated assistant interaction -->
          <div v-else-if="step === 2" class="onboarding-agent-demo" :class="{ 'is-open': demoOpen }" @click="demoOpen = !demoOpen">
            <div class="demo-grid"></div>
            <div class="demo-chat">
              <div><KiwiMascot state="idle" :size="30" /><b>Knote Agent</b><span>×</span></div>
              <p>有什么想法？我可以阅读并修改当前文档。</p>
              <i></i><i></i><i></i>
            </div>
            <div class="demo-mascot"><KiwiMascot state="idle" :size="68" /></div>
            <div class="demo-cursor"><svg viewBox="0 0 24 24"><path d="M5 3l13 9-6 1 3 6-3 1-3-6-4 4z"/></svg></div>
            <div class="demo-instructions"><span>01 · {{ c('open') }}</span><span>02 · {{ c('drag') }}</span><span>03 · {{ c('hide') }}</span></div>
          </div>

          <!-- Welcome model -->
          <div v-else class="onboarding-welcome-model">
            <div class="welcome-orbit orbit-a"></div><div class="welcome-orbit orbit-b"></div>
            <div class="welcome-icon"><img :src="icon" alt="Knote" /></div>
            <p>{{ c('ready') }}</p>
          </div>
        </section>
      </Transition>
    </main>

    <footer class="onboarding-footer">
      <div class="onboarding-nav">
        <button v-if="step > 0" class="onboarding-back" @click="previous">{{ c('back') }}</button>
        <button class="onboarding-next" @click="next">{{ step === 3 ? c('start') : c('next') }}<span>→</span></button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.knote-onboarding{position:fixed;inset:0;z-index:10000;overflow:hidden;color:#1d211d;background:#f7f9f4;font-family:Inter,"Segoe UI","Microsoft YaHei UI",sans-serif;isolation:isolate}
:global(html.knote-onboarding-active),:global(body.knote-onboarding-active){overflow:hidden!important;scrollbar-gutter:auto!important}:global(html.knote-onboarding-active .knote-root){overflow:hidden!important;scrollbar-gutter:auto!important}
.onboarding-aurora{position:absolute;z-index:-2;border-radius:999px;filter:blur(64px) saturate(.92);opacity:.62;will-change:transform,background-position;pointer-events:none}.onboarding-aurora-a{width:52vw;height:52vw;left:-12vw;top:-20vw;background:radial-gradient(circle at 42% 44%,#e6f7b8 0,#f7e89a 34%,rgba(255,255,255,0) 70%);animation:obFloatA 9s cubic-bezier(.45,0,.25,1) infinite alternate}.onboarding-aurora-b{width:60vw;height:60vw;right:-18vw;bottom:-27vw;background:radial-gradient(circle at 52% 48%,#d6f1bb 0,#faefb8 38%,rgba(255,255,255,0) 72%);animation:obFloatB 11s cubic-bezier(.45,0,.25,1) infinite alternate}.onboarding-aurora-c{width:64vw;height:22vw;left:20vw;top:32vh;border-radius:50%;opacity:.34;background:linear-gradient(105deg,transparent 4%,#f8e78f 35%,#d8f2bd 64%,transparent 94%);transform:rotate(-10deg);animation:obFloatC 8s cubic-bezier(.45,0,.25,1) infinite alternate}.onboarding-fog{position:absolute;inset:-8%;z-index:-1;background:linear-gradient(120deg,rgba(255,255,255,.82),rgba(250,252,247,.58) 45%,rgba(255,255,255,.8));background-size:180% 180%;backdrop-filter:blur(22px);animation:obFogDrift 12s ease-in-out infinite alternate}
.onboarding-topbar,.onboarding-footer{position:absolute;left:clamp(24px,5vw,72px);right:clamp(24px,5vw,72px);z-index:5;display:flex;align-items:center}.onboarding-topbar{top:26px;height:44px;justify-content:space-between}.onboarding-brand{display:flex;align-items:center;gap:10px;font-size:17px;font-weight:700;letter-spacing:-.02em}.onboarding-brand img{width:28px;height:28px;border-radius:9px}.onboarding-progress-label{position:absolute;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:11px;color:#777e76;font-size:11px;letter-spacing:.18em}.onboarding-progress-label i{position:relative;display:block;width:72px;height:2px;overflow:hidden;border-radius:999px;background:#d8ddd5}.onboarding-progress-label i b{position:absolute;inset:0 auto 0 0;border-radius:inherit;background:linear-gradient(90deg,#9cd455,#edd16b);transition:width .65s cubic-bezier(.2,.8,.2,1)}.onboarding-top-actions{display:flex;align-items:center;gap:14px}.onboarding-language-hint{display:flex;align-items:center;gap:8px;color:#778073;font:600 10px/1 Inter,"Microsoft YaHei UI",sans-serif;letter-spacing:.08em;white-space:nowrap}.onboarding-language-hint b{font-size:17px;font-weight:400;color:#94bd56;animation:obLanguageArrow 1.6s ease-in-out infinite}.onboarding-language-switch{height:34px;display:flex;align-items:center;gap:7px;padding:0 12px;border:1px solid rgba(37,45,34,.1);border-radius:999px;background:rgba(255,255,255,.62);color:#9aa095;font:600 10px Inter,"Microsoft YaHei UI",sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(53,67,42,.06);backdrop-filter:blur(12px)}.onboarding-language-switch i{width:1px;height:11px;background:#d7ddd3}.onboarding-language-switch span{transition:.2s}.onboarding-language-switch span.active{color:#1d211d}.onboarding-language-switch:hover{border-color:#bfde8c;background:rgba(255,255,255,.84)}.onboarding-skip,.onboarding-back{border:0;background:transparent;color:#666e65;font-size:13px;padding:10px 2px;cursor:pointer}.onboarding-skip:hover,.onboarding-back:hover{color:#111}
.onboarding-stage{position:absolute;inset:94px clamp(24px,5vw,72px) 92px;display:flex;align-items:center;justify-content:center}.onboarding-scene{width:min(1160px,100%);height:min(650px,100%);display:grid;grid-template-columns:minmax(300px,.82fr) minmax(440px,1.18fr);align-items:center;gap:clamp(36px,7vw,100px)}.onboarding-copy{position:relative;z-index:2}.onboarding-kicker{margin:0 0 20px;text-transform:uppercase;letter-spacing:.18em;font-size:10px;font-weight:700;color:#788174}.onboarding-copy h1{margin:0;max-width:560px;font-size:clamp(40px,5vw,72px);line-height:1.02;letter-spacing:-.055em;font-weight:560}.onboarding-body{max-width:520px;margin:28px 0 0;font-size:clamp(15px,1.35vw,18px);line-height:1.8;color:#687067}.onboarding-feature-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:30px}.onboarding-feature-row span{border:1px solid rgba(29,33,29,.1);background:rgba(255,255,255,.58);border-radius:999px;padding:8px 13px;font-size:11px;color:#626a60;box-shadow:0 10px 30px rgba(56,70,43,.04)}
.onboarding-product-model{position:relative;height:min(520px,62vh);perspective:1000px}.model-window{position:absolute;inset:16px 32px 44px 0;border:1px solid rgba(36,43,34,.1);border-radius:30px;background:rgba(255,255,255,.78);box-shadow:0 35px 90px rgba(56,70,43,.13);backdrop-filter:blur(24px);overflow:hidden;transform:rotateY(-3deg) rotateX(1deg);animation:obModelIn 1.15s cubic-bezier(.2,.8,.2,1) both}.model-window-top{height:54px;border-bottom:1px solid rgba(36,43,34,.07);display:flex;align-items:center;gap:10px;padding:0 20px;color:#747c72;font-size:11px}.model-window-top b{width:9px;height:9px;border-radius:50%;background:#84cc16;box-shadow:0 0 18px rgba(132,204,22,.45)}.model-window-top span{margin-right:auto}.model-window-top i{width:7px;height:7px;border:1px solid #aeb5ac;border-radius:50%}.model-window-body{display:grid;grid-template-columns:86px 1fr;height:calc(100% - 54px)}.model-window aside{border-right:1px solid rgba(36,43,34,.06);padding:34px 20px}.model-window aside span{display:block;height:7px;margin-bottom:18px;border-radius:9px;background:#dfe4dc}.model-window aside span:nth-child(2){width:70%;background:#dff1bf}.model-window article{padding:50px 54px}.model-window article small{font-size:9px;letter-spacing:.18em;color:#9aa095}.model-window article h3{font-size:34px;line-height:1.12;letter-spacing:-.04em;margin:18px 0 34px}.model-window article>p{height:7px;width:88%;background:#e3e7e0;border-radius:9px;margin:12px 0}.model-window article>p.short{width:56%}.model-selection{display:inline-block;margin-top:34px;padding:10px 14px;border-radius:10px;background:linear-gradient(90deg,rgba(221,245,177,.75),rgba(250,239,177,.55));font-size:11px}.model-agent-card{position:absolute;width:260px;right:-4px;bottom:0;border:1px solid rgba(36,43,34,.1);border-radius:22px;background:rgba(255,255,255,.91);box-shadow:0 24px 70px rgba(58,72,43,.16);padding:16px;animation:obAgentIn .9s .42s cubic-bezier(.2,.8,.2,1) both}.model-agent-head{display:flex;align-items:center;gap:8px;font-size:11px}.model-agent-head img{width:24px;height:24px;border-radius:8px}.model-agent-head span{margin-left:auto;color:#84cc16;font-size:8px}.model-agent-card>p{font-size:10px;color:#687067;margin:16px 0}.model-agent-answer{border-radius:12px;background:#f3f6f0;padding:10px}.model-agent-answer i,.model-agent-answer span{display:block;height:5px;border-radius:6px;background:#dce2d8;margin:6px 0}.model-agent-answer i{width:22%;background:#cceba0}.model-agent-answer span:last-child{width:68%}.model-review{display:flex;justify-content:flex-end;gap:6px;margin-top:10px}.model-review button{width:24px;height:24px;border:0;border-radius:50%;background:#f0f2ee}.model-review button:last-child{background:#1e231d;color:white}
.onboarding-config-card{width:min(520px,100%);justify-self:end;padding:28px;border:1px solid rgba(36,43,34,.1);border-radius:30px;background:rgba(255,255,255,.76);box-shadow:0 32px 90px rgba(56,70,43,.12);backdrop-filter:blur(24px);animation:obModelIn 1s cubic-bezier(.2,.8,.2,1) both}.config-card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;font-size:12px;font-weight:650}.config-card-head i{width:8px;height:8px;border-radius:50%;background:#d2d7cf}.config-card-head i.ready{background:#84cc16;box-shadow:0 0 14px rgba(132,204,22,.48)}.config-protocols{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:18px}.config-protocols button{height:38px;border:1px solid #dfe4dc;border-radius:12px;background:rgba(248,250,246,.7);color:#6d746b;font-size:11px;cursor:pointer}.config-protocols button.active{border-color:#c5e88d;background:#edf8dc;color:#31510e}.onboarding-config-card label{display:block;margin-top:13px}.onboarding-config-card label span{display:block;margin:0 0 6px 3px;font-size:10px;font-weight:650;color:#747b71}.onboarding-config-card input{width:100%;height:43px;box-sizing:border-box;border:1px solid #dfe4dc;border-radius:13px;background:rgba(255,255,255,.8);outline:0;padding:0 14px;font:11px ui-monospace,SFMono-Regular,Consolas,monospace;color:#252a24;transition:.2s}.onboarding-config-card input:focus{border-color:#a7d958;box-shadow:0 0 0 3px rgba(132,204,22,.1)}.config-card-actions{display:flex;align-items:center;justify-content:flex-end;gap:12px;margin-top:22px}.config-later{border:0;background:transparent;color:#7b8278;font-size:11px;cursor:pointer}.config-check{height:39px;border:0;border-radius:999px;background:#1d211d;color:white;padding:0 18px;font-size:11px;cursor:pointer;display:flex;align-items:center;gap:7px}.config-check:disabled{opacity:.6}.config-spinner{width:11px;height:11px;border:1.5px solid rgba(255,255,255,.35);border-top-color:white;border-radius:50%;animation:obSpin .8s linear infinite}.config-note{margin:12px 3px 0;font-size:10px;line-height:1.5;color:#a76b22}.config-note.success{color:#4f7f13}
.onboarding-agent-demo{position:relative;width:min(580px,100%);height:430px;justify-self:end;border:1px solid rgba(36,43,34,.08);border-radius:34px;background:rgba(255,255,255,.52);box-shadow:0 30px 90px rgba(56,70,43,.1);overflow:hidden;cursor:pointer}.demo-grid{position:absolute;inset:0;opacity:.32;background-image:linear-gradient(rgba(74,90,62,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(74,90,62,.07) 1px,transparent 1px);background-size:36px 36px;mask-image:radial-gradient(circle at 50% 50%,black,transparent 78%)}.demo-chat{position:absolute;left:66px;top:54px;width:310px;height:220px;border:1px solid rgba(36,43,34,.1);border-radius:24px;background:rgba(255,255,255,.9);box-shadow:0 24px 60px rgba(47,62,34,.12);padding:18px;box-sizing:border-box;animation:obDemoChat 7s ease-in-out infinite}.demo-chat>div{display:flex;align-items:center;gap:9px;font-size:11px}.demo-chat img,.model-agent-head img{image-rendering:pixelated;object-fit:contain}.demo-chat img{width:25px;height:25px;border-radius:0}.demo-chat span{margin-left:auto;color:#90978e}.demo-chat p{margin:28px 0 20px;color:#6f776d;font-size:11px;line-height:1.7}.demo-chat>i{display:block;width:78%;height:6px;border-radius:7px;background:#e6eae3;margin:10px 0}.demo-chat>i:nth-of-type(2){width:92%}.demo-chat>i:nth-of-type(3){width:54%;background:#e2f2c9}.demo-mascot{position:absolute;left:388px;top:280px;width:72px;height:72px;display:grid;place-items:center;animation:obDemoMascot 7s ease-in-out infinite}.demo-mascot img{width:64px;height:64px;object-fit:contain;image-rendering:pixelated;filter:drop-shadow(0 12px 12px rgba(57,74,40,.18))}.demo-cursor{position:absolute;width:27px;height:27px;left:443px;top:337px;z-index:3;color:#171b16;filter:drop-shadow(0 4px 4px rgba(0,0,0,.16));animation:obDemoCursor 7s ease-in-out infinite}.demo-cursor svg{width:100%;fill:currentColor;stroke:white;stroke-width:1.4}.demo-instructions{position:absolute;left:28px;right:28px;bottom:22px;display:flex;justify-content:space-between}.demo-instructions span{padding:7px 10px;border-radius:999px;background:rgba(255,255,255,.68);border:1px solid rgba(36,43,34,.07);font-size:9px;letter-spacing:.06em;color:#777e74}
.onboarding-welcome-model{position:relative;width:430px;height:430px;justify-self:center;display:grid;place-items:center}.welcome-orbit{position:absolute;border:1px solid rgba(113,151,65,.16);border-radius:50%;animation:obOrbit 14s linear infinite}.orbit-a{inset:28px}.orbit-b{inset:82px;animation-direction:reverse;animation-duration:11s}.welcome-orbit:before{content:"";position:absolute;width:11px;height:11px;top:14%;left:12%;border-radius:50%;background:#dcec91;box-shadow:0 0 24px rgba(166,207,77,.5)}.orbit-b:before{top:auto;left:auto;bottom:6%;right:18%;background:#f3da78}.welcome-icon{position:relative;width:140px;height:140px;border-radius:43px;background:rgba(255,255,255,.82);border:1px solid rgba(36,43,34,.09);display:grid;place-items:center;box-shadow:0 30px 90px rgba(58,75,40,.15);backdrop-filter:blur(18px);animation:obWelcome 1.2s cubic-bezier(.2,.8,.2,1) both}.welcome-icon img{width:90px;height:90px;border-radius:25px}.onboarding-welcome-model>p{position:absolute;bottom:24px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#7b8378}
.onboarding-ready-list{display:flex;flex-direction:column;gap:11px;margin-top:30px;color:#687066;font-size:12px}.onboarding-ready-list span{display:flex;align-items:center;gap:10px}.onboarding-ready-list i{display:grid;place-items:center;width:19px;height:19px;border-radius:50%;background:#1d211d;color:white;font-size:10px;font-style:normal}
.model-md-token{color:#96c847;font-weight:500}.model-md-list{display:flex;align-items:center;gap:9px;margin-top:15px;font:11px ui-monospace,SFMono-Regular,Consolas,monospace;color:#687067}.model-md-list i{font-style:normal;color:#84cc16}.model-md-list span{border-bottom:1px solid rgba(96,111,83,.12);padding-bottom:3px}.model-agent-context{display:flex;align-items:center;gap:7px;margin-top:14px;padding:8px 10px;border:1px solid rgba(36,43,34,.07);border-radius:11px;background:#f4f7f1;color:#747c72;font-size:9px}.model-agent-context i{width:6px;height:6px;border-radius:2px;background:#84cc16}.model-agent-card>p{margin:14px 2px 2px;line-height:1.6}
.onboarding-language-hint{letter-spacing:.035em}
.model-type-line{display:inline-block;vertical-align:bottom;width:0;max-width:18.5ch;overflow:hidden;white-space:nowrap;animation:obTypeText 1.55s 1.05s steps(25,end) forwards}
.model-type-caret{display:inline-block;width:2px;height:.88em;margin-left:3px;vertical-align:-.08em;border-radius:2px;background:#88b947;animation:obCaretBlink .5s 1.05s step-end 4,obCaretAway .1s 2.75s forwards}
.model-review-diff{margin-top:20px;opacity:0;transform:translateY(12px);filter:blur(5px);animation:obDiffIn .72s 4.38s cubic-bezier(.2,.8,.2,1) forwards}
.model-review-label{display:flex;align-items:center;gap:7px;margin-bottom:8px;font:700 8px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.12em;color:#7f887b}.model-review-label span{width:6px;height:6px;border-radius:50%;background:#e4c557;box-shadow:0 0 10px rgba(228,197,87,.38)}
.model-diff-row{display:flex;align-items:center;gap:8px;min-height:25px;margin:5px 0;padding:3px 9px;border-radius:7px;font:9px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace}.model-diff-row b{font-size:12px}.model-diff-row.is-remove{background:rgba(248,218,218,.66);color:#a95050;text-decoration:line-through;text-decoration-thickness:1px}.model-diff-row.is-add{background:rgba(218,242,200,.74);color:#4d7b2b}.model-diff-row.is-remove b{color:#cf6464}.model-diff-row.is-add b{color:#70a43f}
.model-keyboard{position:absolute;left:24px;right:24px;bottom:-2px;z-index:5;height:102px;box-sizing:border-box;padding:10px 14px;border:1px solid rgba(35,42,33,.11);border-radius:22px;background:rgba(250,252,248,.91);box-shadow:0 22px 45px rgba(49,62,39,.15);backdrop-filter:blur(18px);transform-origin:50% 100%;animation:obKeyboardSequence 3.12s .45s cubic-bezier(.2,.8,.2,1) both}.keyboard-row{height:25px;display:flex;justify-content:center;gap:5px;margin:0 0 4px;box-sizing:border-box}.keyboard-row:nth-child(2){padding:0 3.8%}.keyboard-row:nth-child(3){padding:0 6.5%}.keyboard-row i{display:grid;place-items:center;flex:1 1 0;min-width:0;height:23px;padding:0;border:1px solid rgba(43,51,40,.1);border-radius:7px;background:rgba(255,255,255,.86);box-shadow:0 2px 0 rgba(54,65,49,.12);color:#788074;font:600 7px/1 ui-monospace,SFMono-Regular,Consolas,monospace;font-style:normal}.keyboard-row .keyboard-space{flex:3.2 1 0;min-width:0}.keyboard-row .key-press-1{animation:obKeyPress .22s 1.05s ease}.keyboard-row .key-press-2{animation:obKeyPress .22s 1.38s ease}.keyboard-row .key-press-3{animation:obKeyPress .22s 1.72s ease}.keyboard-row .key-press-4{animation:obKeyPress .22s 2.08s ease}
.model-agent-launcher{position:absolute;right:22px;bottom:12px;z-index:6;width:76px;height:76px;display:grid;place-items:center;border:0;border-radius:50%;background:transparent;box-shadow:none;opacity:0;animation:obLauncherIn .46s 2.86s cubic-bezier(.2,.8,.2,1) both}.model-agent-launcher:after{content:"";position:absolute;inset:9px;border:1px solid rgba(132,204,22,.48);border-radius:50%;opacity:0;animation:obClickRing .5s 3.82s ease-out forwards;pointer-events:none}
.model-action-cursor{position:absolute;right:45px;bottom:37px;z-index:8;width:24px;height:24px;color:#171b16;filter:drop-shadow(0 3px 4px rgba(0,0,0,.2));opacity:0;animation:obProductCursor 1.55s 2.72s cubic-bezier(.3,.75,.2,1) both}.model-action-cursor svg{width:100%;fill:currentColor;stroke:#fff;stroke-width:1.4}
.model-agent-card{right:4px;bottom:91px;width:250px;z-index:7;opacity:0;animation:obAgentReply .7s 4.05s cubic-bezier(.2,.8,.2,1) both}.model-agent-head>:first-child{flex:0 0 auto}.model-agent-head canvas{cursor:default!important}.model-agent-card>p{margin-bottom:0}.model-window article{padding-bottom:28px}.model-window article h3{min-height:76px}
.demo-chat>div>:first-child{flex:0 0 auto}.demo-chat canvas,.demo-mascot canvas{cursor:default!important}
.onboarding-footer{bottom:24px;justify-content:flex-end}.onboarding-nav{display:flex;align-items:center;gap:22px}.onboarding-next{height:46px;border:0;border-radius:999px;background:#1d211d;color:#fff;padding:0 9px 0 21px;display:flex;align-items:center;gap:17px;font-size:12px;cursor:pointer;box-shadow:0 14px 38px rgba(26,31,24,.16)}.onboarding-next span{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:#fff;color:#171b16;font-size:15px}
.onboarding-scene-enter-active,.onboarding-scene-leave-active{transition:opacity .55s ease,transform .65s cubic-bezier(.2,.8,.2,1),filter .55s ease}.onboarding-scene-enter-from{opacity:0;transform:translateY(18px) scale(.96);filter:blur(8px)}.onboarding-scene-leave-to{opacity:0;transform:translateY(-12px) scale(.985);filter:blur(5px)}
@keyframes obFloatA{0%{transform:translate3d(-3vw,-2vh,0) scale(1)}55%{transform:translate3d(8vw,7vh,0) scale(1.12)}100%{transform:translate3d(13vw,2vh,0) scale(.98)}}@keyframes obFloatB{0%{transform:translate3d(3vw,4vh,0) scale(.96)}52%{transform:translate3d(-8vw,-7vh,0) scale(1.08)}100%{transform:translate3d(-13vw,-2vh,0) scale(1.02)}}@keyframes obFloatC{0%{transform:translate3d(-8vw,5vh,0) rotate(-10deg) scale(.94)}100%{transform:translate3d(10vw,-7vh,0) rotate(4deg) scale(1.12)}}@keyframes obFogDrift{0%{background-position:0% 40%}100%{background-position:100% 60%}}@keyframes obModelIn{from{opacity:0;transform:translateY(28px) scale(.96) rotateY(-5deg);filter:blur(8px)}to{opacity:1;filter:blur(0)}}@keyframes obAgentIn{from{opacity:0;transform:translateY(24px) scale(.94);filter:blur(7px)}}@keyframes obSpin{to{transform:rotate(360deg)}}@keyframes obOrbit{to{transform:rotate(360deg)}}@keyframes obWelcome{from{opacity:0;transform:scale(.9);filter:blur(10px)}}
@keyframes obTypeText{to{width:18.5ch}}@keyframes obCaretBlink{50%{opacity:0}}@keyframes obCaretAway{to{opacity:0}}
@keyframes obKeyboardSequence{0%{opacity:0;transform:translateY(18px) scale(.96);filter:blur(6px)}10%,70%{opacity:1;transform:none;filter:blur(0)}100%{opacity:0;transform:translateY(16px) scale(.97);filter:blur(6px);visibility:hidden}}@keyframes obKeyPress{50%{color:#fff;background:#252b24;border-color:#252b24;box-shadow:0 1px 0 rgba(0,0,0,.28);transform:translateY(2px)}}
@keyframes obLauncherIn{from{opacity:0;transform:translateY(12px) scale(.9);filter:blur(5px)}to{opacity:1;transform:none;filter:blur(0)}}@keyframes obClickRing{0%{opacity:0;transform:scale(.75)}35%{opacity:1}100%{opacity:0;transform:scale(1.4)}}@keyframes obProductCursor{0%{opacity:0;transform:translate(-215px,48px)}16%{opacity:1;transform:translate(-215px,48px)}72%{opacity:1;transform:none}84%{opacity:1;transform:scale(.72)}94%{opacity:1;transform:none}100%{opacity:0;transform:translate(2px,2px)}}@keyframes obAgentReply{from{opacity:0;transform:translateY(18px) scale(.95);filter:blur(7px)}to{opacity:1;transform:none;filter:blur(0)}}@keyframes obDiffIn{to{opacity:1;transform:none;filter:blur(0)}}
@keyframes obDemoChat{0%,12%,78%,100%{opacity:0;transform:translateY(12px) scale(.97);filter:blur(5px)}20%,65%{opacity:1;transform:none;filter:blur(0)}}@keyframes obDemoMascot{0%,25%{transform:none}42%,60%{transform:translate(-210px,-2px)}75%,100%{transform:none}}@keyframes obDemoCursor{0%,7%{opacity:0;transform:translate(70px,45px)}14%{opacity:1;transform:translate(0)}21%{transform:translate(-14px,-14px) scale(.86)}29%{transform:translate(-14px,-14px)}43%{transform:translate(-224px,-16px) scale(.86)}57%{transform:translate(-224px,-16px)}69%{transform:translate(-14px,-14px)}76%{transform:translate(-14px,-14px) scale(.86)}84%,100%{opacity:0;transform:translate(30px,20px)}}
@media(max-width:850px){.onboarding-stage{top:82px;overflow:auto;align-items:flex-start}.onboarding-scene{height:auto;min-height:100%;grid-template-columns:1fr;gap:34px;padding:34px 0 80px}.onboarding-copy h1{font-size:42px}.onboarding-product-model,.onboarding-agent-demo{height:400px;width:100%}.onboarding-config-card{justify-self:stretch;width:auto}.onboarding-welcome-model{width:min(430px,100%)}.onboarding-language-hint{display:none}.onboarding-progress-label{top:52px}}
@media(max-width:520px){.onboarding-topbar,.onboarding-footer{left:18px;right:18px}.onboarding-stage{left:18px;right:18px}.onboarding-copy h1{font-size:36px}.onboarding-body{margin-top:18px}.model-agent-card{right:0}.model-window{right:0}.model-window-body{grid-template-columns:56px 1fr}.model-window article{padding:38px 24px}.demo-chat{left:22px;width:270px}.demo-mascot{left:75%;}.demo-instructions{gap:5px;flex-wrap:wrap}.onboarding-nav{gap:10px}.onboarding-back{display:none}}
@media(prefers-reduced-motion:reduce){.onboarding-aurora,.onboarding-fog,.model-window,.model-agent-card,.model-review-diff,.model-agent-launcher,.demo-chat,.demo-mascot,.demo-cursor,.welcome-orbit,.welcome-icon{animation:none!important}.model-keyboard,.model-action-cursor{display:none}.model-agent-card,.model-review-diff,.model-agent-launcher{opacity:1;transform:none;filter:none}.model-type-line{width:18.5ch;animation:none}.model-type-caret{display:none}.onboarding-scene-enter-active,.onboarding-scene-leave-active{transition-duration:.15s}}
</style>

<script setup>
defineProps({ t: Function, lang: String, viewMode: String, stats: Object, saving: Boolean, pdf: Boolean, canUndo: Boolean, canRedo: Boolean, prefix: { type: String, default: 'sidebar' } })
defineEmits(['open', 'save', 'view', 'language', 'theme', 'more', 'undo', 'redo'])
</script>
<template>
  <section :data-testid="`${prefix}-actions-card`" class="knote-sidebar-actions card bg-base-100 border border-base-200">
    <div class="knote-sidebar-actions-body">
      <div class="knote-sidebar-actions-primary">
        <button :data-testid="`${prefix}-open-menu`" @click="$emit('open', $event)"><svg viewBox="0 0 24 24"><path d="M3 8V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v1M3 9h18l-2 10H5L3 9Z"/></svg>{{ t('open') }}</button>
        <button :data-testid="`${prefix}-save`" class="is-save" :disabled="saving" @click="$emit('save')"><svg viewBox="0 0 24 24"><path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5"/></svg>{{ t('save') }}</button>
        <button :data-testid="`${prefix}-actions-menu`" class="is-more" :aria-label="lang === 'zh' ? '更多操作' : 'More actions'" @click="$emit('more', $event)"><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg></button>
      </div>
      <div class="knote-sidebar-actions-secondary">
        <div class="knote-sidebar-view-switch" role="group" :aria-label="lang === 'zh' ? '编辑视图' : 'Editor view'">
          <button :data-testid="`${prefix}-view-single`" :class="{ active: viewMode === 'single' }" :aria-pressed="viewMode === 'single'" @click="$emit('view', 'single')">{{ t('single') }}</button>
          <button :data-testid="`${prefix}-view-split`" :class="{ active: viewMode === 'split' }" :aria-pressed="viewMode === 'split'" :disabled="pdf" @click="$emit('view', 'split')">{{ t('split') }}</button>
        </div>
        <div class="knote-sidebar-history">
          <button :data-testid="`${prefix}-undo`" :disabled="!canUndo" :aria-label="t('undo')" :title="`${t('undo')} (Ctrl+Z)`" @click="$emit('undo')"><svg viewBox="0 0 24 24"><path d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3"/></svg></button>
          <button :data-testid="`${prefix}-redo`" :disabled="!canRedo" :aria-label="t('redo')" :title="`${t('redo')} (Ctrl+Y)`" @click="$emit('redo')"><svg viewBox="0 0 24 24"><path d="m15 15 6-6m0 0-6-6m6 6H9a6 6 0 0 0 0 12h3"/></svg></button>
        </div>
        <div class="knote-sidebar-preferences">
          <button aria-label="切换语言 / Switch language" @click="$emit('language')">{{ lang === 'zh' ? '中文' : 'EN' }}<small>{{ lang === 'zh' ? '/ EN' : '/ 中文' }}</small></button>
          <button :data-testid="`${prefix}-theme-menu`" @click="$emit('theme', $event)"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 4v16"/></svg>{{ t('theme') }}</button>
        </div>
      </div>
    </div>
    <div class="knote-sidebar-stats" :title="t('stats_tooltip')">
      <div><b>{{ stats.words.toLocaleString() }}</b><span>{{ t('words') }}</span></div>
      <div><b>{{ stats.chars.toLocaleString() }}</b><span>{{ t('chars') }}</span></div>
      <div><b>{{ stats.lines.toLocaleString() }}</b><span>{{ t('lines') }}</span></div>
    </div>
  </section>
</template>
<style scoped>
.knote-sidebar-actions{border-radius:14px;overflow:hidden;box-shadow:0 2px 6px #22301508;container-type:inline-size}
.knote-sidebar-actions-body{padding:12px}.knote-sidebar-actions svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}
.knote-sidebar-actions button{cursor:pointer;border-radius:7px;white-space:nowrap}.knote-sidebar-actions button:focus-visible{outline:2px solid #84cc16;outline-offset:2px}.knote-sidebar-actions button:disabled{opacity:.5;cursor:default}
.knote-sidebar-actions-primary{display:grid;grid-template-columns:1fr 1fr 26px;gap:7px}.knote-sidebar-actions-primary button{height:33px;display:flex;justify-content:center;align-items:center;gap:6px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);font-size:12px;font-weight:550}.knote-sidebar-actions-primary .is-save{color:#638f30;background:color-mix(in srgb,#84cc16 10%,transparent);border-color:color-mix(in srgb,#84cc16 23%,transparent)}.knote-sidebar-actions-primary .is-more{border:0;opacity:.6}
.knote-sidebar-history{display:flex;align-items:center;gap:2px}.knote-sidebar-history button{padding:3px;border:0;color:inherit;opacity:.55}.knote-sidebar-history button:not(:disabled):hover{opacity:1;color:#638f30}.knote-sidebar-history button:disabled{opacity:.22}.knote-sidebar-history svg{width:14px;height:14px}
.knote-sidebar-actions-secondary{display:flex;align-items:center;justify-content:space-between;gap:5px;margin-top:11px}.knote-sidebar-view-switch{display:flex;padding:3px;background:color-mix(in srgb,currentColor 5%,transparent);border-radius:8px}.knote-sidebar-view-switch button{padding:4px 7px;font-size:11px;opacity:.6}.knote-sidebar-view-switch .active{background:var(--color-base-100,#fff);color:#638f30;box-shadow:0 1px 3px #22301512;opacity:1;font-weight:600}.knote-sidebar-preferences{display:flex;gap:7px}.knote-sidebar-preferences button{display:flex;align-items:center;gap:4px;font-size:11px;opacity:.6}.knote-sidebar-preferences small{font-size:9px;opacity:.65}.knote-sidebar-preferences svg{width:13px;height:13px}
.knote-sidebar-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));padding:10px 5px;border-top:1px solid color-mix(in srgb,currentColor 6%,transparent);background:color-mix(in srgb,currentColor 1%,transparent)}.knote-sidebar-stats>div{display:flex;justify-content:center;align-items:baseline;gap:4px;min-width:0}.knote-sidebar-stats>div+div{border-left:1px solid color-mix(in srgb,currentColor 8%,transparent)}.knote-sidebar-stats b{font-size:12px;font-variant-numeric:tabular-nums;font-weight:600;overflow-wrap:anywhere}.knote-sidebar-stats span{font-size:10px;opacity:.45;white-space:nowrap}
@container(max-width:270px){.knote-sidebar-actions-body{padding:9px}.knote-sidebar-preferences{gap:5px}.knote-sidebar-preferences svg{display:none}.knote-sidebar-view-switch button{padding:4px 5px}.knote-sidebar-stats>div{flex-direction:column;align-items:center;gap:0}.knote-sidebar-stats b{font-size:11px}}
</style>

<script setup>
defineProps({ enabled: Boolean, label: String, hint: String, testId: { type: String, default: 'custom-cursor-toggle' } })
defineEmits(['toggle'])
</script>

<template>
  <li>
    <a :data-testid="testId" class="flex items-center gap-2 text-xs" role="menuitemcheckbox" tabindex="0" :aria-checked="enabled" :title="hint" @click="$emit('toggle')" @keydown.enter.space.prevent="$emit('toggle')">
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 3 14 11-6 1 3 6-4 1-3-6-4 4z"/></svg>
      <span class="flex-1">{{ label }}</span>
      <svg v-if="enabled" class="w-3.5 h-3.5 text-[#65a30d]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>
    </a>
  </li>
</template>

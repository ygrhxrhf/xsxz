<script setup lang="ts">
import { NAlert, NButton, NModal, NSpace } from 'naive-ui'
import type { AiBudgetEstimate } from '@shared/types'

defineProps<{ show: boolean; budget: AiBudgetEstimate | null; loading?: boolean; message?: string }>()
const emit = defineEmits<{ (event: 'confirm'): void; (event: 'cancel'): void }>()
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="确认发送范围"
    style="width:min(560px, calc(100vw - 32px))"
    :mask-closable="false"
    :close-on-esc="false"
    :closable="false"
  >
    <n-space v-if="budget" vertical :size="14">
      <n-alert type="warning">{{ message || '内容超过单次发送预算，已准备缩减后的发送范围。' }}</n-alert>
      <div class="budget-summary">
        预计发送：{{ budget.chapterCount }} 章 / {{ budget.paragraphCount }} 段，约
        {{ budget.sentCharacters }} 字 / {{ budget.estimatedTokens }} tokens（估算）
      </div>
      <div class="budget-range">{{ budget.range }}</div>
      <div>{{ message ? '是否按上方预计发送范围继续？' : '预计输入超过 30000 字。是否按上方缩减范围继续？' }}</div>
      <n-space justify="end">
        <n-button :disabled="loading" @click="emit('cancel')">取消</n-button>
        <n-button type="primary" :loading="loading" @click="emit('confirm')">继续</n-button>
      </n-space>
    </n-space>
  </n-modal>
</template>

<style scoped>
.budget-summary {
  font-weight: 600;
  line-height: 1.7;
}

.budget-range {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--panel-soft, rgba(127, 127, 127, 0.1));
  line-height: 1.7;
}
</style>

<script setup lang="ts">
/**
 * Crafty 联动面板。
 *
 * 只推读书产物（概览、人物与伏笔、章节笔记、划线批注），书库正文不上传。
 * 令牌由本人从 Crafty 的「连接」页复制，只存本机（主进程 safeStorage 加密），
 * 这一屏永远拿不到明文，也永远不回显。
 */
import { onMounted, ref } from 'vue'
import { NAlert, NButton, NInput, NSpace, NTag, useMessage } from 'naive-ui'
import type { CraftState } from '@shared/types'
import { userFacingError, errorDetail } from '../userFacingError'

const message = useMessage()

const state = ref<CraftState>({ configured: false, endpoint: '', tokenConfigured: false })
const endpoint = ref('')
const token = ref('')
const saving = ref(false)
const error = ref('')
const errorTitle = ref('')

async function load() {
  error.value = ''
  try {
    const res = await window.api.craft.status()
    if (res.ok) {
      state.value = res.state
      if (!endpoint.value) endpoint.value = res.state.endpoint
    }
  } catch (e) {
    error.value = userFacingError(e, '读取 Crafty 连接状态失败，请稍后重试')
    errorTitle.value = errorDetail(e)
  }
}

async function save() {
  saving.value = true
  try {
    const res = await window.api.craft.configure({
      endpoint: endpoint.value.trim(),
      // 空着就是「不改令牌」；要清除走下面的按钮。
      token: token.value.trim() ? token.value.trim() : undefined,
    })
    if (!res.ok) {
      message.error(res.message || '保存失败')
      return
    }
    state.value = res.state
    token.value = ''
    message.success(res.state.configured ? '已保存，可以推送了' : '已保存，还差令牌或地址')
  } catch (e) {
    message.error(userFacingError(e, '保存失败'))
  } finally {
    saving.value = false
  }
}

async function clearToken() {
  const res = await window.api.craft.configure({ token: '' })
  if (!res.ok) {
    message.error(res.message || '清除失败')
    return
  }
  state.value = res.state
  message.success('已清除本机令牌')
}

onMounted(load)
</script>

<template>
  <n-space vertical :size="12">
    <n-alert type="info" :bordered="false">
      推送内容：全书概览、人物与伏笔、章节笔记、划线批注。<b>书库正文不会上传</b>，
      令牌只存本机（加密），Crafty 侧只有你复制过去的写入令牌。
    </n-alert>

    <n-alert v-if="error" type="error" :bordered="false" :title="errorTitle">{{ error }}</n-alert>

    <div class="craft-status">
      <span>连接状态：</span>
      <n-tag v-if="state.configured" type="success" size="small" :bordered="false">已连接</n-tag>
      <n-tag v-else-if="state.tokenUnreadable" type="warning" size="small" :bordered="false">
        令牌读不出来，请重新粘贴
      </n-tag>
      <n-tag v-else size="small" :bordered="false">未配置</n-tag>
      <span v-if="state.endpoint" class="craft-status__endpoint">{{ state.endpoint }}</span>
    </div>

    <n-input v-model:value="endpoint" placeholder="Crafty 地址，如 https://craft.example.com" />
    <n-input
      v-model:value="token"
      type="password"
      show-password-on="click"
      :placeholder="state.tokenConfigured ? '写入令牌已保存；换新的就粘贴在这里' : '写入令牌（Crafty 连接页「阅读笔记导入」）'"
    />

    <n-space>
      <n-button type="primary" :loading="saving" @click="save">保存</n-button>
      <n-button v-if="state.tokenConfigured" :disabled="saving" @click="clearToken">清除令牌</n-button>
    </n-space>

    <div class="craft-hint">
      在书库里点书卡的「⋯ → 推送到 Crafty」即可推送；再推同一本书会更新上次那篇，不会重复建。
    </div>
  </n-space>
</template>

<style scoped>
.craft-status {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.craft-status__endpoint {
  font-size: 12px;
  color: var(--text-muted);
}

.craft-hint {
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-muted);
}
</style>

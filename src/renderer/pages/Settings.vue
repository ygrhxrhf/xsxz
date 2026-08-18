<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NButton, NCard, NInput, NInputGroup, NInputGroupLabel, NSpace, NAlert } from 'naive-ui'
import type { Settings } from '@shared/types'

const settings = ref<Settings | null>(null)
const baseUrl = ref('')
const model = ref('')
const apiKey = ref('')
const libraryPath = ref('')
const saving = ref(false)
const msg = ref('')
const msgType = ref<'success' | 'error' | 'info'>('info')

async function load() {
  settings.value = await window.api.settings.get()
  baseUrl.value = settings.value.baseUrl
  model.value = settings.value.model
  libraryPath.value = settings.value.libraryPath
}

async function pickLibrary() {
  const { filePaths } = await window.api.dialog.openDirectory()
  if (filePaths?.[0]) libraryPath.value = filePaths[0]
}

async function save() {
  saving.value = true
  msg.value = ''
  try {
    const update: Record<string, unknown> = {
      baseUrl: baseUrl.value,
      model: model.value,
      libraryPath: libraryPath.value,
    }
    if (apiKey.value) {
      update.apiKey = apiKey.value
    }
    settings.value = await window.api.settings.set(update as import('@shared/types').SettingsUpdate)
    apiKey.value = ''
    libraryPath.value = settings.value.libraryPath
    msg.value = '设置已保存。书库路径立即生效，不会迁移旧目录里的书。' + (settings.value.apiKeyConfigured ? ' API Key 已加密存储。' : '')
    msgType.value = 'success'
  } catch (e: unknown) {
    msg.value = String(e)
    msgType.value = 'error'
  } finally {
    saving.value = false
  }
}

async function clearKey() {
  await window.api.settings.set({ apiKey: '' })
  settings.value = await window.api.settings.get()
  msg.value = 'API Key 已清除'
  msgType.value = 'info'
}

onMounted(load)
</script>

<template>
  <div class="page" style="max-width:600px">
    <h2>设置</h2>

    <n-card title="书库" style="margin-bottom:16px">
      <n-space vertical :size="12">
        <n-input-group>
          <n-input-group-label style="width:80px">书库路径</n-input-group-label>
          <n-input v-model:value="libraryPath" placeholder="D:\spbf\library" />
          <n-button @click="pickLibrary">选择目录</n-button>
        </n-input-group>
        <p style="color:#888;font-size:13px;margin:0">
          保存后立即使用新路径，不会把旧书拷过去。旧目录里的文件仍留在原处。
        </p>
        <n-button type="primary" :loading="saving" @click="save">保存路径</n-button>
      </n-space>
    </n-card>

    <n-card title="AI 配置" style="margin-bottom:16px">
      <n-alert v-if="settings?.apiKeyConfigured" type="success" style="margin-bottom:12px">
        API Key 已配置（安全存储）
      </n-alert>
      <n-alert v-else type="warning" style="margin-bottom:12px">
        未配置 API Key，AI 功能不可用
      </n-alert>

      <n-space vertical :size="12">
        <n-input-group>
          <n-input-group-label style="width:80px">接口地址</n-input-group-label>
          <n-input v-model:value="baseUrl" placeholder="https://api.deepseek.com/v1" />
        </n-input-group>
        <n-input-group>
          <n-input-group-label style="width:80px">模型名</n-input-group-label>
          <n-input v-model:value="model" placeholder="deepseek-chat" />
        </n-input-group>
        <n-input-group>
          <n-input-group-label style="width:80px">API Key</n-input-group-label>
          <n-input
            v-model:value="apiKey"
            type="password"
            show-password-on="click"
            placeholder="输入新的 API Key（留空则不更新）"
          />
        </n-input-group>
        <n-space>
          <n-button type="primary" :loading="saving" @click="save">保存</n-button>
          <n-button v-if="settings?.apiKeyConfigured" quaternary type="error" @click="clearKey">清除 Key</n-button>
        </n-space>
      </n-space>

      <div v-if="msg" :style="{ marginTop: '8px', color: msgType === 'error' ? '#e88080' : msgType === 'success' ? '#63e2b7' : '#888', fontSize: '13px' }">
        {{ msg }}
      </div>
    </n-card>

    <n-card title="阅读偏好" style="margin-bottom:16px">
      <p style="color:#888;font-size:13px">字体大小、行距、夜间模式请在阅读器中调整（实时保存）。</p>
    </n-card>

    <n-card title="关于">
      <p style="color:#888;font-size:13px">
        小说浏览器 v0.1.0 · 当前书库：{{ settings?.libraryPath }}<br>
        技术栈：Electron + Vue 3 + Naive UI
      </p>
    </n-card>
  </div>
</template>

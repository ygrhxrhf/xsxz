<script setup lang="ts">
/**
 * 账号与云同步面板。
 *
 * 账号只用于「把设置与站点规则同步到自己的云端」：书库正文、API Key、书签与批注都不上云。
 * 令牌由本人填写，只存在本机（主进程加密），不进同步数据包。
 */
import { onMounted, ref } from 'vue'
import { NAlert, NButton, NInput, NSpace, NTag, useMessage } from 'naive-ui'
import type { SyncAccountState, SyncResult } from '@shared/types'

const message = useMessage()

const state = ref<SyncAccountState>({ signedIn: false, account: '', endpoint: '' })
const token = ref('')
const endpoint = ref('')
const account = ref('')
const signingIn = ref(false)
const syncing = ref(false)
const result = ref<SyncResult | null>(null)
const error = ref('')

async function loadStatus() {
  error.value = ''
  try {
    const res = await window.api.sync.status()
    if (res.ok) state.value = res.state
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取登录状态失败'
  }
}

async function signIn() {
  const value = token.value.trim()
  if (!value) {
    message.error('请填写访问令牌')
    return
  }
  signingIn.value = true
  try {
    const res = await window.api.sync.signIn({
      token: value,
      endpoint: endpoint.value.trim() || undefined,
      account: account.value.trim() || undefined,
    })
    if (!res.ok) {
      message.error(res.message || '登录失败')
      return
    }
    state.value = res.state
    token.value = ''
    message.success('已登录')
  } finally {
    signingIn.value = false
  }
}

async function signOut() {
  const res = await window.api.sync.signOut()
  if (!res.ok) {
    message.error(res.message || '退出失败')
    return
  }
  state.value = res.state
  result.value = null
  message.success('已退出，云端已存的数据不动')
}

async function run() {
  syncing.value = true
  try {
    const res = await window.api.sync.run()
    if (!res.ok) {
      result.value = null
      message.error(res.message || '同步失败')
      return
    }
    result.value = res.result
    message.success('同步完成')
  } finally {
    syncing.value = false
  }
}

onMounted(loadStatus)
</script>

<template>
  <n-space vertical :size="12">
    <n-alert type="info" :bordered="false">
      同步内容只有设置与站点规则；书库正文、API Key、书签与批注都不上云。令牌只存在本机，不进同步数据包。
    </n-alert>

    <n-alert v-if="error" type="error" :bordered="false">{{ error }}</n-alert>

    <div class="sync-status">
      <span>登录状态：</span>
      <n-tag v-if="state.signedIn" type="success" size="small" :bordered="false">已登录</n-tag>
      <n-tag v-else size="small" :bordered="false">未登录</n-tag>
      <span v-if="state.account" class="sync-status__account">{{ state.account }}</span>
      <span v-if="state.endpoint" class="sync-status__endpoint">{{ state.endpoint }}</span>
    </div>

    <template v-if="!state.signedIn">
      <n-input
        v-model:value="token"
        type="password"
        show-password-on="click"
        placeholder="访问令牌（只存在本机）"
      />
      <n-input v-model:value="account" placeholder="账号标识（邮箱或用户名，可留空）" />
      <n-input v-model:value="endpoint" placeholder="同步端点（可留空，用默认端点）" />
      <n-button type="primary" :loading="signingIn" @click="signIn">登录</n-button>
    </template>

    <template v-else>
      <n-space>
        <n-button type="primary" :loading="syncing" @click="run">立即同步</n-button>
        <n-button :loading="signingIn" @click="signOut">退出登录</n-button>
      </n-space>
    </template>

    <div v-if="result" class="sync-result">
      <div>上次同步：{{ result.updatedAt }}</div>
      <div>上传 {{ result.pushed }} 条 · 拉回 {{ result.pulled }} 条</div>
      <div v-if="result.message" class="sync-result__message">{{ result.message }}</div>
    </div>
  </n-space>
</template>

<style scoped>
.sync-status {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.sync-status__account {
  font-size: 13px;
}

.sync-status__endpoint {
  font-size: 12px;
  color: var(--text-muted);
}

.sync-result {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--panel-soft, rgba(127, 127, 127, 0.1));
  line-height: 1.8;
  font-size: 13px;
}

.sync-result__message {
  color: var(--text-muted);
}
</style>

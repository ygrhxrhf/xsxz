<script setup lang="ts">
/**
 * 站点 CSS 选择器市场面板。
 *
 * 市场的条目只含 CSS 选择器，不含任何凭据；应用一条规则就是把它写进本机
 * 站点规则（整条替换同 host 的本机规则）。
 */
import { onMounted, ref } from 'vue'
import { NAlert, NButton, NEmpty, NInput, NSpace, NSpin, NTag, useMessage } from 'naive-ui'
import type { RuleMarketEntry, RuleMarketSource } from '@shared/types'
import { userFacingError, errorDetail } from '../userFacingError'

const message = useMessage()

const entries = ref<RuleMarketEntry[]>([])
const sources = ref<Record<string, RuleMarketSource>>({})
const loading = ref(false)
const applyingId = ref('')
const subscribeUrl = ref('')
const subscribing = ref(false)
const unsubscribingUrl = ref('')
const error = ref('')
const errorTitle = ref('')
/**
 * 已订阅的清单地址。
 *
 * 契约里没有「列出订阅来源」的频道，所以本面板只记住本次会话里订阅过的地址，
 * 供取消订阅用；重开应用后地址由主机的 `rule-market.json` 保留，重新订阅同址即可。
 */
const subscribedUrls = ref<string[]>([])

const SOURCE_LABELS: Record<RuleMarketSource, string> = {
  builtin: '内置',
  remote: '远端订阅',
  local: '本机自建',
}

const SOURCE_TYPES: Record<RuleMarketSource, 'default' | 'info' | 'success'> = {
  builtin: 'default',
  remote: 'info',
  local: 'success',
}

function sourceOf(entry: RuleMarketEntry): RuleMarketSource {
  return sources.value[entry.id] ?? 'remote'
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const listing = await window.api.ruleMarket.list()
    entries.value = listing.entries
    sources.value = listing.sources
    errorTitle.value = ''
  } catch (e) {
    error.value = userFacingError(e, '站点规则市场读取失败，请稍后重试')
    errorTitle.value = errorDetail(e)
  } finally {
    loading.value = false
  }
}

async function apply(entry: RuleMarketEntry) {
  applyingId.value = entry.id
  try {
    const res = await window.api.ruleMarket.apply({ id: entry.id })
    if (!res.ok) {
      message.error(res.message || '应用失败')
      return
    }
    message.success(`已应用到本机：${res.rule.host}`)
    await load()
  } finally {
    applyingId.value = ''
  }
}

async function subscribe() {
  const url = subscribeUrl.value.trim()
  if (!url) {
    message.error('请填写清单地址')
    return
  }
  subscribing.value = true
  try {
    const res = await window.api.ruleMarket.subscribe({ url })
    if (!res.ok) {
      message.error(res.message || '订阅失败')
      return
    }
    message.success(`已订阅，拉到 ${res.entries.length} 条规则`)
    if (!subscribedUrls.value.includes(url)) subscribedUrls.value = [...subscribedUrls.value, url]
    subscribeUrl.value = ''
    await load()
  } finally {
    subscribing.value = false
  }
}

async function unsubscribe(url: string) {
  unsubscribingUrl.value = url
  try {
    const res = await window.api.ruleMarket.unsubscribe({ url })
    if (!res.ok) {
      message.error(res.message || '取消订阅失败')
      return
    }
    message.success('已取消订阅')
    subscribedUrls.value = subscribedUrls.value.filter((item) => item !== url)
    await load()
  } finally {
    unsubscribingUrl.value = ''
  }
}

onMounted(load)
</script>

<template>
  <n-space vertical :size="12">
    <n-alert type="info" :bordered="false">
      市场里的规则只含 CSS 选择器，不含任何凭据。规则不一定有效，应用后可在「站点规则」里试运行验证。
    </n-alert>

    <n-space :size="8">
      <n-input
        v-model:value="subscribeUrl"
        placeholder="规则清单地址（http/https 绝对地址）"
        style="flex:1"
        @keyup.enter="subscribe"
      />
      <n-button type="primary" :loading="subscribing" @click="subscribe">订阅</n-button>
    </n-space>

    <n-alert v-if="error" type="error" :bordered="false" :title="errorTitle">{{ error }}</n-alert>

    <div v-if="subscribedUrls.length" class="market-subscriptions">
      <div class="market-subscriptions__title">已订阅的来源</div>
      <n-space vertical :size="6">
        <div v-for="url in subscribedUrls" :key="url" class="market-subscription">
          <span class="market-subscription__url">{{ url }}</span>
          <n-button
            size="small"
            :loading="unsubscribingUrl === url"
            @click="unsubscribe(url)"
          >
            取消订阅
          </n-button>
        </div>
      </n-space>
    </div>

    <n-spin :show="loading">
      <n-empty v-if="!entries.length" description="市场里还没有规则" style="padding: 24px 0" />
      <n-space v-else vertical :size="8">
        <div v-for="entry in entries" :key="entry.id" class="market-row">
          <div class="market-row__head">
            <strong>{{ entry.title }}</strong>
            <n-tag size="small" :type="SOURCE_TYPES[sourceOf(entry)]" :bordered="false">
              {{ SOURCE_LABELS[sourceOf(entry)] }}
            </n-tag>
            <span class="market-row__host">{{ entry.host }}</span>
            <n-button
              size="small"
              :loading="applyingId === entry.id"
              @click="apply(entry)"
            >
              应用到本机
            </n-button>
          </div>
          <div v-if="entry.note" class="market-row__note">{{ entry.note }}</div>
          <div class="market-row__meta">
            <span v-if="entry.updatedAt">更新于 {{ entry.updatedAt }}</span>
            <span v-if="entry.uses">{{ entry.uses }} 人使用</span>
          </div>
        </div>
      </n-space>
    </n-spin>
  </n-space>
</template>

<style scoped>
.market-row {
  padding: 10px 12px;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.2));
  border-radius: 8px;
}

.market-row__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.market-row__host {
  color: var(--text-muted);
  font-size: 12px;
}

.market-subscriptions__title {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.market-subscription {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.market-subscription__url {
  font-size: 12px;
  color: var(--text-muted);
  word-break: break-all;
}

.market-row__note {
  margin-top: 4px;
  font-size: 13px;
  color: var(--text-secondary);
}

.market-row__meta {
  margin-top: 4px;
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--text-muted);
}
</style>

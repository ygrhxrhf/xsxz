<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NAlert, NButton, NInputNumber, NSpace, NSwitch, useMessage } from 'naive-ui'
import type { ProxyAutoUpdatePrefs, ProxySpeedTestResult, ProxySubscriptionState } from '@shared/types'

/**
 * 订阅面板：自动更新开关 + 间隔 + 立即重拉 + 多节点测速。
 *
 * 两处刻意的克制：
 * - 面板**不提供「自动换节点」**：换节点要重启内置内核，会掐断在途下载，
 *   所以自动更新只让节点列表保持新鲜，动手换节点仍然由本人来。
 * - 测速只报数，不切节点。
 */
const emit = defineEmits<{ (event: 'refreshed', overview: ProxySubscriptionState): void }>()

const message = useMessage()

const prefs = ref<ProxyAutoUpdatePrefs>({ enabled: false, intervalMinutes: 60, lastUpdatedAt: '', lastError: '' })
const intervalMinutes = ref<number>(60)
const loading = ref(false)
const refreshing = ref(false)
const speedTesting = ref(false)
const speedResult = ref<ProxySpeedTestResult | null>(null)
const errorText = ref('')

/** 测速结果按延迟升序排，最快的排前面；失败的排最后。 */
const sortedNodes = computed(() => {
  const nodes = speedResult.value?.nodes ?? []
  return [...nodes].sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1
    return a.latencyMs - b.latencyMs
  })
})

function formatTime(iso: string): string {
  if (!iso) return '从未成功重拉'
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) return '从未成功重拉'
  return new Date(parsed).toLocaleString()
}

async function loadPrefs(): Promise<void> {
  try {
    const res = await window.api.proxy.autoUpdateState()
    if (res.ok) {
      prefs.value = res.prefs
      intervalMinutes.value = res.prefs.intervalMinutes
    }
  } catch (e) {
    errorText.value = e instanceof Error ? e.message : '读取订阅自动更新状态失败'
  }
}

async function savePrefs(): Promise<void> {
  loading.value = true
  errorText.value = ''
  try {
    const res = await window.api.proxy.setAutoUpdate({
      enabled: prefs.value.enabled,
      intervalMinutes: intervalMinutes.value,
    })
    if (!res.ok) {
      errorText.value = res.message
      return
    }
    prefs.value = res.prefs
    intervalMinutes.value = res.prefs.intervalMinutes
    message.success(res.prefs.enabled ? '已开启定时重拉订阅' : '已关闭定时重拉订阅')
  } catch (e) {
    errorText.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    loading.value = false
  }
}

async function refreshNow(): Promise<void> {
  refreshing.value = true
  errorText.value = ''
  try {
    const res = await window.api.proxy.refreshSubscription()
    if (!res.ok) {
      errorText.value = res.message
      return
    }
    prefs.value = res.prefs
    message.success(`已重拉订阅，共 ${res.overview.total} 个节点`)
    emit('refreshed', res.overview)
  } catch (e) {
    errorText.value = e instanceof Error ? e.message : '重拉订阅失败'
  } finally {
    refreshing.value = false
  }
}

async function runSpeedTest(): Promise<void> {
  speedTesting.value = true
  errorText.value = ''
  try {
    const res = await window.api.proxy.speedTest()
    if (!res.ok) {
      errorText.value = res.message
      return
    }
    speedResult.value = res.result
    if (res.result.succeeded === 0) {
      message.warning('没有节点测速成功')
    } else {
      const fastest = res.result.nodes.find((node) => node.index === res.result.fastestIndex)
      message.success(`最快节点：${fastest?.name ?? '未知'}（${fastest?.latencyMs ?? 0} ms）`)
    }
  } catch (e) {
    errorText.value = e instanceof Error ? e.message : '测速失败'
  } finally {
    speedTesting.value = false
  }
}

onMounted(() => {
  void loadPrefs()
})
</script>

<template>
  <div class="proxy-subscription-panel">
    <n-space vertical :size="14">
      <div class="panel-row">
        <div class="panel-row__label">
          <div class="field-label">定时重拉订阅</div>
          <div class="field-help">
            定期把订阅正文重新拉一遍，让节点列表保持新鲜。自动更新不会换节点——
            换节点要重启内核，会掐断正在进行的下载，所以仍由本人切换。
          </div>
        </div>
        <n-switch v-model:value="prefs.enabled" :disabled="loading" @update:value="savePrefs" />
      </div>

      <div class="panel-row">
        <div class="panel-row__label">
          <div class="field-label">重拉间隔</div>
          <div class="field-help">分钟数，1–1440；非法值回退到 60。</div>
        </div>
        <n-input-number
          v-model:value="intervalMinutes"
          :min="1"
          :max="1440"
          :show-button="false"
          :disabled="loading"
          style="width:120px"
          @blur="savePrefs"
        />
      </div>

      <div class="panel-row">
        <div class="panel-row__label">
          <div class="field-label">上次结果</div>
          <div class="field-help">成功时间：{{ formatTime(prefs.lastUpdatedAt) }}</div>
        </div>
        <n-button :loading="refreshing" @click="refreshNow">立即重拉</n-button>
      </div>

      <n-alert v-if="prefs.lastError" type="error" :show-icon="false">
        上次重拉失败：{{ prefs.lastError }}
      </n-alert>
      <n-alert v-if="errorText" type="error" :show-icon="false">{{ errorText }}</n-alert>

      <div class="panel-row">
        <div class="panel-row__label">
          <div class="field-label">多节点测速</div>
          <div class="field-help">
            并发探测各节点的连接延迟。测速只报数，不切换当前节点。
          </div>
        </div>
        <n-button :loading="speedTesting" @click="runSpeedTest">开始测速</n-button>
      </div>

      <div v-if="speedResult" class="speed-list">
        <div class="speed-summary">
          成功 {{ speedResult.succeeded }} / {{ speedResult.total }} 个节点
          <template v-if="speedResult.fastestIndex >= 0">
            ，最快是第 {{ speedResult.fastestIndex + 1 }} 个节点
          </template>
        </div>
        <div v-for="node in sortedNodes" :key="node.index" class="speed-row">
          <span class="speed-name">{{ node.index + 1 }}. {{ node.name }}</span>
          <span class="speed-proto">{{ node.protocol }}</span>
          <span v-if="node.ok" class="speed-value">{{ node.latencyMs }} ms</span>
          <span v-else class="speed-value speed-value--bad">{{ node.message }}</span>
        </div>
      </div>
    </n-space>
  </div>
</template>

<style scoped>
.proxy-subscription-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.panel-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.panel-row__label {
  flex: 1;
  min-width: 0;
}

.speed-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 12px;
  border-radius: 8px;
  background: var(--panel-soft, rgba(127, 127, 127, 0.1));
}

.speed-summary {
  font-weight: 600;
}

.speed-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  font-size: 13px;
}

.speed-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.speed-proto {
  color: var(--text-muted);
}

.speed-value {
  font-variant-numeric: tabular-nums;
}

.speed-value--bad {
  color: var(--warning-text, var(--text-muted));
}
</style>

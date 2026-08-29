<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  NButton,
  NCard,
  NInput,
  NInputGroup,
  NInputGroupLabel,
  NSpace,
  NAlert,
  NEmpty,
  NPopconfirm,
  NRadio,
  NRadioGroup,
  NSwitch,
  NTag,
  NModal,
} from 'naive-ui'
import type { AiProvider, Settings, SiteRule, Skin } from '@shared/types'
import { DEFAULT_AI_PREFS } from '@shared/types'
import {
  AI_CUSTOM_SERVICE_NOTICE,
  customOriginNeedsConfirmation,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_RECOMMENDED_MODEL,
  inferAiProvider,
  isLegacyDeepSeekModelName,
  isOfficialDeepSeekUrl,
  normalizeAiServiceOrigin,
} from '../aiSettings'

const props = defineProps<{ active?: boolean; prefillHost?: string; prefillNonce?: number; skin?: Skin }>()

const emit = defineEmits<{
  (e: 'change-skin', skin: Skin): void
}>()

const skinOptions: { id: Skin; name: string; desc: string; mark: string }[] = [
  { id: 'sakura', name: '夜樱', desc: '深色 · 樱粉 × 紫罗兰', mark: '🌸' },
  { id: 'minimal', name: '简约', desc: '浅色 · 中性克制', mark: '📘' },
]

const settings = ref<Settings | null>(null)
const baseUrl = ref('')
const model = ref('')
const apiKey = ref('')
const provider = ref<AiProvider>('deepseek')
const thinkingEnabled = ref(true)
const trustedCustomOrigins = ref<string[]>([])
const libraryPath = ref('')
const saving = ref(false)
const testing = ref(false)
const msg = ref('')
const msgType = ref<'success' | 'error' | 'info'>('info')
const trustModalVisible = ref(false)
const pendingTrustOrigin = ref('')
let resolveTrust: ((accepted: boolean) => void) | null = null

const legacyModelWarning = computed(() => provider.value === 'deepseek' && isLegacyDeepSeekModelName(model.value))
const usesCustomEndpoint = computed(() => provider.value === 'custom' || !isOfficialDeepSeekUrl(baseUrl.value))

const rules = ref<SiteRule[]>([])
const ruleHost = ref('')
const ruleTitle = ref('')
const ruleAuthor = ref('')
const ruleCatalog = ref('')
const ruleBody = ref('')
const ruleSaving = ref(false)
const ruleMsg = ref('')
const ruleMsgType = ref<'success' | 'error' | 'info'>('info')

function previewField(label: string, value?: string): string {
  const v = (value ?? '').trim()
  return `${label} ${v || '（空）'}`
}

function previewRule(rule: SiteRule): string {
  return [
    previewField('书名', rule.title),
    previewField('作者', rule.author),
    previewField('目录', rule.catalog),
    previewField('正文', rule.body),
  ].join(' · ')
}

function fillRuleForm(rule: SiteRule) {
  ruleHost.value = rule.host
  ruleTitle.value = rule.title ?? ''
  ruleAuthor.value = rule.author ?? ''
  ruleCatalog.value = rule.catalog ?? ''
  ruleBody.value = rule.body ?? ''
}

async function loadRules() {
  const res = await window.api.siteRules.list()
  rules.value = res.rules
}

async function load() {
  settings.value = await window.api.settings.get()
  baseUrl.value = settings.value.baseUrl
  model.value = settings.value.model
  const ai = settings.value.ai ?? DEFAULT_AI_PREFS
  provider.value = inferAiProvider(settings.value.baseUrl, ai.provider)
  thinkingEnabled.value = ai.thinkingEnabled
  trustedCustomOrigins.value = [...ai.trustedCustomOrigins]
  libraryPath.value = settings.value.libraryPath
  await loadRules()
}

async function pickLibrary() {
  const { filePaths } = await window.api.dialog.openDirectory()
  if (filePaths?.[0]) libraryPath.value = filePaths[0]
}

function settleTrust(accepted: boolean) {
  trustModalVisible.value = false
  const resolver = resolveTrust
  resolveTrust = null
  resolver?.(accepted)
}

function requestTrust(origin: string): Promise<boolean> {
  settleTrust(false)
  pendingTrustOrigin.value = origin
  trustModalVisible.value = true
  return new Promise((resolve) => { resolveTrust = resolve })
}

async function trustedOriginsForCurrentForm(): Promise<string[] | null> {
  const origin = normalizeAiServiceOrigin(baseUrl.value)
  if (!origin) {
    msg.value = '接口地址仅支持有效的 HTTP(S) 地址'
    msgType.value = 'error'
    return null
  }
  const pending = customOriginNeedsConfirmation(
    provider.value,
    baseUrl.value,
    trustedCustomOrigins.value,
  )
  if (pending && !await requestTrust(pending)) return null
  return pending
    ? [...new Set([...trustedCustomOrigins.value, pending])]
    : [...trustedCustomOrigins.value]
}

function changeProvider(next: AiProvider) {
  provider.value = next
  if (next === 'deepseek') {
    baseUrl.value = DEEPSEEK_BASE_URL
    model.value = DEEPSEEK_RECOMMENDED_MODEL
  }
}

async function saveLibrary() {
  saving.value = true
  msg.value = ''
  try {
    settings.value = await window.api.settings.set({ libraryPath: libraryPath.value })
    libraryPath.value = settings.value.libraryPath
    msg.value = '书库路径已保存。新路径立即生效，不会迁移旧目录里的书。'
    msgType.value = 'success'
  } catch (e: unknown) {
    msg.value = String(e)
    msgType.value = 'error'
  } finally {
    saving.value = false
  }
}

async function saveAi(): Promise<boolean> {
  msg.value = ''
  const trustedOrigins = await trustedOriginsForCurrentForm()
  if (!trustedOrigins) return false
  saving.value = true
  try {
    const update: import('@shared/types').SettingsUpdate = {
      baseUrl: baseUrl.value.trim(),
      model: model.value.trim(),
      ai: {
        provider: provider.value,
        thinkingEnabled: thinkingEnabled.value,
        trustedCustomOrigins: trustedOrigins,
      },
    }
    if (apiKey.value) update.apiKey = apiKey.value
    settings.value = await window.api.settings.set(update)
    apiKey.value = ''
    trustedCustomOrigins.value = [...(settings.value.ai ?? DEFAULT_AI_PREFS).trustedCustomOrigins]
    msg.value = 'AI 设置已保存。' + (settings.value.apiKeyConfigured ? ' API Key 已加密存储。' : '')
    msgType.value = 'success'
    return true
  } catch (e: unknown) {
    msg.value = String(e)
    msgType.value = 'error'
    return false
  } finally {
    saving.value = false
  }
}

async function migrateLegacyModel() {
  provider.value = 'deepseek'
  baseUrl.value = DEEPSEEK_BASE_URL
  model.value = DEEPSEEK_RECOMMENDED_MODEL
  if (await saveAi()) msg.value = '模型已改为 deepseek-v4-flash'
}

async function clearKey() {
  await window.api.settings.set({ apiKey: '' })
  settings.value = await window.api.settings.get()
  msg.value = 'API Key 已清除'
  msgType.value = 'info'
}

async function testAi() {
  msg.value = ''
  const trustedOrigins = await trustedOriginsForCurrentForm()
  if (!trustedOrigins) return
  testing.value = true
  try {
    if (trustedOrigins.length !== trustedCustomOrigins.value.length) {
      settings.value = await window.api.settings.set({ ai: { trustedCustomOrigins: trustedOrigins } })
      trustedCustomOrigins.value = [...trustedOrigins]
    }
    const res = await window.api.ai.test({
      baseUrl: baseUrl.value,
      model: model.value,
      apiKey: apiKey.value || undefined,
      provider: provider.value,
      thinkingEnabled: thinkingEnabled.value,
    })
    if (res.ok) {
      msg.value = '连接成功'
      msgType.value = 'success'
    } else {
      msg.value = res.message || '连接失败'
      msgType.value = 'error'
    }
  } catch (e: unknown) {
    msg.value = String(e)
    msgType.value = 'error'
  } finally {
    testing.value = false
  }
}

onBeforeUnmount(() => settleTrust(false))

async function saveRule() {
  const host = ruleHost.value.trim()
  if (!host) {
    ruleMsg.value = '请填写域名'
    ruleMsgType.value = 'error'
    return
  }
  ruleSaving.value = true
  ruleMsg.value = ''
  try {
    const res = await window.api.siteRules.upsert({
      host,
      title: ruleTitle.value,
      author: ruleAuthor.value,
      catalog: ruleCatalog.value,
      body: ruleBody.value,
    })
    if (!res.ok) {
      ruleMsg.value = res.message || '保存失败'
      ruleMsgType.value = 'error'
      return
    }
    fillRuleForm(res.rule)
    await loadRules()
    ruleMsg.value = `规则已保存：${res.rule.host}`
    ruleMsgType.value = 'success'
  } catch (e: unknown) {
    ruleMsg.value = String(e)
    ruleMsgType.value = 'error'
  } finally {
    ruleSaving.value = false
  }
}

async function removeRule(host: string) {
  const target = host.trim()
  if (!target) {
    ruleMsg.value = '请填写域名'
    ruleMsgType.value = 'error'
    return
  }
  try {
    const res = await window.api.siteRules.remove(target)
    if (!res.ok) {
      ruleMsg.value = res.message || '删除失败'
      ruleMsgType.value = 'error'
      return
    }
    await loadRules()
    const typed = ruleHost.value.trim().toLowerCase().replace(/^www\./, '')
    if (typed === target.toLowerCase()) {
      ruleHost.value = ''
      ruleTitle.value = ''
      ruleAuthor.value = ''
      ruleCatalog.value = ''
      ruleBody.value = ''
    }
    ruleMsg.value = '规则已删除'
    ruleMsgType.value = 'info'
  } catch (e: unknown) {
    ruleMsg.value = String(e)
    ruleMsgType.value = 'error'
  }
}

function removeCurrentRule() {
  return removeRule(ruleHost.value)
}

// 备份与恢复
const backingUp = ref(false)
const restoring = ref(false)

async function handleBackup() {
  const { filePaths } = await window.api.dialog.openDirectory()
  const dest = filePaths?.[0]
  if (!dest) return
  backingUp.value = true
  try {
    const res = await window.api.backup.create(dest)
    if (res.ok) msg.value = `已备份到 ${res.path}`
    else {
      msg.value = res.message || '备份失败'
      msgType.value = 'error'
    }
  } finally {
    backingUp.value = false
  }
}

async function handleRestore() {
  const { filePaths } = await window.api.dialog.openZip()
  const zipPath = filePaths?.[0]
  if (!zipPath) return
  if (!window.confirm('恢复会清空当前书库，再用备份文件覆盖。确定继续吗？')) return
  restoring.value = true
  try {
    const res = await window.api.backup.restore(zipPath)
    if (res.ok) {
      msg.value = `已从备份恢复 ${res.books} 本书`
      msgType.value = 'success'
      settings.value = await window.api.settings.get()
    } else {
      msg.value = res.message || '恢复失败'
      msgType.value = 'error'
    }
  } finally {
    restoring.value = false
  }
}

watch(
  () => props.active,
  (active) => {
    if (active) void load()
  },
)

watch(
  () => props.prefillNonce,
  () => {
    if (props.prefillHost) ruleHost.value = props.prefillHost
  },
)

onMounted(load)
</script>

<template>
  <div class="page" style="max-width:600px">
    <h2>设置</h2>

    <n-card title="外观" style="margin-bottom:16px">
      <div class="skin-grid">
        <button
          v-for="s in skinOptions"
          :key="s.id"
          type="button"
          class="skin-card"
          :class="{ active: skin === s.id }"
          @click="emit('change-skin', s.id)"
        >
          <span class="skin-swatch" :class="s.id">
            <span class="sw-dot d1"></span>
            <span class="sw-dot d2"></span>
            <span class="sw-dot d3"></span>
          </span>
          <span class="skin-name">
            {{ s.mark }} {{ s.name }}
            <span v-if="skin === s.id" class="skin-current">✓ 使用中</span>
          </span>
          <span class="skin-desc">{{ s.desc }}</span>
        </button>
      </div>
    </n-card>

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
        <n-button type="primary" :loading="saving" @click="saveLibrary">保存路径</n-button>
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
        <div>
          <div class="field-label">模型服务</div>
          <n-radio-group :value="provider" @update:value="changeProvider">
            <n-space>
              <n-radio value="deepseek">DeepSeek 官方</n-radio>
              <n-radio value="custom">自定义兼容服务</n-radio>
            </n-space>
          </n-radio-group>
        </div>
        <n-input-group>
          <n-input-group-label style="width:80px">接口地址</n-input-group-label>
          <n-input v-model:value="baseUrl" placeholder="https://api.deepseek.com/v1" />
        </n-input-group>
        <n-input-group>
          <n-input-group-label style="width:80px">模型名</n-input-group-label>
          <n-input v-model:value="model" placeholder="deepseek-v4-flash" />
        </n-input-group>
        <n-alert v-if="legacyModelWarning" type="warning">
          <n-space vertical :size="8">
            <span>当前模型名 {{ model }} 可能已停用。DeepSeek 官方当前推荐使用 deepseek-v4-flash。</span>
            <n-button size="small" @click="migrateLegacyModel">改用 deepseek-v4-flash</n-button>
          </n-space>
        </n-alert>
        <n-input-group>
          <n-input-group-label style="width:80px">API Key</n-input-group-label>
          <n-input
            v-model:value="apiKey"
            type="password"
            show-password-on="click"
            placeholder="输入新的 API Key（留空则不更新）"
          />
        </n-input-group>
        <div class="switch-row">
          <div>
            <div class="field-label">复杂任务使用思考模式</div>
            <div class="field-help">人物、前情和证据问答使用思考模式；翻译、清正文和摘要使用快速模式。</div>
          </div>
          <n-switch v-model:value="thinkingEnabled" />
        </div>
        <n-alert v-if="usesCustomEndpoint" type="warning">
          {{ AI_CUSTOM_SERVICE_NOTICE }}
        </n-alert>
        <n-space>
          <n-button type="primary" :loading="saving" @click="saveAi">保存</n-button>
          <n-button :loading="testing" @click="testAi">测试连接</n-button>
          <n-button v-if="settings?.apiKeyConfigured" quaternary type="error" @click="clearKey">清除 Key</n-button>
        </n-space>
      </n-space>

      <div v-if="msg" class="form-msg" :class="msgType">{{ msg }}</div>
    </n-card>

    <n-card title="站点规则" style="margin-bottom:16px">
      <p style="color:#888;font-size:13px;margin:0 0 12px">
        按域名配置四条可选 CSS。保存时不检查选择器是否合法。空选择器走通用提取。
      </p>
      <n-space vertical :size="12">
        <n-input-group>
          <n-input-group-label style="width:110px">域名</n-input-group-label>
          <n-input v-model:value="ruleHost" placeholder="example.com 或 https://www.example.com/path" />
        </n-input-group>
        <n-input-group>
          <n-input-group-label style="width:110px">书名选择器</n-input-group-label>
          <n-input v-model:value="ruleTitle" placeholder="可选，空则走通用提取" />
        </n-input-group>
        <n-input-group>
          <n-input-group-label style="width:110px">作者选择器</n-input-group-label>
          <n-input v-model:value="ruleAuthor" placeholder="可选，空则走通用提取" />
        </n-input-group>
        <n-input-group>
          <n-input-group-label style="width:110px">目录选择器</n-input-group-label>
          <n-input v-model:value="ruleCatalog" placeholder="可选，空则走通用提取" />
        </n-input-group>
        <n-input-group>
          <n-input-group-label style="width:110px">正文选择器</n-input-group-label>
          <n-input v-model:value="ruleBody" placeholder="可选，空则走通用提取" />
        </n-input-group>
        <n-space>
          <n-button type="primary" :loading="ruleSaving" @click="saveRule">保存</n-button>
          <n-popconfirm @positive-click="removeCurrentRule">
            <template #trigger>
              <n-button quaternary type="error">删除</n-button>
            </template>
            确认删除该站点规则？
          </n-popconfirm>
        </n-space>
        <div v-if="ruleMsg" class="form-msg" :class="ruleMsgType">{{ ruleMsg }}</div>
      </n-space>

      <div class="rule-list">
        <n-empty v-if="!rules.length" description="还没有站点规则" />
        <div v-for="r in rules" :key="r.host" class="rule-row">
          <button type="button" class="rule-row-main" @click="fillRuleForm(r)">
            <div class="rule-host">
              <n-tag size="small" type="info">{{ r.host }}</n-tag>
            </div>
            <div class="rule-preview">{{ previewRule(r) }}</div>
          </button>
          <n-popconfirm @positive-click="removeRule(r.host)">
            <template #trigger>
              <n-button size="tiny" quaternary type="error" @click.stop>删除</n-button>
            </template>
            确认删除 {{ r.host }} 的站点规则？
          </n-popconfirm>
        </div>
      </div>
    </n-card>

    <n-card title="备份与恢复" style="margin-bottom:16px">
      <p style="color:#888;font-size:13px;margin:0 0 12px">
        备份把整个书库（不含回收站）打包成 zip 存到你选的文件夹。恢复是整库覆盖：会先清空当前书库再导入备份。
      </p>
      <n-space>
        <n-button :loading="backingUp" @click="handleBackup">备份书库…</n-button>
        <n-button type="warning" :loading="restoring" @click="handleRestore">从备份恢复…</n-button>
      </n-space>
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

    <n-modal
      :show="trustModalVisible"
      preset="card"
      title="确认自定义模型服务"
      style="width:min(520px, calc(100vw - 32px))"
      :mask-closable="false"
      :close-on-esc="false"
      :closable="false"
    >
      <p style="margin:0 0 16px;line-height:1.7">
        本次请求会把 API Key 和所示正文内容发送到 {{ pendingTrustOrigin }}。确定信任并继续吗？
      </p>
      <n-space justify="end">
        <n-button @click="settleTrust(false)">取消</n-button>
        <n-button type="primary" @click="settleTrust(true)">信任并继续</n-button>
      </n-space>
    </n-modal>
  </div>
</template>

<style scoped>
.field-label {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}

.field-help {
  color: #888;
  font-size: 12px;
  line-height: 1.5;
}

.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.skin-grid {
  display: flex;
  gap: 12px;
}

.skin-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
  text-align: left;
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 12px;
  padding: 12px;
  cursor: pointer;
  color: inherit;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}

.skin-card:hover {
  border-color: var(--hover-line);
  transform: translateY(-2px);
}

.skin-card.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent);
}

.skin-swatch {
  width: 100%;
  height: 44px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.skin-swatch.sakura {
  background: linear-gradient(135deg, #ff8ec7, #a78bfa);
}

.skin-swatch.minimal {
  background: #f2f3f6;
  border: 1px solid #e4e5ec;
}

.sw-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.sakura .d1 {
  background: #fff;
}

.sakura .d2 {
  background: #ffd7ea;
}

.sakura .d3 {
  background: #43315c;
}

.minimal .d1 {
  background: #5e6f9e;
}

.minimal .d2 {
  background: #c9cede;
}

.minimal .d3 {
  background: #26262e;
}

.skin-name {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}

.skin-current {
  font-size: 11px;
  color: var(--success);
  font-weight: 500;
}

.skin-desc {
  font-size: 11px;
  color: var(--muted);
}

.form-msg {
  margin-top: 8px;
  font-size: 13px;
}

.form-msg.success {
  color: var(--success);
}

.form-msg.error {
  color: var(--danger);
}

.form-msg.info {
  color: var(--muted);
}

.rule-list {
  margin-top: 16px;
}

.rule-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 8px;
}

.rule-row:hover {
  border-color: var(--hover-line);
}

.rule-row-main {
  flex: 1;
  display: block;
  text-align: left;
  background: transparent;
  border: 0;
  padding: 0;
  cursor: pointer;
  color: inherit;
}

.rule-host {
  margin-bottom: 6px;
}

.rule-preview {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}
</style>

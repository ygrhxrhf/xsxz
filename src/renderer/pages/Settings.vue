<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  NButton,
  NCard,
  NInput,
  NInputNumber,
  NInputGroup,
  NInputGroupLabel,
  NSpace,
  NAlert,
  NEmpty,
  NPopconfirm,
  NRadio,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSwitch,
  NTag,
  NModal,
  NSpin,
  useMessage,
} from 'naive-ui'
import type { AiPromptKind, AiPromptMode, AiProvider, DownloadPace, Settings, SiteRule, SiteRulePreview, Skin } from '@shared/types'
import { AI_PROMPT_KINDS, DEFAULT_AI_PREFS } from '@shared/types'
import { AI_PROMPT_LABELS, BUILTIN_AI_PROMPTS } from '@shared/aiPrompts'
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
const message = useMessage()
const rulePreview = ref<SiteRulePreview | null>(null)
const rulePreviewing = ref(false)
type SettingsSection = 'appearance' | 'library' | 'tts' | 'ai' | 'siteRules' | 'backup' | 'about'
const activeSection = ref<SettingsSection>('appearance')
const settingsLoading = ref(true)
const sectionOptions: { id: SettingsSection; label: string }[] = [
  { id: 'appearance', label: '外观' },
  { id: 'library', label: '书库' },
  { id: 'tts', label: '听书' },
  { id: 'ai', label: 'AI' },
  { id: 'siteRules', label: '站点规则' },
  { id: 'backup', label: '备份与恢复' },
  { id: 'about', label: '关于' },
]

const skinOptions: { id: Skin; name: string; desc: string }[] = [
  { id: 'paper', name: '暖纸', desc: '米白纸面 · 长时间阅读' },
  { id: 'white', name: '白纸', desc: '浅色 · 中性克制' },
  { id: 'night', name: '夜间', desc: '深色 · 弱光阅读' },
]

const settings = ref<Settings | null>(null)
const baseUrl = ref('')
const model = ref('')
const apiKey = ref('')
const ttsEndpoint = ref('')
const ttsModel = ref('')
const ttsVoice = ref('')
const ttsApiKey = ref('')
const ttsSaving = ref(false)
const ttsTesting = ref(false)
const provider = ref<AiProvider>('deepseek')
const thinkingEnabled = ref(true)
const autoBookOverview = ref(false)
const budgetWarningTokens = ref(DEFAULT_AI_PREFS.budgetWarningTokens)
const trustedCustomOrigins = ref<string[]>([])
const selectedPromptKind = ref<AiPromptKind>('clean')
const promptMode = ref<Record<AiPromptKind, AiPromptMode>>({ ...DEFAULT_AI_PREFS.promptMode })
const customPrompts = ref<Partial<Record<AiPromptKind, string>>>({})
const promptUndo = ref<Partial<Record<AiPromptKind, { mode: AiPromptMode; text?: string }>>>({})
const libraryPath = ref('')
const downloadPace = ref<DownloadPace>('standard')
const saving = ref(false)
const testing = ref(false)
const msg = ref('')
const msgType = ref<'success' | 'error' | 'info'>('info')
const trustModalVisible = ref(false)
const pendingTrustOrigin = ref('')
let resolveTrust: ((accepted: boolean) => void) | null = null

const legacyModelWarning = computed(() => provider.value === 'deepseek' && isLegacyDeepSeekModelName(model.value))
const usesCustomEndpoint = computed(() => provider.value === 'custom' || !isOfficialDeepSeekUrl(baseUrl.value))
const promptOptions = AI_PROMPT_KINDS.map((kind) => ({ label: AI_PROMPT_LABELS[kind], value: kind }))
const selectedPromptMode = computed(() => promptMode.value[selectedPromptKind.value])
const selectedPromptText = computed({
  get: () => selectedPromptMode.value === 'custom'
    ? (customPrompts.value[selectedPromptKind.value] ?? '')
    : BUILTIN_AI_PROMPTS[selectedPromptKind.value],
  set: (value: string) => {
    if (selectedPromptMode.value !== 'custom') return
    customPrompts.value = { ...customPrompts.value, [selectedPromptKind.value]: value }
  },
})
const canUndoPrompt = computed(() => Boolean(promptUndo.value[selectedPromptKind.value]))

const rules = ref<SiteRule[]>([])
const ruleHost = ref('')
const ruleTitle = ref('')
const ruleAuthor = ref('')
const ruleCatalog = ref('')
const ruleBody = ref('')
const ruleAdFilterEnabled = ref(true)
const ruleAdHideSelectors = ref('')
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
    `浏览去广告 ${rule.adFilterEnabled === false ? '关闭' : '开启'}`,
  ].join(' · ')
}

function fillRuleForm(rule: SiteRule) {
  ruleHost.value = rule.host
  ruleTitle.value = rule.title ?? ''
  ruleAuthor.value = rule.author ?? ''
  ruleCatalog.value = rule.catalog ?? ''
  ruleBody.value = rule.body ?? ''
  ruleAdFilterEnabled.value = rule.adFilterEnabled !== false
  ruleAdHideSelectors.value = rule.adHideSelectors ?? ''
}

async function loadRules() {
  const res = await window.api.siteRules.list()
  rules.value = res.rules
  if (props.prefillHost && ruleHost.value === props.prefillHost && activeSection.value === 'siteRules') {
    const stored = rules.value.find((rule) => rule.host === props.prefillHost)
    if (stored) fillRuleForm(stored)
  }
}

async function load() {
  settingsLoading.value = true
  try {
    settings.value = await window.api.settings.get()
    baseUrl.value = settings.value.baseUrl
    model.value = settings.value.model
    ttsEndpoint.value = settings.value.tts?.onlineEndpoint ?? ''
    ttsModel.value = settings.value.tts?.onlineModel ?? ''
    ttsVoice.value = settings.value.tts?.onlineVoice ?? ''
    const ai = settings.value.ai ?? DEFAULT_AI_PREFS
    provider.value = inferAiProvider(settings.value.baseUrl, ai.provider)
    thinkingEnabled.value = ai.thinkingEnabled
    autoBookOverview.value = ai.autoBookOverview
    budgetWarningTokens.value = ai.budgetWarningTokens
    trustedCustomOrigins.value = [...ai.trustedCustomOrigins]
    promptMode.value = { ...ai.promptMode }
    customPrompts.value = { ...ai.customPrompts }
    libraryPath.value = settings.value.libraryPath
    downloadPace.value = settings.value.downloadPace ?? 'standard'
    await loadRules()
  } finally {
    settingsLoading.value = false
  }
}

async function saveTts(): Promise<boolean> {
  const endpoint = ttsEndpoint.value.trim()
  if (endpoint) {
    try {
      const url = new URL(endpoint)
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.hash) throw new Error()
    } catch { message.error('请输入完整 HTTPS 语音接口地址；本机地址可用 HTTP'); return false }
  }
  ttsSaving.value = true
  try {
    settings.value = await window.api.settings.set({
      tts: { onlineEndpoint: endpoint, onlineModel: ttsModel.value.trim(), onlineVoice: ttsVoice.value.trim() },
      ...(ttsApiKey.value ? { ttsApiKey: ttsApiKey.value } : {}),
    })
    ttsApiKey.value = ''
    message.success('听书设置已保存')
    return true
  } catch (error) {
    message.error(error instanceof Error ? error.message : '听书设置保存失败')
    return false
  } finally { ttsSaving.value = false }
}

async function clearTtsKey() {
  settings.value = await window.api.settings.set({ ttsApiKey: '' })
  ttsApiKey.value = ''
  message.success('在线语音密钥已清除')
}

async function testTts() {
  if (!await saveTts()) return
  ttsTesting.value = true
  const requestId = `test_${Date.now()}`
  try {
    const bytes = await window.api.tts.synthesize(requestId, '你好，这是听书语音测试。')
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'audio/mpeg' }))
    const audio = new Audio(url)
    audio.onended = () => URL.revokeObjectURL(url)
    audio.onerror = () => { URL.revokeObjectURL(url); message.error('试音文件无法播放') }
    await audio.play()
  } catch (error) { message.error(error instanceof Error ? error.message : '在线语音试音失败') }
  finally { ttsTesting.value = false }
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

async function setDownloadPace(next: DownloadPace) {
  if (next === downloadPace.value) return
  const previous = downloadPace.value
  downloadPace.value = next
  try {
    const saved = await window.api.settings.set({ downloadPace: next })
    settings.value = saved
    downloadPace.value = saved.downloadPace ?? next
  } catch (e: unknown) {
    downloadPace.value = previous
    const text = e instanceof Error ? e.message : String(e)
    message.error(text || '下载速度保存失败')
  }
}

async function saveLibrary() {
  const target = libraryPath.value.trim()
  const original = settings.value?.libraryPath || ''
  if (target === original) return
  if (!window.confirm(`将书库复制到新目录并校验，成功后切换；原目录会保留。\n\n目标：${target}\n\n确定开始？`)) return
  saving.value = true
  msg.value = ''
  try {
    const result = await window.api.library.migrate(target)
    if (result.ok) {
      settings.value = await window.api.settings.get()
      libraryPath.value = result.newPath
      msg.value = `已搬迁 ${result.files} 个文件到 ${result.newPath}；旧书库保留在 ${result.oldPath}`
      msgType.value = 'success'
    } else {
      libraryPath.value = original
      msg.value = result.message
      msgType.value = 'error'
    }
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
        autoBookOverview: autoBookOverview.value,
        budgetWarningTokens: budgetWarningTokens.value,
        trustedCustomOrigins: trustedOrigins,
        promptMode: { ...promptMode.value },
        customPrompts: { ...customPrompts.value },
      },
    }
    if (apiKey.value) update.apiKey = apiKey.value
    settings.value = await window.api.settings.set(update)
    apiKey.value = ''
    const savedAi = settings.value.ai ?? DEFAULT_AI_PREFS
    trustedCustomOrigins.value = [...savedAi.trustedCustomOrigins]
    promptMode.value = { ...savedAi.promptMode }
    customPrompts.value = { ...savedAi.customPrompts }
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

function copyPromptAsCustom() {
  const kind = selectedPromptKind.value
  customPrompts.value = { ...customPrompts.value, [kind]: BUILTIN_AI_PROMPTS[kind] }
  promptMode.value = { ...promptMode.value, [kind]: 'custom' }
}

async function savePromptSettings() {
  saving.value = true
  try {
    settings.value = await window.api.settings.set({
      ai: {
        promptMode: { ...promptMode.value },
        customPrompts: { ...customPrompts.value },
      },
    })
    const savedAi = settings.value.ai ?? DEFAULT_AI_PREFS
    promptMode.value = { ...savedAi.promptMode }
    customPrompts.value = { ...savedAi.customPrompts }
    msg.value = 'AI 提示词已保存'
    msgType.value = 'success'
  } catch (e: unknown) {
    msg.value = String(e)
    msgType.value = 'error'
  } finally {
    saving.value = false
  }
}

async function restorePromptDefault() {
  const kind = selectedPromptKind.value
  const before = { mode: promptMode.value[kind], text: customPrompts.value[kind] }
  const nextMode = { ...promptMode.value, [kind]: 'builtin' as const }
  const nextPrompts = { ...customPrompts.value }
  delete nextPrompts[kind]
  try {
    settings.value = await window.api.settings.set({
      ai: {
        promptMode: nextMode,
        customPrompts: { ...nextPrompts, [kind]: '' },
      },
    })
    const savedAi = settings.value.ai ?? DEFAULT_AI_PREFS
    promptMode.value = { ...savedAi.promptMode }
    customPrompts.value = { ...savedAi.customPrompts }
    promptUndo.value = { ...promptUndo.value, [kind]: before }
    msg.value = '已恢复默认提示词'
    msgType.value = 'success'
    message.success('已恢复默认提示词')
  } catch (e: unknown) {
    msg.value = String(e)
    msgType.value = 'error'
  }
}

async function undoPromptRestore() {
  const kind = selectedPromptKind.value
  const before = promptUndo.value[kind]
  if (!before) return
  const nextMode = { ...promptMode.value, [kind]: before.mode }
  const nextPrompts = { ...customPrompts.value, [kind]: before.text ?? '' }
  try {
    settings.value = await window.api.settings.set({
      ai: { promptMode: nextMode, customPrompts: nextPrompts },
    })
    const savedAi = settings.value.ai ?? DEFAULT_AI_PREFS
    promptMode.value = { ...savedAi.promptMode }
    customPrompts.value = { ...savedAi.customPrompts }
    const remaining = { ...promptUndo.value }
    delete remaining[kind]
    promptUndo.value = remaining
    msg.value = '已撤销提示词恢复'
    msgType.value = 'success'
  } catch (e: unknown) {
    msg.value = String(e)
    msgType.value = 'error'
  }
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
      adFilterEnabled: ruleAdFilterEnabled.value,
      adHideSelectors: ruleAdHideSelectors.value,
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

async function testRule() {
  rulePreviewing.value = true
  rulePreview.value = null
  try {
    const res = await window.api.siteRules.preview({
      host: ruleHost.value, title: ruleTitle.value, author: ruleAuthor.value,
      catalog: ruleCatalog.value, body: ruleBody.value,
    })
    if (res.ok) rulePreview.value = res.preview
    else message.error(res.message)
  } finally { rulePreviewing.value = false }
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
      ruleAdFilterEnabled.value = true
      ruleAdHideSelectors.value = ''
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
const configuringAutoBackup = ref(false)

async function enableAutoBackup() {
  const { filePaths } = await window.api.dialog.openDirectory()
  const destDir = filePaths?.[0]
  if (!destDir) return
  configuringAutoBackup.value = true
  try {
    settings.value = await window.api.settings.set({ autoBackup: { destDir, lastError: '' } })
    const result = await window.api.backup.runAuto()
    settings.value = await window.api.settings.get()
    msg.value = result.status === 'created' ? `已启用每周自动备份，首份已保存到 ${result.message}`
      : result.status === 'failed' ? `已启用，但首份备份失败：${result.message}` : '已启用每周自动备份'
    msgType.value = result.status === 'failed' ? 'error' : 'success'
  } finally { configuringAutoBackup.value = false }
}

async function disableAutoBackup() {
  settings.value = await window.api.settings.set({ autoBackup: { destDir: '', lastError: '' } })
  msg.value = '已关闭自动备份；已有备份文件保留'
  msgType.value = 'success'
}

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
  if (!window.confirm('恢复会整库覆盖当前书库。软件会先校验备份，失败时保留原书库。确定继续吗？')) return
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
    else promptUndo.value = {}
  },
)

watch(
  () => props.prefillNonce,
  () => {
    ruleHost.value = props.prefillHost ?? ''
    const host = ruleHost.value
    const stored = rules.value.find((rule) => rule.host === host)
    if (stored) fillRuleForm(stored)
    else {
      ruleHost.value = host
      ruleTitle.value = ''
      ruleAuthor.value = ''
      ruleCatalog.value = ''
      ruleBody.value = ''
      ruleAdFilterEnabled.value = true
      ruleAdHideSelectors.value = ''
    }
    activeSection.value = 'siteRules'
  },
)

onMounted(load)
</script>

<template>
  <div class="page settings-page">
    <header class="settings-header">
      <h2 class="page-title">设置</h2>
      <p>管理外观、书库、AI 与本机阅读环境。</p>
    </header>
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="设置分类">
        <button
          v-for="section in sectionOptions"
          :key="section.id"
          type="button"
          class="settings-nav-item"
          :class="{ active: activeSection === section.id }"
          :aria-current="activeSection === section.id ? 'page' : undefined"
          @click="activeSection = section.id"
        >{{ section.label }}</button>
      </nav>
      <main class="settings-content">
        <div v-if="settingsLoading" class="settings-loading" role="status" aria-label="正在加载设置">
          <n-spin size="medium" />
          <span>正在加载设置</span>
        </div>
        <template v-else>
    <n-card v-show="activeSection === 'appearance'" title="外观" class="settings-card">
      <div class="skin-grid">
        <button
          v-for="s in skinOptions"
          :key="s.id"
          type="button"
          class="skin-card"
          :class="{ active: skin === s.id }"
          :aria-pressed="skin === s.id"
          @click="emit('change-skin', s.id)"
        >
          <span class="skin-swatch" :class="s.id">
            <span class="sw-dot d1"></span>
            <span class="sw-dot d2"></span>
            <span class="sw-dot d3"></span>
          </span>
          <span class="skin-name">
            {{ s.name }}
            <span v-if="skin === s.id" class="skin-current">✓ 使用中</span>
          </span>
          <span class="skin-desc">{{ s.desc }}</span>
        </button>
      </div>
    </n-card>

    <n-card v-show="activeSection === 'library'" title="书库" class="settings-card">
      <n-space vertical :size="12">
        <n-input-group>
          <n-input-group-label style="width:80px">书库路径</n-input-group-label>
          <n-input v-model:value="libraryPath" placeholder="D:\spbf\library" />
          <n-button @click="pickLibrary">选择目录</n-button>
        </n-input-group>
        <p style="color:var(--text-muted);font-size:13px;margin:0">
          搬迁仅接受空目录；复制并校验成功后切换，旧目录仍保留。
        </p>
        <n-button type="primary" :loading="saving" @click="saveLibrary">搬迁书库</n-button>
        <div class="pace-row">
          <div>
            <div class="field-label">下载速度</div>
            <div class="field-help">只影响下载时两章之间的等待。</div>
          </div>
          <n-radio-group :value="downloadPace" size="small" @update:value="setDownloadPace">
            <n-radio-button value="slow">慢</n-radio-button>
            <n-radio-button value="standard">标准</n-radio-button>
            <n-radio-button value="fast">快</n-radio-button>
          </n-radio-group>
        </div>
      </n-space>
    </n-card>

    <n-card v-show="activeSection === 'tts'" title="在线听书" class="settings-card">
      <n-space vertical :size="12">
        <n-alert type="warning">选择在线语音播放时，当前正文片段会发送到你填写的服务地址，可能产生费用。系统语音无需网络和密钥。</n-alert>
        <n-alert v-if="settings?.tts.onlineKeyConfigured" type="success">在线语音 API Key 已加密保存</n-alert>
        <n-input-group><n-input-group-label style="width:90px">接口地址</n-input-group-label><n-input v-model:value="ttsEndpoint" placeholder="https://服务地址/v1/audio/speech" /></n-input-group>
        <n-input-group><n-input-group-label style="width:90px">模型名</n-input-group-label><n-input v-model:value="ttsModel" placeholder="例如 tts-1" /></n-input-group>
        <n-input-group><n-input-group-label style="width:90px">音色名</n-input-group-label><n-input v-model:value="ttsVoice" placeholder="例如 alloy" /></n-input-group>
        <n-input-group><n-input-group-label style="width:90px">API Key</n-input-group-label><n-input v-model:value="ttsApiKey" type="password" show-password-on="click" placeholder="留空则不更新" /></n-input-group>
        <p class="field-help">接口须兼容 POST 音频生成协议，接收 model、voice、input 和 response_format=mp3，并返回 MP3。</p>
        <n-space>
          <n-button type="primary" :loading="ttsSaving" @click="saveTts">保存听书设置</n-button>
          <n-button :loading="ttsTesting" @click="testTts">连接试音</n-button>
          <n-button v-if="settings?.tts.onlineKeyConfigured" quaternary type="error" @click="clearTtsKey">清除密钥</n-button>
        </n-space>
      </n-space>
    </n-card>

    <n-card v-show="activeSection === 'ai'" title="AI 配置" class="settings-card">
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
        <div class="switch-row">
          <div>
            <div class="field-label">自动生成全书概览（含剧透）</div>
            <div class="field-help">保存并开启后，完整入库的已有书和新书会逐本向当前 AI 服务发送全部章节正文。长篇会产生多次调用并消耗额度；关闭后停止后续调用。</div>
          </div>
          <n-switch v-model:value="autoBookOverview" aria-label="自动生成全书概览" />
        </div>
        <div class="switch-row">
          <div>
            <div class="field-label">单次输入提醒阈值</div>
            <div class="field-help">预计输入达到阈值时，发送前要求确认；实际 token 和费用以服务商为准。</div>
          </div>
          <n-input-number v-model:value="budgetWarningTokens" :min="1000" :max="50000" :step="1000" style="width:140px" />
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

      <section class="prompt-settings">
        <h3>AI 提示词</h3>
        <n-alert type="info" style="margin-bottom:12px">
          防剧透、已读范围、来源坐标和结构化输出规则由应用固定维护，不会被自定义提示词覆盖。
        </n-alert>
        <n-space vertical :size="12">
          <n-select v-model:value="selectedPromptKind" :options="promptOptions" />
          <n-space align="center">
            <n-tag :type="selectedPromptMode === 'builtin' ? 'default' : 'success'">
              {{ selectedPromptMode === 'builtin' ? '使用内置' : '自定义' }}
            </n-tag>
            <n-button
              v-if="selectedPromptMode === 'builtin'"
              size="small"
              @click="copyPromptAsCustom"
            >复制为自定义</n-button>
            <n-button
              v-else
              size="small"
              @click="restorePromptDefault"
            >恢复默认</n-button>
            <n-button
              v-if="canUndoPrompt"
              size="small"
              quaternary
              @click="undoPromptRestore"
            >撤销</n-button>
          </n-space>
          <n-input
            v-model:value="selectedPromptText"
            type="textarea"
            :autosize="{ minRows: 5, maxRows: 10 }"
            :readonly="selectedPromptMode === 'builtin'"
          />
          <n-button
            v-if="selectedPromptMode === 'custom'"
            type="primary"
            :loading="saving"
            @click="savePromptSettings"
          >保存提示词</n-button>
        </n-space>
      </section>

      <div v-if="msg" class="form-msg" :class="msgType">{{ msg }}</div>
    </n-card>

    <n-card v-show="activeSection === 'siteRules'" title="站点规则" class="settings-card">
      <p style="color:var(--text-muted);font-size:13px;margin:0 0 12px">
        按域名配置提取规则与浏览页去广告。提取选择器留空时走通用提取。
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
        <n-space align="center">
          <span>浏览页去广告</span>
          <n-switch v-model:value="ruleAdFilterEnabled" aria-label="浏览页去广告" />
        </n-space>
        <div class="field-help">浏览页会后台更新 AdGuard 网络规则；离线时使用缓存，首次离线仍可隐藏广告元素。下载章节不受网络过滤。</div>
        <n-input v-model:value="ruleAdHideSelectors" type="textarea" :rows="3" placeholder="额外隐藏的广告元素 CSS 选择器，每行一条" />
        <n-space>
          <n-button type="primary" :loading="ruleSaving" @click="saveRule">保存</n-button>
          <n-button :loading="rulePreviewing" @click="testRule">在当前浏览页试运行</n-button>
          <n-popconfirm @positive-click="removeCurrentRule">
            <template #trigger>
              <n-button quaternary type="error">删除</n-button>
            </template>
            确认删除该站点规则？
          </n-popconfirm>
        </n-space>
        <n-card v-if="rulePreview" size="small" title="试运行结果">
          <div>书名：{{ rulePreview.title || '未识别' }} · 作者：{{ rulePreview.author || '未识别' }}</div>
          <div>目录：{{ rulePreview.chapterCount }} 章 {{ rulePreview.chapterTitles.join('、') }}</div>
          <div v-for="field in (['title', 'author', 'catalog', 'body'] as const)" :key="field">
            {{ { title: '书名', author: '作者', catalog: '目录', body: '正文' }[field] }}：{{ rulePreview.diagnostics[field] }}
          </div>
          <div style="white-space:pre-wrap;max-height:180px;overflow:auto">{{ rulePreview.bodySample || '没有正文样本' }}</div>
        </n-card>
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

    <n-card v-show="activeSection === 'backup'" title="备份与恢复" class="settings-card">
      <p style="color:var(--text-muted);font-size:13px;margin:0 0 12px">
        备份把整个书库（不含回收站）打包成 zip 存到你选的文件夹。恢复是整库覆盖：先校验并准备备份，切换失败时自动还原原书库。
      </p>
      <n-space>
        <n-button :loading="backingUp" @click="handleBackup">备份书库…</n-button>
        <n-button type="warning" :loading="restoring" @click="handleRestore">从备份恢复…</n-button>
      </n-space>
      <div style="margin-top:18px">
        <strong>每周自动备份</strong>
        <p>启动时检查到期备份，仅保留最近五份自动备份。手动备份不会被清理。</p>
        <p>目录：{{ settings?.autoBackup?.destDir || '未启用' }}</p>
        <p v-if="settings?.autoBackup?.lastSuccessAt">上次成功：{{ settings.autoBackup.lastSuccessAt }}</p>
        <p v-if="settings?.autoBackup?.lastError" role="alert">上次错误：{{ settings.autoBackup.lastError }}</p>
        <n-space>
          <n-button :loading="configuringAutoBackup" @click="enableAutoBackup">{{ settings?.autoBackup?.destDir ? '更换目录' : '启用并选择目录' }}</n-button>
          <n-button v-if="settings?.autoBackup?.destDir" @click="disableAutoBackup">关闭自动备份</n-button>
        </n-space>
      </div>
    </n-card>

    <n-card v-show="activeSection === 'appearance'" title="阅读偏好" class="settings-card">
      <p style="color:var(--text-muted);font-size:13px">字体、行距、主题和列宽请在阅读器的“外观”面板中调整。</p>
    </n-card>

    <n-card v-show="activeSection === 'about'" title="关于" class="settings-card">
      <p style="color:var(--text-muted);font-size:13px">
        小说浏览器 v0.1.0 · 当前书库：{{ settings?.libraryPath }}<br>
        技术栈：Electron + Vue 3 + Naive UI
      </p>
    </n-card>

        </template>
      </main>
    </div>
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
.settings-page {
  max-width: 1040px;
  overflow-x: hidden;
  overflow-y: auto;
}

.settings-header {
  margin-bottom: var(--space-4);
}

.settings-header p {
  margin: var(--space-1) 0 0;
  color: var(--text-muted);
  font-size: 13px;
}

.settings-layout {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr);
  gap: var(--space-6);
}

.settings-nav {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  align-self: start;
}

.settings-nav-item {
  position: relative;
  min-height: 38px;
  border: 0;
  border-radius: var(--radius-control);
  padding: 0 var(--space-3);
  color: var(--text-secondary);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.settings-nav-item::before {
  content: '';
  position: absolute;
  top: 8px;
  bottom: 8px;
  left: 0;
  width: 3px;
  border-radius: 999px;
  background: transparent;
}

.settings-nav-item:hover {
  background: var(--surface-2);
  color: var(--text-primary);
}

.settings-nav-item.active {
  color: var(--text-primary);
  background: var(--surface-3);
  font-weight: 700;
}

.settings-nav-item.active::before {
  background: var(--accent);
}

.settings-content {
  min-width: 0;
}

.settings-card + .settings-card {
  margin-top: var(--space-4);
}

.settings-loading {
  min-height: 280px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--text-muted);
}

.prompt-settings {
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px solid var(--line);
}

.prompt-settings h3 {
  margin: 0 0 12px;
}

.field-label {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}

.field-help {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
}

.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.pace-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-top: 4px;
}

.skin-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
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
  transition: border-color 0.15s, box-shadow 0.15s;
}

.skin-card:hover {
  border-color: var(--hover-line);
}

.skin-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
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

.skin-swatch.paper {
  background: #f7f3e8;
  border: 1px solid #e4dcc8;
}

.skin-swatch.white {
  background: #ffffff;
  border: 1px solid #e4e5ec;
}

.skin-swatch.night {
  background: #1b1d20;
  border: 1px solid #34373c;
}

.sw-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.paper .d1 {
  background: #c4a574;
}

.paper .d2 {
  background: #efe6d4;
}

.paper .d3 {
  background: #2f2a24;
}

.white .d1 {
  background: #5e6f9e;
}

.white .d2 {
  background: #e6e7ee;
}

.white .d3 {
  background: #26262e;
}

.night .d1 {
  background: #d8d2c7;
}

.night .d2 {
  background: #3a3d42;
}

.night .d3 {
  background: #8a8478;
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

@media (max-width: 1180px) {
  .settings-layout {
    grid-template-columns: 160px minmax(0, 1fr);
    gap: var(--space-4);
  }
}

@media (max-width: 720px) {
  .settings-layout {
    grid-template-columns: 1fr;
  }

  .settings-nav {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .skin-grid {
    grid-template-columns: 1fr;
  }
}
</style>

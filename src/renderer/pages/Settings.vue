<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  NButton,
  NCard,
  NDivider,
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
import type { AiPromptKind, AiPromptMode, AiProvider, DownloadPace, ProxyKernelState, ProxyMode, ProxyPrefs, ProxyProtocol, ProxySubscriptionState, Settings, SiteRule, SiteRulePreview, Skin } from '@shared/types'
import { AI_PROMPT_KINDS, COVER_GEN_SIZES, DEFAULT_AI_PREFS, DEFAULT_COVER_GEN_PREFS } from '@shared/types'
import { AI_PROMPT_LABELS, BUILTIN_AI_PROMPTS } from '@shared/aiPrompts'
import ProxySubscriptionPanel from '../components/ProxySubscriptionPanel.vue'
import RuleMarketPanel from '../components/RuleMarketPanel.vue'
import SyncPanel from '../components/SyncPanel.vue'
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
type SettingsSection = 'appearance' | 'library' | 'network' | 'tts' | 'map' | 'ai' | 'cover' | 'siteRules' | 'backup' | 'agentAudit' | 'about'
const activeSection = ref<SettingsSection>('appearance')

/** 代理表单：单独一份可编辑副本，只有点「保存」才写回设置。 */
const proxyMode = ref<ProxyMode>('off')
const proxyProtocol = ref<ProxyProtocol>('http')
const proxyHost = ref('')
const proxyPort = ref<number>(7890)
const proxyUsername = ref('')
const proxyPassword = ref('')
const proxyBypass = ref('')
const proxyTesting = ref(false)
const proxyTestResult = ref<{ ok: boolean; message: string } | null>(null)
const proxySaving = ref(false)
const proxyScanning = ref(false)
const proxyScanResult = ref<string>('')
const proxyFoundPorts = ref<{ port: number; label: string; protocol: 'socks5' | 'http' }[]>([])

// —— 订阅模式（内置内核）——
const subscriptionUrl = ref('')
const subscriptionLoading = ref(false)
const subscriptionOverview = ref<ProxySubscriptionState | null>(null)
const subscriptionError = ref('')
const kernelState = ref<ProxyKernelState>({ status: 'stopped' })
/** null = 还没查；false 时界面显示「下载内核」。 */
const kernelInstalled = ref<boolean | null>(null)
const kernelInstalling = ref(false)
const kernelInstallError = ref('')
const selectedNodeIndex = ref(0)

/**
 * 连接订阅：拉正文 → 启动内核 → 会话切过去。
 *
 * 成功后在本地留一份正文（`subscriptionBody`），换节点时直接复用，
 * 不用每次都重新拉订阅——机场订阅接口通常有频率限制。
 */
async function connectSubscription() {
  subscriptionLoading.value = true
  subscriptionError.value = ''
  try {
    const res = await window.api.proxy.subscribe({ url: subscriptionUrl.value.trim() })
    if (!res.ok) {
      subscriptionError.value = res.message
      return
    }
    subscriptionOverview.value = res.overview
    selectedNodeIndex.value = 0
    message.success(`已连上：${res.node.name}`)
    await refreshKernelState()
  } catch (e) {
    subscriptionError.value = e instanceof Error ? e.message : '订阅处理失败'
  } finally {
    subscriptionLoading.value = false
  }
}

async function refreshKernelState() {
  try {
    const res = await window.api.proxy.kernelState()
    if (res.ok) {
      kernelState.value = res.state
      kernelInstalled.value = res.installed
    }
  } catch {
    /* 状态读不到不影响使用 */
  }
}

/**
 * 下载并安装内置内核。
 *
 * 内核不随安装包分发（体积与信任根），首次使用要单独下载一次。
 * 安装按钮本身就是「设置里点下载内核」那句话指向的东西。
 */
async function installProxyKernel() {
  kernelInstalling.value = true
  kernelInstallError.value = ''
  try {
    const res = await window.api.proxy.installKernel()
    if (!res.ok) {
      kernelInstallError.value = res.message ?? '下载内核失败'
      return
    }
    kernelInstalled.value = true
    message.success(res.message ?? '内置内核已安装，可以连接订阅了')
  } catch (e) {
    kernelInstallError.value = e instanceof Error ? e.message : '下载内核失败'
  } finally {
    kernelInstalling.value = false
  }
}

/** 内核在跑但用户想换节点：直接切，比重新粘贴订阅快。 */
async function switchNode(index: number) {
  subscriptionLoading.value = true
  try {
    // 正文由主进程缓存，这里不用回传
    const res = await window.api.proxy.selectNode({ index })
    if (!res.ok) {
      message.error(res.message)
      return
    }
    selectedNodeIndex.value = index
    message.success(`已切换到：${res.node.name}`)
    await refreshKernelState()
  } finally {
    subscriptionLoading.value = false
  }
}

async function stopKernel() {
  await window.api.proxy.stopKernel()
  await refreshKernelState()
  message.success('已停止内置内核')
}

/** 面板重拉了订阅：把新的节点概览反映到上面的节点列表里。 */
function onSubscriptionRefreshed(overview: ProxySubscriptionState) {
  subscriptionOverview.value = overview
}

/** 扫本机端口：找到的候选列出来，点一下直接填进表单。 */
async function scanLocalProxy() {
  proxyScanning.value = true
  proxyScanResult.value = ''
  proxyFoundPorts.value = []
  try {
    const res = await window.api.proxy.scan()
    proxyFoundPorts.value = res.ports
    proxyScanResult.value = res.message
  } catch (e) {
    proxyScanResult.value = e instanceof Error ? e.message : '扫描失败'
  } finally {
    proxyScanning.value = false
  }
}

/** 把扫到的端口填进表单（不保存，等用户确认再点保存）。 */
function useFoundPort(found: { port: number; protocol: 'socks5' | 'http' }) {
  proxyMode.value = 'manual'
  proxyProtocol.value = found.protocol === 'socks5' ? 'socks5' : 'http'
  proxyHost.value = '127.0.0.1'
  proxyPort.value = found.port
  proxyTestResult.value = null
}

const proxyModeOptions = [
  { label: '直连', value: 'off' },
  { label: '订阅（内置内核）', value: 'subscription' },
  { label: '跟随系统', value: 'system' },
  { label: '手动指定', value: 'manual' },
]
const proxyProtocolOptions = [
  { label: 'HTTP', value: 'http' },
  { label: 'HTTPS', value: 'https' },
  { label: 'SOCKS4', value: 'socks4' },
  { label: 'SOCKS5', value: 'socks5' },
]

/** 把设置里的代理同步进表单；保存或重载设置后调用。 */
function syncProxyForm(prefs: ProxyPrefs | undefined) {
  if (!prefs) return
  proxyMode.value = prefs.mode
  proxyProtocol.value = prefs.protocol
  proxyHost.value = prefs.host
  proxyPort.value = prefs.port
  proxyUsername.value = prefs.username
  proxyBypass.value = prefs.bypass
  proxyPassword.value = ''
  subscriptionUrl.value = prefs.subscriptionUrl
  selectedNodeIndex.value = prefs.nodeIndex
}

function proxyFormPayload(): Partial<Omit<ProxyPrefs, 'passwordConfigured'>> {
  return {
    mode: proxyMode.value,
    protocol: proxyProtocol.value,
    host: proxyHost.value.trim(),
    port: proxyPort.value,
    username: proxyUsername.value.trim(),
    bypass: proxyBypass.value,
    subscriptionUrl: subscriptionUrl.value.trim(),
    nodeIndex: selectedNodeIndex.value,
  }
}

async function saveProxy() {
  proxySaving.value = true
  proxyTestResult.value = null
  try {
    const next = await window.api.settings.set({ proxy: proxyFormPayload(), proxyPassword: proxyPassword.value })
    settings.value = next
    syncProxyForm(next.proxy)
    message.success('代理设置已保存并立即生效')
  } catch (e) {
    message.error(e instanceof Error ? e.message : '保存代理设置失败')
  } finally {
    proxySaving.value = false
  }
}

/** 试一次：用当前表单（不必先保存），走真会话验证。 */
async function testProxy() {
  proxyTesting.value = true
  proxyTestResult.value = null
  try {
    const res = await window.api.proxy.test({ prefs: proxyFormPayload() })
    proxyTestResult.value = res
  } catch (e) {
    proxyTestResult.value = { ok: false, message: e instanceof Error ? e.message : '测试失败' }
  } finally {
    proxyTesting.value = false
  }
}
const settingsLoading = ref(true)
const sectionOptions: { id: SettingsSection; label: string }[] = [
  { id: 'appearance', label: '外观' },
  { id: 'library', label: '书库' },
  { id: 'network', label: '网络代理' },
  { id: 'tts', label: '听书' },
  { id: 'map', label: '书中地图' },
  { id: 'ai', label: 'AI' },
  { id: 'cover', label: '封面' },
  { id: 'siteRules', label: '站点规则' },
  { id: 'backup', label: '备份与恢复' },
  { id: 'agentAudit', label: 'Agent 调用记录' },
  { id: 'about', label: '关于' },
]

const skinOptions: { id: Skin; name: string; desc: string }[] = [
  { id: 'light', name: '浅色', desc: '浅灰画布 · 白色书页' },
  { id: 'dark', name: '深色', desc: '深色界面 · 低亮阅读' },
]

const settings = ref<Settings | null>(null)
const baseUrl = ref('')
const model = ref('')
const apiKey = ref('')
const embeddingBaseUrl = ref('')
const embeddingModel = ref('')
const embeddingApiKey = ref('')
const ttsEndpoint = ref('')
const ttsModel = ref('')
const ttsVoice = ref('')
const ttsApiKey = ref('')
const ttsSaving = ref(false)
const ttsTesting = ref(false)
const tencentMapKey = ref('')
const tencentMapSaving = ref(false)
const provider = ref<AiProvider>('deepseek')
const thinkingEnabled = ref(true)
const autoBookOverview = ref(true)
const overviewModel = ref('')
const autoReadingFollow = ref(false)
const followMaxChaptersPerRun = ref(DEFAULT_AI_PREFS.followMaxChaptersPerRun)
const budgetWarningTokens = ref(DEFAULT_AI_PREFS.budgetWarningTokens)
const autoMonthlyTokenLimit = ref(DEFAULT_AI_PREFS.autoMonthlyTokenLimit)
const trustedCustomOrigins = ref<string[]>([])
const selectedPromptKind = ref<AiPromptKind>('clean')
const promptMode = ref<Record<AiPromptKind, AiPromptMode>>({ ...DEFAULT_AI_PREFS.promptMode })
const customPrompts = ref<Partial<Record<AiPromptKind, string>>>({})
const promptUndo = ref<Partial<Record<AiPromptKind, { mode: AiPromptMode; text?: string }>>>({})
const libraryPath = ref('')
const downloadPace = ref<DownloadPace>('standard')
const autoUpdateCheckEnabled = ref(true)
const autoUpdateCheckHours = ref(24)
const autoUpdateCheckSaving = ref(false)
/** AI 封面生成：表单单独一份副本，点保存才写回。 */
const coverGenEnabled = ref(DEFAULT_COVER_GEN_PREFS.enabled)
const coverGenAutoOnImport = ref(DEFAULT_COVER_GEN_PREFS.autoOnImport)
const coverGenModel = ref(DEFAULT_COVER_GEN_PREFS.model)
const coverGenSize = ref(DEFAULT_COVER_GEN_PREFS.size)
const coverGenStyle = ref(DEFAULT_COVER_GEN_PREFS.style)
const coverGenBaseUrl = ref(DEFAULT_COVER_GEN_PREFS.baseUrl)
const coverGenApiKey = ref('')
const coverGenKeyConfigured = ref(false)
const coverGenSaving = ref(false)
const coverSizeOptions = COVER_GEN_SIZES.map((size) => ({ label: size, value: size }))
const autoUpdateHoursOptions = [
  { label: '每 12 小时', value: 12 },
  { label: '每天', value: 24 },
  { label: '每 3 天', value: 72 },
  { label: '每周', value: 168 },
]
const autoUpdateLastText = computed(() => {
  const iso = settings.value?.autoUpdateCheck?.lastCheckedAt || ''
  if (!iso) return '还没有自动检查过'
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return '上次检查时间未知'
  return `上次自动检查：${date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
})
const saving = ref(false)
const libraryMoving = ref(false)
/** 本机 OCR 兜底引擎是否可用：null = 还在检查。 */
const ocrStatus = ref<{ ready: boolean; reason?: string } | null>(null)
const ocrStatusText = computed(() => {
  if (!ocrStatus.value) return '正在检查本机 OCR 引擎…'
  if (ocrStatus.value.ready) return '本机 OCR 引擎可用（tesseract.js，离线识别）。'
  return `本机 OCR 引擎当前不可用：${ocrStatus.value.reason || '未安装 tesseract.js'}。开关可以先打开，但引擎就绪前不会生效。`
})
/** 输入框里的路径和已生效的路径不一致时，界面要说清「还没生效」。 */
const libraryPathDirty = computed(() => libraryPath.value.trim() !== (settings.value?.libraryPath || '').trim())
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
/** 正文噪音正则：每行一条，抓下来的正文里匹配到的片段会被删掉。 */
const ruleBodyCleanPatterns = ref('')
const rulePreviousChapter = ref('')
const ruleNextChapter = ref('')
const ruleAdFilterEnabled = ref(true)
const ruleAdHideSelectors = ref('')
const rulePaywallUnlock = ref(true)
const ruleUnlockSelectors = ref('')
const ruleChapterApi = ref('')
const ruleChapterApiBody = ref('')
const ruleOcrUnlock = ref(false)
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
    previewField('上一章', rule.previousChapter),
    previewField('下一章', rule.nextChapter),
    `浏览去广告 ${rule.adFilterEnabled === false ? '关闭' : '开启'}`,
    `付费墙自动解锁 ${rule.paywallUnlock === false ? '关闭' : '开启'}`,
    `章节接口 ${(rule.chapterApi ?? '').trim() || '（空）'}`,
    `图片/字形 OCR ${rule.ocrUnlock === true ? '开启' : '关闭'}`,
  ].join(' · ')
}

function fillRuleForm(rule: SiteRule) {
  ruleHost.value = rule.host
  ruleTitle.value = rule.title ?? ''
  ruleAuthor.value = rule.author ?? ''
  ruleCatalog.value = rule.catalog ?? ''
  ruleBody.value = rule.body ?? ''
  ruleBodyCleanPatterns.value = rule.bodyCleanPatterns ?? ''
  rulePreviousChapter.value = rule.previousChapter ?? ''
  ruleNextChapter.value = rule.nextChapter ?? ''
  ruleAdFilterEnabled.value = rule.adFilterEnabled !== false
  ruleAdHideSelectors.value = rule.adHideSelectors ?? ''
  rulePaywallUnlock.value = rule.paywallUnlock !== false
  ruleUnlockSelectors.value = rule.unlockSelectors ?? ''
  ruleChapterApi.value = rule.chapterApi ?? ''
  ruleChapterApiBody.value = rule.chapterApiBody ?? ''
  ruleOcrUnlock.value = rule.ocrUnlock === true
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
    syncProxyForm(settings.value.proxy)
    baseUrl.value = settings.value.baseUrl
    model.value = settings.value.model
    embeddingBaseUrl.value = settings.value.embedding?.baseUrl ?? ''
    embeddingModel.value = settings.value.embedding?.model ?? ''
    ttsEndpoint.value = settings.value.tts?.onlineEndpoint ?? ''
    ttsModel.value = settings.value.tts?.onlineModel ?? ''
    ttsVoice.value = settings.value.tts?.onlineVoice ?? ''
    const ai = settings.value.ai ?? DEFAULT_AI_PREFS
    provider.value = inferAiProvider(settings.value.baseUrl, ai.provider)
    thinkingEnabled.value = ai.thinkingEnabled
    autoBookOverview.value = ai.autoBookOverview
    overviewModel.value = ai.overviewModel ?? ''
    autoReadingFollow.value = ai.autoReadingFollow
    followMaxChaptersPerRun.value = ai.followMaxChaptersPerRun
    budgetWarningTokens.value = ai.budgetWarningTokens
    autoMonthlyTokenLimit.value = ai.autoMonthlyTokenLimit
    trustedCustomOrigins.value = [...ai.trustedCustomOrigins]
    promptMode.value = { ...ai.promptMode }
    customPrompts.value = { ...ai.customPrompts }
    libraryPath.value = settings.value.libraryPath
    downloadPace.value = settings.value.downloadPace ?? 'standard'
    autoUpdateCheckEnabled.value = settings.value.autoUpdateCheck?.enabled ?? true
    autoUpdateCheckHours.value = settings.value.autoUpdateCheck?.intervalHours ?? 24
    const coverGen = settings.value.coverGen ?? DEFAULT_COVER_GEN_PREFS
    coverGenEnabled.value = coverGen.enabled
    coverGenAutoOnImport.value = coverGen.autoOnImport
    coverGenModel.value = coverGen.model
    coverGenSize.value = coverGen.size
    coverGenStyle.value = coverGen.style
    await loadRules()
  } catch {
    // 读设置失败时页面会渲染成空壳：给一句人话，别让用户对着空白页猜。
    message.error('读取设置失败，请稍后重试或重启应用')
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

/** 腾讯地图 Key 只经 safeStorage 落盘；空提交即清除。 */
async function saveTencentMapKey() {
  const key = tencentMapKey.value.trim()
  if (!key) { message.warning('请填写腾讯地图 Key'); return }
  tencentMapSaving.value = true
  try {
    settings.value = await window.api.settings.set({ tencentMapKey: key })
    tencentMapKey.value = ''
    message.success('腾讯地图 Key 已加密保存')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '腾讯地图 Key 保存失败')
  } finally { tencentMapSaving.value = false }
}

async function clearTencentMapKey() {
  settings.value = await window.api.settings.set({ tencentMapKey: '' })
  tencentMapKey.value = ''
  message.success('腾讯地图 Key 已清除')
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
  const { filePaths } = await window.api.dialog.openDirectory('选择书库目录')
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

async function setAutoUpdateCheck(enabled: boolean) {
  if (autoUpdateCheckSaving.value) return
  const previous = autoUpdateCheckEnabled.value
  autoUpdateCheckEnabled.value = enabled
  autoUpdateCheckSaving.value = true
  try {
    settings.value = await window.api.settings.set({ autoUpdateCheck: { enabled } })
    autoUpdateCheckEnabled.value = settings.value.autoUpdateCheck?.enabled ?? enabled
  } catch (e: unknown) {
    autoUpdateCheckEnabled.value = previous
    const text = e instanceof Error ? e.message : String(e)
    message.error(text || '自动检查更新保存失败')
  } finally {
    autoUpdateCheckSaving.value = false
  }
}

async function setAutoUpdateCheckHours(hours: number) {
  const previous = autoUpdateCheckHours.value
  if (hours === previous) return
  autoUpdateCheckHours.value = hours
  try {
    settings.value = await window.api.settings.set({ autoUpdateCheck: { intervalHours: hours } })
    autoUpdateCheckHours.value = settings.value.autoUpdateCheck?.intervalHours ?? hours
  } catch (e: unknown) {
    autoUpdateCheckHours.value = previous
    const text = e instanceof Error ? e.message : String(e)
    message.error(text || '检查间隔保存失败')
  }
}

async function saveLibraryPath() {
  const target = libraryPath.value.trim()
  const original = settings.value?.libraryPath || ''
  if (!target || target === original) return
  saving.value = true
  msg.value = ''
  try {
    settings.value = await window.api.settings.set({ libraryPath: target })
    libraryPath.value = settings.value.libraryPath
    msg.value = `已保存新的书库路径：${settings.value.libraryPath}。原书库仍保留在 ${original}，不会自动复制。`
    msgType.value = 'success'
  } catch (e: unknown) {
    msg.value = e instanceof Error ? e.message : String(e)
    msgType.value = 'error'
  } finally {
    saving.value = false
  }
}

async function migrateLibrary() {
  const target = libraryPath.value.trim()
  const original = settings.value?.libraryPath || ''
  if (!target || target === original) return
  if (!window.confirm(`将书库复制到新目录并校验，成功后切换；原目录会保留。\n\n目标：${target}\n\n确定开始？`)) return
  saving.value = true
  libraryMoving.value = true
  msg.value = '正在复制并校验书库文件，请勿关闭应用…'
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
    libraryMoving.value = false
  }
}

async function saveCoverGen(): Promise<void> {
  if (coverGenSaving.value) return
  coverGenSaving.value = true
  msg.value = ''
  try {
    const update: import('@shared/types').SettingsUpdate = {
      coverGen: {
        enabled: coverGenEnabled.value,
        autoOnImport: coverGenAutoOnImport.value,
        baseUrl: coverGenBaseUrl.value.trim(),
        model: coverGenModel.value.trim(),
        size: coverGenSize.value,
        style: coverGenStyle.value.trim(),
      },
    }
    if (coverGenApiKey.value.trim()) update.coverGenApiKey = coverGenApiKey.value.trim()
    settings.value = await window.api.settings.set(update)
    coverGenApiKey.value = ''
    const saved = settings.value.coverGen ?? DEFAULT_COVER_GEN_PREFS
    coverGenBaseUrl.value = saved.baseUrl
    coverGenModel.value = saved.model
    coverGenSize.value = saved.size
    coverGenStyle.value = saved.style
    coverGenKeyConfigured.value = Boolean(settings.value.coverGenKeyConfigured)
    msg.value = '封面设置已保存。' + (coverGenKeyConfigured.value ? ' 图片 Key 已加密存储。' : '')
    msgType.value = 'success'
  } catch (e: unknown) {
    msg.value = e instanceof Error ? e.message : String(e)
    msgType.value = 'error'
  } finally {
    coverGenSaving.value = false
  }
}

async function saveAi(): Promise<boolean> {
  msg.value = ''
  const trustedOrigins = await trustedOriginsForCurrentForm()
  if (!trustedOrigins) return false
  if (embeddingBaseUrl.value.trim()) {
    const embeddingOrigin = normalizeAiServiceOrigin(embeddingBaseUrl.value)
    if (!embeddingOrigin) { msg.value = '向量接口地址仅支持有效的 HTTP(S) 地址'; msgType.value = 'error'; return false }
    if (!trustedOrigins.includes(embeddingOrigin)) {
      if (!await requestTrust(embeddingOrigin)) return false
      trustedOrigins.push(embeddingOrigin)
    }
  }
  saving.value = true
  try {
    const update: import('@shared/types').SettingsUpdate = {
      baseUrl: baseUrl.value.trim(),
      model: model.value.trim(),
      embedding: { baseUrl: embeddingBaseUrl.value.trim(), model: embeddingModel.value.trim() },
      ai: {
        provider: provider.value,
        thinkingEnabled: thinkingEnabled.value,
        autoBookOverview: autoBookOverview.value,
        overviewModel: overviewModel.value.trim(),
        autoReadingFollow: autoReadingFollow.value,
        followMaxChaptersPerRun: followMaxChaptersPerRun.value,
        budgetWarningTokens: budgetWarningTokens.value,
        autoMonthlyTokenLimit: autoMonthlyTokenLimit.value,
        trustedCustomOrigins: trustedOrigins,
        promptMode: { ...promptMode.value },
        customPrompts: { ...customPrompts.value },
      },
    }
    if (apiKey.value) update.apiKey = apiKey.value
    if (embeddingApiKey.value) update.embeddingApiKey = embeddingApiKey.value
    settings.value = await window.api.settings.set(update)
    apiKey.value = ''
    embeddingApiKey.value = ''
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
      bodyCleanPatterns: ruleBodyCleanPatterns.value,
      previousChapter: rulePreviousChapter.value,
      nextChapter: ruleNextChapter.value,
      adFilterEnabled: ruleAdFilterEnabled.value,
      adHideSelectors: ruleAdHideSelectors.value,
      paywallUnlock: rulePaywallUnlock.value,
      unlockSelectors: ruleUnlockSelectors.value,
      chapterApi: ruleChapterApi.value,
      chapterApiMethod: ruleChapterApiBody.value.trim() ? 'POST' : 'GET',
      chapterApiBody: ruleChapterApiBody.value,
      ocrUnlock: ruleOcrUnlock.value,
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
      ruleBodyCleanPatterns.value = ''
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
const agentAuditLoading = ref(false)
const agentAuditEntries = ref<NonNullable<Awaited<ReturnType<typeof window.api.agentAudit.list>>['entries']>>([])
const agentAuditError = ref('')

async function refreshAgentAudit() {
  agentAuditLoading.value = true
  agentAuditError.value = ''
  try {
    const result = await window.api.agentAudit.list(200)
    agentAuditEntries.value = result.entries
  } catch (error) {
    agentAuditError.value = error instanceof Error ? error.message : '读取 agent 调用记录失败'
  } finally {
    agentAuditLoading.value = false
  }
}

function formatAuditTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

async function enableAutoBackup() {
  const { filePaths } = await window.api.dialog.openDirectory('选择自动备份目录')
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
  const { filePaths } = await window.api.dialog.openDirectory('选择备份目录')
  const dest = filePaths?.[0]
  if (!dest) return
  backingUp.value = true
  try {
    const res = await window.api.backup.create(dest)
    if (res.ok) {
      msg.value = `已备份到 ${res.path}`
      // 手动备份成功说明书库现在是完好的：把上一次自动备份的报错清掉，别一直挂着旧错
      settings.value = await window.api.settings.set({ autoBackup: { lastError: '' } })
    } else {
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

watch(activeSection, (section) => {
  if (section === 'agentAudit') void refreshAgentAudit()
})

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
      ruleBodyCleanPatterns.value = ''
      ruleAdFilterEnabled.value = true
      ruleAdHideSelectors.value = ''
    }
    activeSection.value = 'siteRules'
  },
)

onMounted(load)
// 内核装没装不随设置变化：进页面时查一次，界面据此决定是否显示「下载内核」。
onMounted(() => { void refreshKernelState() })
// 引擎状态只在进设置页时查一次：装没装 tesseract.js 不会在运行中途变化
onMounted(async () => {
  try {
    const res = await window.api.ocr.status()
    ocrStatus.value = { ready: Boolean(res.ok && res.ready), reason: res.reason }
  } catch {
    ocrStatus.value = { ready: false, reason: '检查失败' }
  }
})
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
      <button
        class="theme-toggle"
        type="button"
        :aria-label="skin === 'light' ? '切换深色外观' : '切换浅色外观'"
        @click="emit('change-skin', skin === 'light' ? 'dark' : 'light')"
      >
        {{ skin === 'light' ? '切换到深色' : '切换到浅色' }}
      </button>
      <p class="field-help">外观只在这里切换，浏览、书库和阅读共用这一项。</p>
    </n-card>

    <n-card v-show="activeSection === 'library'" title="书库" class="settings-card">
      <n-space vertical :size="12">
        <n-input-group>
          <n-input-group-label style="width:80px">书库路径</n-input-group-label>
          <n-input v-model:value="libraryPath" placeholder="留空则用本机默认目录（当前用户目录下的 spbf\library）" />
          <n-button @click="pickLibrary">选择目录</n-button>
        </n-input-group>
        <p style="color:var(--text-muted);font-size:13px;margin:0">
          当前生效路径：<code>{{ settings?.libraryPath || '正在读取…' }}</code>。
          “保存路径”只切换以后新写入的位置，不复制已有书库；“搬迁书库”会复制并校验已有内容，成功后再切换。
        </p>
        <p v-if="libraryPathDirty" class="field-warn">
          待处理路径：<code>{{ libraryPath }}</code>；当前生效路径仍是
          <code>{{ settings?.libraryPath || '本机默认目录' }}</code>。
        </p>
        <n-alert v-if="libraryMoving" type="info" :show-icon="false">
          正在搬迁书库：复制文件并进行完整性校验，请勿关闭应用。搬迁完成后会显示文件数量和新路径。
        </n-alert>
        <n-space>
          <n-button :disabled="!libraryPathDirty || !libraryPath.trim()" :loading="saving" @click="saveLibraryPath">保存路径</n-button>
          <n-button type="primary" :disabled="!libraryPathDirty || !libraryPath.trim()" :loading="saving" @click="migrateLibrary">搬迁书库</n-button>
        </n-space>
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
        <div class="pace-row">
          <div>
            <div class="field-label">自动检查更新</div>
            <div class="field-help">
              启动时距上次检查超过设定间隔，就逐本检查下载书并把新章补下来；只在没有下载任务时运行。
            </div>
            <div v-if="autoUpdateCheckEnabled" class="field-help">{{ autoUpdateLastText }}</div>
            <div v-if="autoUpdateCheckEnabled && settings?.autoUpdateCheck?.lastSummary" class="field-help">
              {{ settings.autoUpdateCheck.lastSummary }}
            </div>
          </div>
          <n-switch
            :value="autoUpdateCheckEnabled"
            :loading="autoUpdateCheckSaving"
            aria-label="自动检查更新"
            @update:value="setAutoUpdateCheck"
          />
        </div>
        <div v-if="autoUpdateCheckEnabled" class="pace-row">
          <div>
            <div class="field-label">检查间隔</div>
            <div class="field-help">两次自动检查之间至少隔这么久。</div>
          </div>
          <n-select
            :value="autoUpdateCheckHours"
            :options="autoUpdateHoursOptions"
            style="width:130px"
            @update:value="setAutoUpdateCheckHours"
          />
        </div>
      </n-space>
    </n-card>

    <n-card v-show="activeSection === 'network'" title="网络代理" class="settings-card">
      <n-space vertical :size="12">
        <p style="color:var(--text-muted);font-size:13px;margin:0">
          代理只作用于「内置浏览」和「下载」，不影响本机其它软件；两者共用同一条出口，
          浏览里能打开的页面，下载就走得通。
        </p>

        <div class="pace-row">
          <div>
            <div class="field-label">代理方式</div>
            <div class="field-help">选「直连」时连系统代理也不走。</div>
          </div>
          <n-radio-group v-model:value="proxyMode" size="small">
            <n-radio-button v-for="opt in proxyModeOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </n-radio-button>
          </n-radio-group>
        </div>

        <template v-if="proxyMode === 'subscription'">
          <n-alert type="info" :show-icon="false">
            贴一条订阅链接即可。本应用自带代理内核（sing-box），不需要另外装 v2rayN 之类的客户端；
            内核只监听 127.0.0.1，随应用退出。
          </n-alert>

          <n-input-group>
            <n-input-group-label style="width:80px">订阅地址</n-input-group-label>
            <n-input
              v-model:value="subscriptionUrl"
              placeholder="https://... （你的订阅链接）"
              :disabled="subscriptionLoading"
            />
            <n-button type="primary" :loading="subscriptionLoading" @click="connectSubscription">
              连接订阅
            </n-button>
          </n-input-group>

          <div v-if="kernelInstalled === false" class="kernel-install">
            <span class="kernel-install-text">
              内置内核尚未安装（约 32MB）。首次使用需从官方 Releases 下载 sing-box，装好后才能连接订阅。
            </span>
            <n-button
              size="small"
              type="primary"
              :loading="kernelInstalling"
              @click="installProxyKernel"
            >
              下载内核
            </n-button>
          </div>
          <n-alert v-if="kernelInstallError" type="error" :show-icon="false">{{ kernelInstallError }}</n-alert>

          <div class="kernel-bar">
            <span :class="['kernel-dot', kernelState.status]"></span>
            <span class="kernel-text">
              <template v-if="kernelState.status === 'running'">
                内核运行中 · 端口 {{ kernelState.port }} · 节点 {{ kernelState.nodeName }}
              </template>
              <template v-else-if="kernelState.status === 'starting'">内核启动中…</template>
              <template v-else-if="kernelState.status === 'error'">内核未运行：{{ kernelState.message }}</template>
              <template v-else>内核未运行</template>
            </span>
            <n-button v-if="kernelState.status === 'running'" size="tiny" quaternary @click="stopKernel">
              停止内核
            </n-button>
          </div>

          <n-alert v-if="subscriptionError" type="error" :show-icon="false">{{ subscriptionError }}</n-alert>

          <div v-if="subscriptionOverview" class="sub-overview">
            <p class="sub-summary">
              共 {{ subscriptionOverview.total }} 个节点<template v-if="subscriptionOverview.skipped">
              （跳过 {{ subscriptionOverview.skipped }} 条）</template>：
              <span v-for="(count, proto) in subscriptionOverview.byProtocol" :key="proto" class="sub-proto">
                {{ proto }} {{ count }}
              </span>
            </p>
            <n-select
              :value="selectedNodeIndex"
              :options="subscriptionOverview.nodes.map((n, i) => ({ label: `${i + 1}. ${n.name}（${n.protocol}）`, value: i }))"
              size="small"
              filterable
              placeholder="选择节点"
              @update:value="switchNode"
            />
          </div>

          <!-- 订阅自动更新与多节点测速：只让节点列表保持新鲜，换节点仍然由本人点。 -->
          <ProxySubscriptionPanel @refreshed="onSubscriptionRefreshed" />
        </template>

        <template v-if="proxyMode === 'manual'">
          <n-input-group>
            <n-input-group-label style="width:80px">协议</n-input-group-label>
            <n-select v-model:value="proxyProtocol" :options="proxyProtocolOptions" style="width:130px" />
            <n-input-group-label style="width:60px">地址</n-input-group-label>
            <n-input v-model:value="proxyHost" placeholder="127.0.0.1（直接粘贴整条 URL 也行）" />
            <n-input-group-label style="width:60px">端口</n-input-group-label>
            <n-input-number v-model:value="proxyPort" :min="1" :max="65535" :show-button="false" style="width:110px" />
          </n-input-group>

          <n-input-group>
            <n-input-group-label style="width:80px">用户名</n-input-group-label>
            <n-input v-model:value="proxyUsername" placeholder="不需要认证就留空" />
            <n-input-group-label style="width:80px">密码</n-input-group-label>
            <n-input
              v-model:value="proxyPassword"
              type="password"
              show-password-on="click"
              :placeholder="settings?.proxy?.passwordConfigured ? '已加密保存，留空则不修改' : '不需要认证就留空'"
            />
          </n-input-group>

          <n-input-group>
            <n-input-group-label style="width:80px">不走代理</n-input-group-label>
            <n-input
              v-model:value="proxyBypass"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 4 }"
              placeholder="localhost / 192.168.* / *.lan，每行一条或用逗号分隔；默认已跳过内网短名"
            />
          </n-input-group>

          <n-alert v-if="proxyProtocol === 'socks5'" type="info" :show-icon="false">
            SOCKS5 由代理侧解析域名。被 DNS 污染的站必须用这条，否则域名照样解析到错地址。
          </n-alert>
        </template>

        <n-alert v-if="proxyTestResult" :type="proxyTestResult.ok ? 'success' : 'error'" :show-icon="false">
          {{ proxyTestResult.message }}
        </n-alert>

        <n-space>
          <n-button type="primary" :loading="proxySaving" @click="saveProxy">保存代理</n-button>
          <n-button :loading="proxyTesting" @click="testProxy">测试连通</n-button>
          <n-button :loading="proxyScanning" @click="scanLocalProxy">扫描本机代理</n-button>
        </n-space>

        <div v-if="proxyScanResult" class="proxy-scan">
          <p :class="['proxy-scan-msg', proxyFoundPorts.length ? 'ok' : 'warn']">{{ proxyScanResult }}</p>
          <n-space v-if="proxyFoundPorts.length" size="small">
            <n-button
              v-for="found in proxyFoundPorts"
              :key="found.port"
              size="tiny"
              secondary
              type="primary"
              @click="useFoundPort(found)"
            >用 {{ found.port }}（{{ found.protocol.toUpperCase() }}）</n-button>
          </n-space>
        </div>
        <p style="color:var(--text-muted);font-size:12px;margin:0">
          「测试连通」按当前表单试一次，不必先保存；能拿到任何 HTTP 响应就算通
          （验证页、403 都说明链路已经过了）。
        </p>
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

    <n-card v-show="activeSection === 'map'" title="书中地图" class="settings-card">
      <n-space vertical :size="12">
        <n-alert type="warning">
          地图底图来自腾讯位置服务，依赖联网；地名与事件坐标需单独提供，未提供时地图页不显示标注。
        </n-alert>
        <n-alert v-if="settings?.tencentMapKeyConfigured" type="success">腾讯地图 Key 已加密保存</n-alert>
        <n-alert v-else-if="settings?.tencentMapKeyUnreadable" type="warning">
          已保存的腾讯地图 Key 在本机无法解密（通常是换了机器或系统密钥库被重置），请重新填写。
        </n-alert>
        <n-alert v-else type="info">未配置腾讯地图 Key，书中地图页会显示填写提示。</n-alert>
        <n-input-group>
          <n-input-group-label style="width:110px">腾讯地图 Key</n-input-group-label>
          <n-input v-model:value="tencentMapKey" type="password" show-password-on="click" placeholder="留空则不更新" />
        </n-input-group>
        <p class="field-help">
          Key 绑定域名/应用，配额与许可以腾讯位置服务官方文档为准；只加密保存在本机设置，不写入书库与备份。
        </p>
        <n-space>
          <n-button type="primary" :loading="tencentMapSaving" @click="saveTencentMapKey">保存 Key</n-button>
          <n-button v-if="settings?.tencentMapKeyConfigured" quaternary type="error" @click="clearTencentMapKey">清除 Key</n-button>
        </n-space>
      </n-space>
    </n-card>

    <n-card v-show="activeSection === 'ai'" title="AI 配置" class="settings-card">
      <n-alert v-if="settings?.apiKeyConfigured" type="success" style="margin-bottom:12px">
        API Key 已配置（安全存储）
      </n-alert>
      <n-alert v-else-if="settings?.apiKeyUnreadable" type="warning" style="margin-bottom:12px">
        已保存的 API Key 在本机无法解密（通常是换了机器或系统密钥库被重置）。请重新填写并保存。
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
        <div class="field-label">独立向量服务（用于按已读内容找情节）</div>
        <div class="field-help">需支持兼容的 /embeddings 接口。每本书另行开启语义索引后，已读正文才会发送到此服务。</div>
        <n-input-group><n-input-group-label style="width:80px">接口地址</n-input-group-label><n-input v-model:value="embeddingBaseUrl" placeholder="https://服务地址/v1" /></n-input-group>
        <n-input-group><n-input-group-label style="width:80px">向量模型</n-input-group-label><n-input v-model:value="embeddingModel" placeholder="embeddings 模型名" /></n-input-group>
        <n-input-group><n-input-group-label style="width:80px">向量 Key</n-input-group-label><n-input v-model:value="embeddingApiKey" type="password" show-password-on="click" :placeholder="settings?.embedding?.keyConfigured ? '已配置；留空则不更新' : '输入向量服务 Key'" /></n-input-group>
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
            <div class="field-help">默认开启：书加入书架后自动生成一次全书概览，之后一直读取已保存的结果；章节变化也不会重新生成。生成时会把全部章节正文发送给当前 AI 服务，长篇会产生多次调用并消耗额度。</div>
          </div>
          <n-switch v-model:value="autoBookOverview" aria-label="自动生成全书概览" />
        </div>
        <div class="field-row">
          <div>
            <div class="field-label">全书概览模型</div>
            <div class="field-help">只用于全书概览；留空则沿用上面的「模型」。概览用推理型模型时输出预算容易被推理耗尽，建议选非推理的 flash 档。</div>
          </div>
          <n-input v-model:value="overviewModel" placeholder="留空沿用全局模型" aria-label="全书概览模型" />
        </div>
        <div class="switch-row">
          <div>
            <div class="field-label">读完一章自动整理（含剧透）</div>
            <div class="field-help">总开关。开启后，阅读器里把模式设为「自动」的书会在读完每章时把本章正文送给模型生成摘要并按批更新小说记忆，会持续消耗额度；关闭后自动触发立即停止，已排队的章节仍可在阅读页手动整理。</div>
          </div>
          <n-switch v-model:value="autoReadingFollow" aria-label="读完一章自动整理" />
        </div>
        <div class="switch-row">
          <div>
            <div class="field-label">单次自动整理章数上限</div>
            <div class="field-help">一轮最多整理这么多章就停下来等你点「继续整理」，用于给自动追剧和增量记忆设花费上限。记忆仍按每 5 章一批送模型。</div>
          </div>
          <n-input-number v-model:value="followMaxChaptersPerRun" :min="1" :max="50" :step="1" style="width:140px" />
        </div>
        <div class="switch-row">
          <div>
            <div class="field-label">单次输入提醒阈值</div>
            <div class="field-help">预计输入达到阈值时，发送前要求确认；实际 token 和费用以服务商为准。</div>
          </div>
          <n-input-number v-model:value="budgetWarningTokens" :min="1000" :max="50000" :step="1000" style="width:140px" />
        </div>
        <div class="switch-row">
          <div><div class="field-label">每书每月自动任务上限</div><div class="field-help">默认 10 万估算 tokens；自动概览、自动整理和自动语义索引共用。到限后暂停自动任务，手动任务仍可确认执行。实际费用以服务商账单为准。</div></div>
          <n-input-number v-model:value="autoMonthlyTokenLimit" :min="10000" :max="3000000" :step="10000" style="width:160px" />
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

    <n-card v-show="activeSection === 'cover'" title="AI 封面生成" class="settings-card">
      <p style="color:var(--text-muted);font-size:13px;margin:0 0 12px">
        没有封面的书，可以用 AI 按书名、题材和梗概画一张竖版封面。<br>
        调用 OpenAI 兼容的 <code>/images/generations</code>，按张计费；图片模型常常与聊天模型不是同一个服务，所以下面可以单独填地址与 Key，留空则沿用上面 AI 的配置。
      </p>
      <n-space vertical :size="16">
        <div class="field">
          <div class="field-label">启用 AI 封面</div>
          <n-switch v-model:value="coverGenEnabled" />
          <div class="field-help">关掉后书库里不再出现单本生成与批量补齐入口，导入也不再自动生成。</div>
        </div>
        <div class="field">
          <div class="field-label">导入时自动生成</div>
          <n-switch v-model:value="coverGenAutoOnImport" :disabled="!coverGenEnabled" />
          <div class="field-help">导入 txt / epub 后如果没有封面，就在后台画一张，不阻塞导入。每次导入都会真实消耗一次图片额度。</div>
        </div>
        <div class="field">
          <div class="field-label">图片服务地址</div>
          <n-input
            v-model:value="coverGenBaseUrl"
            placeholder="留空沿用 AI 地址，例如 https://api.example.com/v1"
            :disabled="!coverGenEnabled"
          />
          <div class="field-help">填到 <code>/v1</code> 为止，不要带 <code>/images/generations</code>。</div>
        </div>
        <div class="field">
          <div class="field-label">图片服务 Key</div>
          <n-input
            v-model:value="coverGenApiKey"
            type="password"
            show-password-on="click"
            :placeholder="coverGenKeyConfigured ? '已配置，留空不修改' : '留空则沿用 AI 的 Key'"
            :disabled="!coverGenEnabled"
          />
          <div class="field-help">加密保存在本机，不会回传给界面。清空后回退到 AI 的 Key。</div>
        </div>
        <div class="field">
          <div class="field-label">图片模型名</div>
          <n-input v-model:value="coverGenModel" placeholder="例如 gpt-image-1、doubao-seedream-4-0" :disabled="!coverGenEnabled" />
          <div class="field-help">填图片生成模型，不是聊天模型。中转站不支持这个模型时会返回 404 / 400，换一个即可。</div>
        </div>
        <div class="field">
          <div class="field-label">出图尺寸</div>
          <n-select v-model:value="coverGenSize" :options="coverSizeOptions" style="width:180px" :disabled="!coverGenEnabled" />
          <div class="field-help">竖版最适合书架。部分模型只支持方图，报错时换成 1024x1024。</div>
        </div>
        <div class="field">
          <div class="field-label">风格补充</div>
          <n-input
            v-model:value="coverGenStyle"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 4 }"
            :disabled="!coverGenEnabled"
            placeholder="追加到提示词的画面要求，例如画风、构图、色调"
          />
          <div class="field-help">会拼在固定提示词后面。封面一律要求不出现文字，避免模型画出乱码书名。</div>
        </div>
        <n-button type="primary" :loading="coverGenSaving" @click="saveCoverGen">保存</n-button>
      </n-space>
      <div v-if="msg" class="form-msg" :class="msgType">{{ msg }}</div>
    </n-card>

    <n-card v-show="activeSection === 'siteRules'" title="站点规则" class="settings-card">
      <p style="color:var(--text-muted);font-size:13px;margin:0 0 12px">
        按域名配置提取规则与浏览页去广告。提取选择器留空时走通用提取。<br>
        付费墙自动解锁：撞墙时先在页面里找回正文，找不到才按墙暂停等人处理。
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
          <n-input
            v-model:value="ruleBodyCleanPatterns"
            type="textarea"
            :rows="3"
            placeholder="正文噪音正则，每行一条（例如 ^本章未完 或 请记住本站）"
          />
          <div class="field-help">
            抓下来的正文里匹配到的片段会被删掉；最多 20 条，非法正则会被忽略。清正文之前的原文仍保留，可随时撤销。
          </div>
        </n-input-group>
        <n-input-group>
          <n-input-group-label style="width:110px">上一章选择器</n-input-group-label>
          <n-input v-model:value="rulePreviousChapter" placeholder="可选，空则自动识别" />
        </n-input-group>
        <n-input-group>
          <n-input-group-label style="width:110px">下一章选择器</n-input-group-label>
          <n-input v-model:value="ruleNextChapter" placeholder="可选，空则自动识别" />
        </n-input-group>
        <n-input v-model:value="ruleUnlockSelectors" type="textarea" :rows="3" placeholder="解锁容器 CSS 选择器，每行一条（可选）：站点把全文藏在这些节点里时直取，含被样式隐藏的部分" />
        <n-input-group>
          <n-input-group-label style="width:110px">章节接口</n-input-group-label>
          <n-input v-model:value="ruleChapterApi" placeholder="可选：/ajax/chapter?id={id}；{id} {cid} {chapterId} {page} 用当前页线索替换" />
        </n-input-group>
        <n-input v-model:value="ruleChapterApiBody" type="textarea" :rows="2" placeholder="可选：接口的 POST 请求体（JSON），填写后该站接口按 POST 调用，如 {&quot;cid&quot;:&quot;{id}&quot;}" />
        <n-space align="center">
          <span>付费墙自动解锁</span>
          <n-switch v-model:value="rulePaywallUnlock" aria-label="付费墙自动解锁" />
        </n-space>
        <n-space align="center">
          <span>图片/字形走 OCR</span>
          <n-switch v-model:value="ruleOcrUnlock" aria-label="图片与字形替换走 OCR" />
        </n-space>
        <div class="field-help">
          开了 OCR：正文是图片切片、或站点用自定义字体把字换成私用区乱码时，截图交给 OCR 认字（本机引擎，离线。认得慢，结果可能有错字，请核对后再读）。
        </div>
        <div class="field-help" :class="{ 'field-warn': ocrStatus && !ocrStatus.ready }">
          {{ ocrStatusText }}
        </div>
        <div class="field-help">
          开启后撞付费墙先在页面内找回正文：解锁容器、被样式藏起来的全文、内联 JSON / 脚本变量 / data-* 属性、编码载荷、被藏起来的续页；都失败才在页面上下文里调上面那个章节接口（带当前登录态，不伪造凭证）。全部拿不到才按付费墙暂停等人处理。
        </div>
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

      <!-- 规则市场：订阅别人写好的抽取规则并应用到本机。条目只含 CSS 选择器。 -->
      <n-divider style="margin:20px 0 12px" title-placement="left">规则市场</n-divider>
      <RuleMarketPanel />

      <!-- 账号与云同步：只同步设置与站点规则，正文与 API Key 不上云。 -->
      <n-divider style="margin:20px 0 12px" title-placement="left">账号与云同步</n-divider>
      <SyncPanel />
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
        <p v-if="settings?.autoBackup?.lastError" role="alert">
          上次错误：{{ settings.autoBackup.lastError }}
          <br />自动备份失败后不会自己重试；处理完上面说的原因，点下面的「备份书库…」手动跑一次即可。
        </p>
        <n-space>
          <n-button :loading="configuringAutoBackup" @click="enableAutoBackup">{{ settings?.autoBackup?.destDir ? '更换目录' : '启用并选择目录' }}</n-button>
          <n-button v-if="settings?.autoBackup?.destDir" @click="disableAutoBackup">关闭自动备份</n-button>
        </n-space>
      </div>
    </n-card>

    <n-card v-show="activeSection === 'agentAudit'" title="Agent 调用记录" class="settings-card">
      <n-space vertical :size="12">
        <p style="color:var(--text-muted);font-size:13px;margin:0">
          显示最近 200 条经 MCP 桥接的调用元数据。为保护隐私，此处不会展示调用参数、正文、API Key、密文或令牌。
        </p>
        <n-space align="center">
          <n-button :loading="agentAuditLoading" @click="refreshAgentAudit">刷新记录</n-button>
          <span style="color:var(--text-muted);font-size:12px">{{ agentAuditEntries.length }} 条</span>
        </n-space>
        <n-alert v-if="agentAuditError" type="error" :show-icon="false">{{ agentAuditError }}</n-alert>
        <n-spin v-if="agentAuditLoading" size="small" />
        <n-empty v-else-if="agentAuditEntries.length === 0" description="暂无 agent 调用记录" />
        <div v-else class="agent-audit-list">
          <article v-for="(entry, index) in agentAuditEntries" :key="`${entry.ts}-${index}`" class="agent-audit-row">
            <div class="agent-audit-main">
              <strong>{{ entry.tool }}</strong>
              <n-tag size="small" :type="entry.ok ? 'success' : 'error'">{{ entry.ok ? '成功' : '失败' }}</n-tag>
              <n-tag size="small" :type="entry.dryRun ? 'warning' : 'default'">{{ entry.dryRun ? 'dry-run' : entry.tier }}</n-tag>
            </div>
            <div class="agent-audit-meta">
              <span>{{ formatAuditTime(entry.ts) }}</span>
              <span>{{ entry.client || '未知客户端' }}</span>
              <span>{{ entry.channel }}</span>
              <span>{{ entry.ms }} ms</span>
              <span v-if="entry.confirmed">已确认</span>
              <span v-if="entry.code">{{ entry.code }}</span>
            </div>
          </article>
        </div>
      </n-space>
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
  width: 100%;
  max-width: 1240px;
  margin: 0 auto;
  padding: var(--space-8) clamp(24px, 3vw, 48px);
  overflow-x: hidden;
  overflow-y: auto;
}

.settings-header {
  margin-bottom: var(--space-6);
}

.settings-header p {
  margin: var(--space-1) 0 0;
  color: var(--text-muted);
  font-size: 13px;
}

.settings-layout {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  gap: var(--space-8);
}

.settings-nav {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  align-self: start;
  padding: var(--space-2);
  border: 0;
  border-radius: var(--radius-card);
  background: transparent;
}

.settings-nav-item {
  position: relative;
  min-height: 42px;
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
  color: var(--focus);
  background: var(--surface-1);
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

.settings-card { box-shadow: var(--shadow-card); }

.settings-card :deep(.n-card__content) {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.settings-card :deep(.n-input-group) {
  max-width: 100%;
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

/* 需要用户先动手才能生效的提示（路径没搬、OCR 引擎缺失） */
.field-warn {
  color: var(--warning, #d03050);
}
.field-warn code {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}

.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  min-height: 40px;
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--border);
}

.kernel-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 13px;
}

.kernel-install {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface-2);
}

.kernel-install-text {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-muted);
}

.kernel-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
  flex: none;
}

.kernel-dot.running {
  background: var(--success-color, #18a058);
}

.kernel-dot.starting {
  background: var(--warning-color, #f0a020);
}

.kernel-dot.error {
  background: var(--error-color, #d03050);
}

.kernel-text {
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sub-overview {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.sub-summary {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
}

.sub-proto {
  margin-right: var(--space-2);
}

.proxy-scan {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.proxy-scan-msg {
  margin: 0;
  font-size: 13px;
}

.proxy-scan-msg.ok {
  color: var(--text-muted);
}

.proxy-scan-msg.warn {
  color: var(--warning-text, var(--text-muted));
}

.pace-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--border);
}

.skin-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
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
  border-radius: var(--radius-card);
  padding: var(--space-4);
  cursor: pointer;
  color: inherit;
  transition: border-color var(--motion-duration), box-shadow var(--motion-duration);
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
  box-shadow: var(--input-ring);
}

.skin-swatch {
  width: 100%;
  height: 64px;
  border-radius: var(--radius-control);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.skin-swatch.light {
  background: linear-gradient(90deg, #f6f6f2 0 36%, #ffffff 36%);
  border: 1px solid #dedfd5;
}

.skin-swatch.dark {
  background: linear-gradient(90deg, #0a0a0a 0 36%, #131713 36%);
  border: 1px solid #2a312a;
}

.sw-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.light .d1 { background: #5f7f14; }
.light .d2 { background: #dedfd5; }
.light .d3 { background: #0d0f0c; }
.dark .d1 { background: #a8e64f; }
.dark .d2 { background: #2a312a; }
.dark .d3 { background: #fafafa; }

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

.agent-audit-list {
  display: grid;
  gap: 8px;
  max-height: 560px;
  overflow: auto;
}

.agent-audit-row {
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
}

.agent-audit-main,
.agent-audit-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
}

.agent-audit-meta {
  margin-top: 7px;
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
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
  .settings-page {
    padding: var(--space-4);
  }

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

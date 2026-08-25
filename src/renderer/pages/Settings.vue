<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
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
  NTag,
} from 'naive-ui'
import type { Settings, SiteRule, Skin } from '@shared/types'

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
const libraryPath = ref('')
const saving = ref(false)
const testing = ref(false)
const msg = ref('')
const msgType = ref<'success' | 'error' | 'info'>('info')

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
  libraryPath.value = settings.value.libraryPath
  await loadRules()
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

async function testAi() {
  testing.value = true
  msg.value = ''
  try {
    const res = await window.api.ai.test({
      baseUrl: baseUrl.value,
      model: model.value,
      apiKey: apiKey.value || undefined,
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
  </div>
</template>

<style scoped>
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

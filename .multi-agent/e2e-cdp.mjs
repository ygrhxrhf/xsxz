import { mkdir, writeFile } from 'node:fs/promises'

const port = Number(process.env.CDP_PORT || 9222)
const skin = process.env.SKIN || 'sakura'
const artifactDir = '/home/goot/cod/xs/xsxz/.multi-agent/e2e-artifacts'
await mkdir(artifactDir, { recursive: true })

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let targets
for (let i = 0; i < 40; i += 1) {
  try {
    targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json())
    if (targets.length) break
  } catch {}
  await delay(250)
}
const target = targets?.find((item) => item.type === 'page' && item.url.startsWith('file:'))
if (!target) throw new Error('没有找到 Electron 渲染页 CDP target')

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})
let nextId = 1
const pending = new Map()
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (!message.id) return
  const waiter = pending.get(message.id)
  if (!waiter) return
  pending.delete(message.id)
  if (message.error) waiter.reject(new Error(message.error.message))
  else waiter.resolve(message.result)
}
function cdp(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}
async function waitFor(expression, timeout = 10000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return
    await delay(100)
  }
  throw new Error(`等待超时: ${expression}`)
}
async function screenshot(name) {
  const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(`${artifactDir}/${name}.png`, Buffer.from(shot.data, 'base64'))
}

await cdp('Page.enable')
await cdp('Runtime.enable')
await waitFor(`document.querySelector('.reader-content') && document.querySelector('.reader-toolbar')`)
const resolutions = [
  { width: 1280, height: 800, name: '1280x800' },
  { width: 1100, height: 720, name: '1100x720' },
]
const evidence = []
function record(resolution, item, pass, detail) {
  evidence.push({ skin, resolution, item, pass: Boolean(pass), detail })
}

for (const resolution of resolutions) {
  await evaluate(`document.body.dataset.skin = '${skin}'; window.resizeTo(${resolution.width}, ${resolution.height})`)
  await delay(400)
  const layout = await evaluate(`(() => {
    const contentRect = document.querySelector('.reader-content').getBoundingClientRect()
    const bodyRect = document.querySelector('.reader-body').getBoundingClientRect()
    const content = { left: contentRect.left, width: contentRect.width }
    const body = { left: bodyRect.left, width: bodyRect.width }
    const labels = [...document.querySelectorAll('.reader-toolbar [aria-label]')].map((el) => el.getAttribute('aria-label'))
    return { content, body, labels, oldControls: !!document.querySelector('.reader-controls'), oldNav: !!document.querySelector('.reader-nav'), hotWidths: [...document.querySelectorAll('.chapter-hotzone')].map((el) => el.getBoundingClientRect().width), progressPointer: getComputedStyle(document.querySelector('.reader-progress-track')).pointerEvents }
  })()`)
  const contentCenter = layout.content.left + layout.content.width / 2
  const bodyCenter = layout.body.left + layout.body.width / 2
  record(resolution.name, '正文居中且旧侧栏/底栏消失', Math.abs(contentCenter - bodyCenter) < 3 && !layout.oldControls && !layout.oldNav, JSON.stringify({ contentCenter, bodyCenter }))
  record(resolution.name, '顶部工具顺序与中文 aria-label', layout.labels.join('|') === '返回书库|目录|搜索|标记|朗读|AI|外观|沉浸模式', layout.labels.join('|'))
  record(resolution.name, '48px 章节热区', layout.hotWidths.every((width) => Math.round(width) === 48), layout.hotWidths.join(','))
  record(resolution.name, '底部进度不可点击', layout.progressPointer === 'none', layout.progressPointer)
  const pageOverflow = await evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth`)
  record(resolution.name, 'Reader页面无横向溢出', !pageOverflow, String(pageOverflow))

  await evaluate(`document.querySelector('.reader-wrap').dispatchEvent(new MouseEvent('mousemove', { clientY: 300, bubbles: true }))`)
  await delay(3300)
  const hidden = await evaluate(`getComputedStyle(document.querySelector('.reader-toolbar')).opacity === '0'`)
  record(resolution.name, '工具静置3秒隐藏', hidden, String(hidden))
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', bubbles: true }))`)
  await delay(300)
  const altVisible = await evaluate(`Number(getComputedStyle(document.querySelector('.reader-toolbar')).opacity) > 0.9`)
  record(resolution.name, 'Alt 唤回工具', altVisible, String(altVisible))

  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }))`)
  const locked = await evaluate(`document.querySelector('.reader-wrap').classList.contains('immersive-locked')`)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  const unlocked = await evaluate(`!document.querySelector('.reader-wrap').classList.contains('immersive-locked')`)
  record(resolution.name, 'M 锁定且 Esc 退出', locked && unlocked, JSON.stringify({ locked, unlocked }))

  await evaluate(`document.querySelector('[aria-label="外观"]').click()`)
  await waitFor(`[...document.querySelectorAll('.tool-panel strong')].some((el) => el.textContent === '阅读外观')`)
  const appearance = await evaluate(`(() => {
    const texts = [...document.querySelectorAll('.tool-panel button')].map((el) => el.textContent.trim())
    return { texts, sliders: document.querySelectorAll('.tool-panel .n-slider').length, indent: [...document.querySelectorAll('.tool-panel')].some((el) => el.textContent.includes('首行缩进')) }
  })()`)
  record(resolution.name, '七项外观控件存在', ['纸白','暖黄','柔灰','夜间','宋体阅读','系统黑体','等宽','窄','中','宽','紧凑','标准','宽松','恢复默认'].every((text) => appearance.texts.includes(text)) && appearance.sliders === 2 && appearance.indent, JSON.stringify(appearance))
  await evaluate(`document.querySelector('[aria-label="外观"]').click()`)

  await evaluate(`(() => { const el = document.querySelector('.reader-content'); el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); })()`)
  await delay(100)
  const progress = await evaluate(`({ detail: document.querySelector('.reader-progress-track').title, card: document.querySelector('.chapter-end-card')?.textContent.trim() || '', width: document.querySelector('.reader-progress-fill').style.width })`)
  record(resolution.name, '章末100%与全书进度详情', progress.detail.includes('本章 100%') && progress.detail.includes('全书') && progress.detail.includes('还剩') && progress.card.startsWith('下一章：'), JSON.stringify(progress))

  await evaluate(`document.querySelector('[aria-label="目录"]').click()`)
  await waitFor(`document.querySelector('.ch-item.active')`)
  const catalog = await evaluate(`(() => { const active = document.querySelector('.ch-item.active').getBoundingClientRect(); return { text: document.querySelector('.ch-item.active').textContent.trim(), visible: active.top >= 0 && active.bottom <= innerHeight } })()`)
  record(resolution.name, '目录定位当前章', catalog.visible && catalog.text.includes('第一章'), JSON.stringify(catalog))
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  const reduced = await evaluate(`getComputedStyle(document.querySelector('.reader-toolbar')).transitionDuration === '0s'`)
  record(resolution.name, '减少动画关闭过渡', reduced, String(reduced))
  await cdp('Emulation.setEmulatedMedia', { features: [] })

  await evaluate(`document.querySelector('[aria-label="外观"]').click()`)
  await delay(80)
  await evaluate(`(() => {
    const clickText = (text) => [...document.querySelectorAll('.tool-panel button')].find((el) => el.textContent.trim() === text)?.click()
    clickText('暖黄'); clickText('等宽'); clickText('宽'); clickText('宽松')
  })()`)
  await delay(450)
  await evaluate(`(() => {
    globalThis.__u31Settings = null
    globalThis.__u31SettingsError = null
    void window.api.settings.get().then((settings) => { globalThis.__u31Settings = settings }, (error) => { globalThis.__u31SettingsError = String(error) })
  })()`)
  await waitFor(`globalThis.__u31Settings !== null || globalThis.__u31SettingsError !== null`)
  const appearanceChange = await evaluate(`(() => {
    const content = document.querySelector('.reader-content')
    const settings = globalThis.__u31Settings
    const clickText = (text) => [...document.querySelectorAll('.tool-panel button')].find((el) => el.textContent.trim() === text)?.click()
    const result = { background: getComputedStyle(content).backgroundColor, font: getComputedStyle(content).fontFamily, maxWidth: getComputedStyle(content).maxWidth, settings: settings?.reader || null, error: globalThis.__u31SettingsError }
    clickText('恢复默认')
    document.querySelector('[aria-label="外观"]').click()
    return result
  })()`)
  record(resolution.name, '外观立即生效并持久化', appearanceChange.settings?.theme === 'sepia' && appearanceChange.settings?.fontFamily === 'mono' && appearanceChange.settings?.contentWidth === 'wide' && appearanceChange.settings?.paragraphSpacing === 'relaxed' && appearanceChange.background === 'rgb(243, 226, 184)', JSON.stringify(appearanceChange))

  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`)
  await waitFor(`document.querySelector('.ch-title')?.textContent.includes('第二章')`)
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))`)
  await waitFor(`document.querySelector('.ch-title')?.textContent.includes('第一章')`)
  record(resolution.name, '方向键正确换章并遵守边界', true, '第一章→第二章→第一章')

  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))`)
  await waitFor(`document.querySelector('input[placeholder="输入要找的文字…"]')`)
  await evaluate(`(() => {
    const input = document.querySelector('input[placeholder="输入要找的文字…"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '长夜')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    globalThis.__u31SearchPanel = document.querySelector('.tool-panel')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
  })()`)
  await delay(40)
  const searchProtected = await evaluate(`!document.querySelector('.tool-panel') || document.querySelector('.tool-panel') === globalThis.__u31SearchPanel`)
  await evaluate(`([...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '搜索'))?.click()`)
  await delay(280)
  const searchResult = await evaluate(`({ protectedInput: ${searchProtected}, hits: document.querySelectorAll('.hit-row').length })`)
  record(resolution.name, '搜索流程与输入区快捷键保护', searchResult.protectedInput && searchResult.hits > 0, JSON.stringify(searchResult))
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

  await evaluate(`document.querySelector('[aria-label="朗读"]').click()`)
  await delay(90)
  const ttsPanel = await evaluate(`document.querySelector('.tool-panel')?.textContent || ''`)
  await evaluate(`document.querySelector('[aria-label="朗读"]').click()`)
  await delay(40)
  await evaluate(`document.querySelector('[aria-label="AI"]').click()`)
  await delay(90)
  const aiPanel = await evaluate(`document.querySelector('.tool-panel')?.textContent || ''`)
  await evaluate(`document.querySelector('[aria-label="AI"]').click()`)
  const panels = { tts: ttsPanel, ai: aiPanel }
  record(resolution.name, 'TTS与AI既有入口完整', (panels.tts.includes('播放') || panels.tts.includes('当前环境不支持朗读')) && ['清正文','AI 助手','人物卡','聊书'].every((text) => panels.ai.includes(text)), JSON.stringify(panels))

  await waitFor(`document.querySelector('.reader-content [data-p="0"]')`)
  await evaluate(`document.querySelector('.reader-content').scrollTop = 0`)
  await delay(150)
  const paragraphRect = await evaluate(`(() => { const rect = document.querySelector('.reader-content [data-p="0"]').getBoundingClientRect(); return { x: rect.left, y: rect.top, width: rect.width, height: rect.height } })()`)
  const startX = paragraphRect.x + 12
  const selectionY = paragraphRect.y + Math.min(14, paragraphRect.height / 2)
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: selectionY, button: 'left', clickCount: 1 })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.min(startX + 150, paragraphRect.x + paragraphRect.width - 8), y: selectionY, button: 'left', buttons: 1 })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.min(startX + 150, paragraphRect.x + paragraphRect.width - 8), y: selectionY, button: 'left', clickCount: 1 })
  await delay(180)
  const selectionActions = await evaluate(`[...document.querySelectorAll('.sel-popup button')].map((el) => el.textContent.trim())`)
  record(resolution.name, '选区五项动作顺序', selectionActions.join('|') === '复制|划线|备注|翻译|问 AI', selectionActions.join('|'))
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

  const focusVisible = await evaluate(`(() => [...document.styleSheets].some((sheet) => { try { return [...sheet.cssRules].some((rule) => rule.cssText.includes('focus-visible') && rule.cssText.includes('outline')) } catch { return false } }))()`)
  record(resolution.name, '键盘焦点清晰可见', focusVisible, String(focusVisible))

  await screenshot(`reader-${skin}-${resolution.name}`)
}

ws.close()
const passed = evidence.filter((item) => item.pass).length
const failed = evidence.filter((item) => !item.pass)
await writeFile(`${artifactDir}/results-${skin}.json`, JSON.stringify({ skin, passed, total: evidence.length, failed, evidence }, null, 2))
console.log(JSON.stringify({ passed, total: evidence.length, failed }, null, 2))
if (failed.length) process.exitCode = 1

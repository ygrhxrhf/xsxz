const port = Number(process.env.CDP_PORT || 9222)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let targets
for (let i = 0; i < 50; i += 1) {
  try {
    targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json())
    if (targets.length) break
  } catch {}
  await delay(200)
}
const target = targets?.find((item) => item.type === 'page' && item.url.startsWith('file:'))
if (!target) throw new Error('没有找到 Electron 渲染页 CDP target')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let nextId = 1
const pending = new Map()
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (!message.id) return
  const waiter = pending.get(message.id)
  if (!waiter) return
  pending.delete(message.id)
  message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result)
}
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}
async function waitFor(expression, timeout = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return true
    await delay(50)
  }
  return false
}
await cdp('Runtime.enable')
const evidence = []
for (const size of [{ width: 1280, height: 800 }, { width: 1100, height: 720 }]) {
  await evaluate(`window.resizeTo(${size.width}, ${size.height})`)
  await delay(150)
  for (const skin of ['sakura', 'minimal']) {
    const result = await evaluate(`(() => {
      document.body.dataset.skin = '${skin}'
      const nav = document.querySelector('.browser-nav-row').getBoundingClientRect()
      const actions = document.querySelector('.browser-action-row').getBoundingClientRect()
      const slot = document.querySelector('.browse-slot').getBoundingClientRect()
      const primary = [...document.querySelectorAll('.browser-actions button')].find((el) => el.textContent.includes('下载本书'))
      const secondary = [...document.querySelectorAll('.browser-actions button')].find((el) => el.textContent.includes('配置本站规则'))
      const p = getComputedStyle(primary)
      const s = getComputedStyle(secondary)
      const icons = [...document.querySelectorAll('.browser-icon-button')]
      icons[0].focus()
      return {
        rows: document.querySelectorAll('.browser-nav-row, .browser-action-row').length,
        order: nav.bottom <= actions.top + 1 && actions.bottom <= slot.top + 1,
        toolbarHeight: Math.round(actions.bottom - nav.top),
        navOverflow: nav.scrollWidth > nav.clientWidth,
        actionOverflow: actions.scrollWidth > actions.clientWidth,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        primaryBackground: p.backgroundColor,
        secondaryBackground: s.backgroundColor,
        primaryColor: p.color,
        secondaryColor: s.color,
        distinctHierarchy: p.backgroundColor !== s.backgroundColor || p.color !== s.color,
        iconCount: icons.length,
        iconSizes: icons.map((el) => [Math.round(el.getBoundingClientRect().width), Math.round(el.getBoundingClientRect().height)]),
        focusOutline: getComputedStyle(icons[0]).outlineWidth,
        siteText: document.querySelector('.site-status').textContent.trim(),
      }
    })()`)
    const pass = result.rows === 2 && result.order && result.toolbarHeight >= 88 && result.toolbarHeight <= 104
      && !result.navOverflow && !result.actionOverflow && !result.pageOverflow && result.distinctHierarchy
      && result.iconCount === 3 && result.iconSizes.every(([w, h]) => w === 36 && h === 36)
      && Number.parseFloat(result.focusOutline) >= 2
      && (result.siteText === '尚未打开网页' || result.siteText.startsWith('当前站点：'))
    evidence.push({ size: `${size.width}x${size.height}`, skin, pass, result })
  }
}

await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
await evaluate(`(() => {
  const input = document.querySelector('input[aria-label="网页地址"]')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, 'http://127.0.0.1:18081/book.html')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  document.querySelector('.browse-toolbar').requestSubmit()
})()`)
await delay(500)
const drawerStarted = await evaluate(`(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50))
  const button = [...document.querySelectorAll('.browser-actions button')].find((el) => el.textContent.includes('下载本书'))
  if (!button || button.disabled) return false
  button.click()
  return true
})()`)
const drawerVisible = drawerStarted && await waitFor(`document.querySelector('.n-drawer') && document.querySelector('.n-drawer').getBoundingClientRect().height > 200`, 3000)
let drawerResult = { visible: false }
if (drawerVisible) {
  await delay(5)
  drawerResult = await evaluate(`(() => {
    const element = document.querySelector('.n-drawer')
    if (!element) return { visible: false }
    const drawer = element.getBoundingClientRect()
    const slot = document.querySelector('.browse-slot').getBoundingClientRect()
    const actionable = [...document.querySelectorAll('.n-drawer button')].some((el) => {
      const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0
    })
    return {
      visible: true,
      height: Math.round(drawer.height),
      top: Math.round(drawer.top),
      bottom: Math.round(drawer.bottom),
      innerHeight,
      anchoredBottom: Math.abs(drawer.bottom - innerHeight) <= 2,
      slotAboveDrawer: slot.top < drawer.top,
      actionable,
    }
  })()`)
}
const drawerPass = drawerResult.visible && drawerResult.height === 240 && drawerResult.anchoredBottom && drawerResult.slotAboveDrawer && drawerResult.actionable
evidence.push({ item: 'download-drawer', pass: drawerPass, result: drawerResult })
await cdp('Emulation.setEmulatedMedia', { features: [] })
ws.close()
const failed = evidence.filter((item) => !item.pass)
console.log(JSON.stringify({ passed: evidence.length - failed.length, total: evidence.length, failed, evidence }, null, 2))
if (failed.length) process.exitCode = 1

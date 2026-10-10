const port = Number(process.env.CDP_PORT || 9222)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let targets
for (let i = 0; i < 40; i += 1) {
  try {
    targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json())
    if (targets.length) break
  } catch {}
  await delay(250)
}
const target = targets?.find((item) => item.type === 'page' && item.url !== 'about:blank')
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
await cdp('Runtime.enable')
const evidence = []
for (const size of [{ width: 1280, height: 800 }, { width: 1100, height: 720 }]) {
  await evaluate(`window.resizeTo(${size.width}, ${size.height})`)
  await delay(200)
  for (const desiredSkin of ['sakura', 'minimal']) {
    await evaluate(`(() => {
      const desired = '${desiredSkin}'
      if (document.body.dataset.skin !== desired) document.querySelector('.skin-toggle').click()
    })()`)
    await delay(120)
    const result = await evaluate(`(async () => {
      const navs = [...document.querySelectorAll('.nav-btn')]
      const labels = navs.map((el) => el.querySelector('.nav-label')?.textContent?.trim())
      const iconRects = navs.map((el) => { const rect = el.querySelector('.nav-icon').getBoundingClientRect(); return [rect.width, rect.height] })
      const routeChecks = []
      for (const nav of navs) {
        nav.click()
        await new Promise((resolve) => setTimeout(resolve, 30))
        routeChecks.push(nav.classList.contains('active') && nav.getAttribute('aria-current') === 'page')
      }
      navs[0].click()
      await new Promise((resolve) => setTimeout(resolve, 30))
      const sidebar = document.querySelector('.sidebar').getBoundingClientRect()
      const brand = document.querySelector('.brand-mark svg')
      const skinButton = document.querySelector('.skin-toggle')
      skinButton.focus()
      return {
        skin: document.body.dataset.skin,
        sidebarWidth: Math.round(sidebar.width),
        labels,
        navSvgCount: document.querySelectorAll('.nav-icon').length,
        iconRects,
        brandSvg: Boolean(brand && brand.querySelectorAll('path').length === 2),
        routeChecks,
        startRestoredBrowse: navs[0].classList.contains('active'),
        focusOutline: getComputedStyle(skinButton).outlineWidth,
        toggleHasSvg: Boolean(skinButton.querySelector('svg')),
        emojiText: /[🧭📚📖⚙️📘🌸]/u.test(document.querySelector('.sidebar').textContent || ''),
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      }
    })()`)
    const pass = result.skin === desiredSkin
      && result.sidebarWidth === 200
      && result.labels.join('|') === '浏览|书库|阅读|设置'
      && result.navSvgCount === 4
      && result.iconRects.every(([w, h]) => w >= 18 && h >= 18)
      && result.brandSvg
      && result.routeChecks.every(Boolean)
      && result.startRestoredBrowse
      && result.focusOutline === '2px'
      && result.toggleHasSvg
      && !result.emojiText
      && !result.horizontalOverflow
    evidence.push({ size: `${size.width}x${size.height}`, skin: desiredSkin, pass, result })
  }
}
ws.close()
const failed = evidence.filter((item) => !item.pass)
console.log(JSON.stringify({ passed: evidence.length - failed.length, total: evidence.length, failed, evidence }, null, 2))
if (failed.length) process.exitCode = 1

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
await evaluate(`([...document.querySelectorAll('.nav-btn')].find((el) => el.textContent.includes('书库'))).click()`)
await waitFor(`document.querySelector('.library-empty')`, 3000)
const evidence = []
const empty = await evaluate(`(() => {
  const root = document.querySelector('.library-empty')
  return {
    heading: root?.querySelector('h3')?.textContent?.trim(),
    copy: root?.querySelector('p')?.textContent?.trim(),
    buttons: [...(root?.querySelectorAll('button') || [])].map((el) => el.textContent.trim()),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }
})()`)
const emptyPass = empty.heading === '书库还是空的'
  && empty.copy === '从网页下载一本书，或导入本地 txt / epub。'
  && empty.buttons.join('|') === '去浏览找书|导入本地书'
  && !empty.overflow
evidence.push({ item: 'empty-library', pass: emptyPass, result: empty })

const imported = await evaluate(`window.api.library.import('/tmp/éclair AB 超长测试书名.txt')`)
if (!imported?.ok) throw new Error(imported?.message || '导入测试书失败')
await evaluate(`(async () => {
  const navs = [...document.querySelectorAll('.nav-btn')]
  navs.find((el) => el.textContent.includes('浏览')).click()
  await new Promise((resolve) => setTimeout(resolve, 80))
  navs.find((el) => el.textContent.includes('书库')).click()
})()`)
if (!await waitFor(`document.querySelector('.book-card')`, 5000)) throw new Error('导入后未显示书库卡片')

for (const size of [{ width: 1280, height: 800 }, { width: 1100, height: 720 }]) {
  await evaluate(`window.resizeTo(${size.width}, ${size.height})`)
  await delay(150)
  for (const skin of ['sakura', 'minimal']) {
    const result = await evaluate(`(() => {
      document.body.dataset.skin = '${skin}'
      const grid = document.querySelector('.book-grid')
      const card = document.querySelector('.book-card')
      const cover = card.querySelector('.book-cover')
      const open = card.querySelector('.book-open-area')
      const title = card.querySelector('.book-title')
      const author = card.querySelector('.book-author')
      const progress = card.querySelector('.book-progress')
      const coverRect = cover.getBoundingClientRect()
      const cardRect = card.getBoundingClientRect()
      open.focus()
      const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').map(Number.parseFloat)
      return {
        cardWidth: Math.round(cardRect.width),
        columns,
        coverWidth: Math.round(coverRect.width),
        coverHeight: Math.round(coverRect.height),
        coverText: cover.textContent.trim(),
        coverBackground: getComputedStyle(cover).backgroundImage,
        aria: open.getAttribute('aria-label'),
        focusOutline: getComputedStyle(open).outlineWidth,
        nestedButton: Boolean(open.querySelector('button')),
        title: title.textContent.trim(),
        titleAttr: title.getAttribute('title'),
        authorVisible: Boolean(author),
        progress: progress.textContent.trim(),
        statusVisible: Boolean(card.querySelector('.book-meta .n-tag')),
        actionsVisible: Boolean(card.querySelector('.legacy-card-actions')),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      }
    })()`)
    const pass = result.cardWidth >= 230 && result.columns.every((width) => width >= 230)
      && result.coverWidth === 104 && result.coverHeight === 142 && result.coverText === 'ÉC'
      && result.coverBackground !== 'none'
      && result.aria === '打开《éclair AB 超长测试书名》'
      && Number.parseFloat(result.focusOutline) >= 2 && !result.nestedButton
      && result.title === result.titleAttr && result.progress.length > 0
      && result.statusVisible && result.actionsVisible && !result.overflow
    evidence.push({ size: `${size.width}x${size.height}`, skin, pass, result })
  }
}

await evaluate(`document.querySelector('.book-open-area').focus()`)
await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 })
await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 })
const keyboardOpened = await waitFor(`document.querySelector('[aria-current="page"] .nav-label')?.textContent === '阅读'`, 2000)
evidence.push({ item: 'keyboard-open', pass: keyboardOpened, result: { keyboardOpened } })

ws.close()
const failed = evidence.filter((item) => !item.pass)
console.log(JSON.stringify({ passed: evidence.length - failed.length, total: evidence.length, failed, evidence }, null, 2))
if (failed.length) process.exitCode = 1

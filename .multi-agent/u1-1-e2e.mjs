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
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}

await cdp('Runtime.enable')
const evidence = []
for (const size of [{ width: 1280, height: 800 }, { width: 1100, height: 720 }]) {
  await evaluate(`window.resizeTo(${size.width}, ${size.height})`)
  await delay(150)
  for (const skin of ['sakura', 'minimal']) {
    const result = await evaluate(`(() => {
      document.body.dataset.skin = '${skin}'
      const style = getComputedStyle(document.body)
      const value = (name) => style.getPropertyValue(name).trim()
      const host = document.createElement('div')
      host.innerHTML = '<button id="u11-focus">焦点</button><span class="status-success">成功</span><span class="status-warning">警告</span><span class="status-error">错误</span><span class="status-info">信息</span><span class="skeleton-block" style="display:block;width:40px;height:12px"></span>'
      document.body.appendChild(host)
      const button = host.querySelector('#u11-focus')
      button.focus()
      const symbols = ['success','warning','error','info'].map((kind) => getComputedStyle(host.querySelector('.status-' + kind), '::before').content)
      const data = {
        tokens: ['--space-1','--space-2','--space-3','--space-4','--space-6','--space-8','--radius-control','--radius-card','--radius-overlay','--motion-duration'].map(value),
        semantics: ['--text-primary','--text-secondary','--text-muted','--surface-1','--surface-2','--surface-3','--border','--hover','--focus','--success','--warning','--error','--info','--disabled','--selection-bg','--scrollbar-thumb'].every((name) => value(name).length > 0),
        symbols,
        outline: getComputedStyle(button).outlineWidth,
        overflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      }
      host.remove()
      return data
    })()`)
    const pass = result.tokens.join('|') === '4px|8px|12px|16px|24px|32px|8px|14px|16px|150ms'
      && result.semantics
      && new Set(result.symbols).size === 4
      && result.outline === '2px'
      && result.overflow
    evidence.push({ size: `${size.width}x${size.height}`, skin, pass, result })
  }
}
await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
const reduced = await evaluate(`(() => {
  const el = document.createElement('span')
  el.className = 'skeleton-block'
  document.body.appendChild(el)
  const result = { animationName: getComputedStyle(el).animationName, scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior }
  el.remove()
  return result
})()`)
await cdp('Emulation.setEmulatedMedia', { features: [] })
const reducedPass = reduced.animationName === 'none' && reduced.scrollBehavior === 'auto'
evidence.push({ item: 'reduced-motion', pass: reducedPass, result: reduced })
ws.close()
const failed = evidence.filter((item) => !item.pass)
console.log(JSON.stringify({ passed: evidence.length - failed.length, total: evidence.length, failed, evidence }, null, 2))
if (failed.length) process.exitCode = 1

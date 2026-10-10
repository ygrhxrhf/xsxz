const targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json())
const target = targets.find(x => x.type === 'page' && x.url !== 'about:blank')
if (!target) throw new Error('no page')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let id = 0
const pending = new Map()
ws.onmessage = event => { const m = JSON.parse(event.data); if (!m.id) return; const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
const cdp = (method, params={}) => new Promise((resolve,reject) => { const n=++id; pending.set(n,{resolve,reject}); ws.send(JSON.stringify({id:n,method,params})) })
const expression = process.argv.slice(2).join(' ')
const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
console.log(JSON.stringify(result.result.value, null, 2))
ws.close()

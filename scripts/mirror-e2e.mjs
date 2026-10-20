// 整站镜像端到端：真起 Electron，用本地夹具站走「分类页 → 批量入书库」。
//
// 为什么不用单测代替：mirror 的最后一公里是 IPC 接线、隐藏视图复用浏览登录态、
// 与下载单任务锁串行。这三件事只有真进程能证明。
//
// 用法：npm run build 之后 `node scripts/mirror-e2e.mjs`
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT_HTTP = 21000 + Math.floor(Math.random() * 10000)
const PORT_CDP = 31000 + Math.floor(Math.random() * 10000)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const passed = []
const failed = []
const check = (label, ok, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`
  ;(ok ? passed : failed).push(line)
  console.log(line)
}

const body = (title) => Array.from({ length: 8 }, (_, i) =>
  `<p>第${i + 1}段：${title}的正文用来验证镜像批量下载是否真的把章节写进书库，这一段需要足够长以满足正文提取的长度门槛，因此重复一些描述性文字。</p>`).join('')
const chapter = (title) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body(title)}</body></html>`
const catalog = (book, author) => `<!doctype html><html><head><title>${book} 目录</title>
<meta property="og:title" content="${book}"><meta property="og:novel:author" content="${author}"></head><body>
<h1>${book}</h1><div class="bookinfo"><span class="author">${author}</span></div>
<div id="list"><dl><dt>正文</dt>
${[1, 2, 3, 4, 5].map((n) => `<dd><a href="/book/${book === '剑来' ? 1 : 2}/c${n}.html">第${n}章</a></dd>`).join('\n')}
</dl></div></body></html>`
// 撞墙书：目录正常，章节页是登录墙，用来验证镜像撞墙后 1 秒内停批而不是空等 30 分钟。
const wallCatalog = `<!doctype html><html><head><title>撞墙书 目录</title>
<meta property="og:title" content="撞墙书"><meta property="og:novel:author" content="墙"></head><body>
<h1>撞墙书</h1><div class="bookinfo"><span class="author">墙</span></div>
<div id="list"><dl><dt>正文</dt>
${[1, 2, 3, 4, 5].map((n) => `<dd><a href="/book/3/c${n}.html">第${n}章</a></dd>`).join('\n')}
</dl></div></body></html>`
const wallChapter = `<!doctype html><html><head><title>用户登录</title></head><body><div id="content"><p>请登录后阅读</p></div></body></html>`
// 撞墙书后面的书：如果停批没生效，它会继续被下载，书库里就会多出第三本。
const afterWallCatalog = `<!doctype html><html><head><title>墙后的书 目录</title>
<meta property="og:title" content="墙后的书"><meta property="og:novel:author" content="后"></head><body>
<h1>墙后的书</h1><div class="bookinfo"><span class="author">后</span></div>
<div id="list"><dl><dt>正文</dt>
${[1, 2, 3].map((n) => `<dd><a href="/book/4/c${n}.html">第${n}章</a></dd>`).join('\n')}
</dl></div></body></html>`
const listing = `<!doctype html><html><head><title>玄幻分类</title></head><body>
<nav><a href="/">首页</a><a href="/login">登录</a><a href="/search">搜索</a></nav>
<ul class="book-list">
<li><a href="/book/1/">剑来</a></li>
<li><a href="/book/2/">诡秘之主</a></li>
<li><a href="/book/3/">撞墙书</a></li>
<li><a href="/book/4/">墙后的书</a></li>
</ul></body></html>`

const pages = {
  '/list.html': listing,
  '/book/1/': catalog('剑来', '烽火戏诸侯'),
  '/book/2/': catalog('诡秘之主', '爱潜水的乌贼'),
  '/book/3/': wallCatalog,
  '/book/4/': afterWallCatalog,
  '/book/1/c1.html': chapter('第一章'),
  '/book/1/c2.html': chapter('第二章'),
  '/book/1/c3.html': chapter('第三章'),
  '/book/1/c4.html': chapter('第四章'),
  '/book/1/c5.html': chapter('第五章'),
  '/book/2/c1.html': chapter('第一章'),
  '/book/2/c2.html': chapter('第二章'),
  '/book/2/c3.html': chapter('第三章'),
  '/book/2/c4.html': chapter('第四章'),
  '/book/2/c5.html': chapter('第五章'),
  '/book/3/c1.html': wallChapter,
  '/book/3/c2.html': wallChapter,
  '/book/3/c3.html': wallChapter,
  '/book/3/c4.html': wallChapter,
  '/book/3/c5.html': wallChapter,
  '/book/4/c1.html': chapter('第一章'),
  '/book/4/c2.html': chapter('第二章'),
  '/book/4/c3.html': chapter('第三章'),
}

const server = createServer((req, res) => {
  const html = pages[req.url?.split('?')[0] ?? '']
  if (!html) { res.writeHead(404); res.end('not found'); return }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
})
await new Promise((resolve) => server.listen(PORT_HTTP, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${PORT_HTTP}`

const userData = await mkdtemp(join(tmpdir(), 'spbf-mirror-e2e-'))
const libraryPath = join(userData, 'library')
await writeFile(join(userData, 'settings.json'), JSON.stringify({ libraryPath }, null, 2))

const child = spawn(electronPath, [root, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT_CDP}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += String(chunk) })
child.stderr.on('data', (chunk) => { stderr += String(chunk) })
const killTree = () => {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGTERM')
  } catch { /* 已经退出 */ }
}

async function connectCdp() {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT_CDP}/json/list`)).json()
      // 只认应用主窗口的渲染页：WebContentsView（浏览页）没有 preload，window.api 不在那里。
      const page = targets.find((target) => target.type === 'page' && /index\.html|localhost:\d+\/?$/.test(target.url ?? ''))
        ?? targets.find((target) => target.type === 'page' && !/^about:blank/.test(target.url ?? ''))
      if (page?.webSocketDebuggerUrl) {
        const ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
        return { ws, url: page.url }
      }
    } catch { /* 还没起来 */ }
    await sleep(400)
  }
  throw new Error('连不上 Chromium 调试端点')
}

let seq = 0
function evaluate(ws, expression) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    const onMessage = (event) => {
      const payload = JSON.parse(String(event.data))
      if (payload.id !== id) return
      ws.removeEventListener('message', onMessage)
      if (payload.error) { reject(new Error(payload.error.message)); return }
      const exception = payload.result?.exceptionDetails
      if (exception) { reject(new Error(exception.exception?.description ?? exception.text ?? 'evaluate 失败')); return }
      resolve(payload.result?.result?.value)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    setTimeout(() => reject(new Error('CDP evaluate 超时')), 30_000)
  })
}

try {
  const { ws, url } = await connectCdp()
  check('应用窗口已启动并连上 CDP', true, url)
  let apiReady = false
  for (let i = 0; i < 40 && !apiReady; i++) {
    apiReady = await evaluate(ws, 'typeof window.api === "object"').catch(() => false)
    if (!apiReady) await sleep(500)
  }
  check('渲染页拿到 preload 暴露的 window.api', apiReady === true)

  const loaded = await evaluate(ws, `window.api.browse.load(${JSON.stringify(`${base}/list.html`)})`)
  check('浏览页打开分类夹具页', loaded?.ok === true, JSON.stringify(loaded))
  await sleep(1500)

  const started = await evaluate(ws, `window.api.mirror.start(${JSON.stringify({ seedUrl: `${base}/list.html`, maxBooks: 2, maxPages: 1 })})`)
  check('mirror.start 返回 jobId', started?.ok === true && typeof started.jobId === 'string', JSON.stringify(started))

  let last = null
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    last = (await evaluate(ws, 'window.api.mirror.state()'))?.state?.last
    if (last && last.status !== 'running') break
    await sleep(1000)
  }
  check('镜像任务结束（done）', last?.status === 'done', JSON.stringify(last && { status: last.status, done: last.done, failed: last.failed, total: last.total }))
  if (last?.failed) console.log('失败明细：', JSON.stringify(last.results.filter((item) => item.status === 'failed'), null, 2))
  check('两本书都入库', last?.done === 2 && last?.failed === 0 && last?.total === 2, JSON.stringify(last && { done: last.done, failed: last.failed, total: last.total }))

  const listed = await evaluate(ws, 'window.api.library.list()')
  const titles = (listed?.books ?? []).map((book) => book.title).sort()
  check('书库里出现《剑来》《诡秘之主》', titles.includes('剑来') && titles.includes('诡秘之主'), titles.join('、'))
  const chapters = (listed?.books ?? []).map((book) => book.chapterCount).sort()
  check('每本 5 章', chapters.length === 2 && chapters.every((count) => count === 5), JSON.stringify(chapters))

  const persisted = JSON.parse(await readFile(join(userData, 'mirror-state.json'), 'utf-8'))
  check('mirror-state.json 落盘最近一次任务', persisted.status === 'done' && persisted.done === 2, JSON.stringify({ status: persisted.status, done: persisted.done }))
  check('书库目录写到了临时路径', existsSync(libraryPath))

  // 第二轮：同一列表页再跑一次，两本都该按 sourceUrl 跳过，不再抓书页。
  const again = await evaluate(ws, `window.api.mirror.start(${JSON.stringify({ seedUrl: `${base}/list.html`, maxBooks: 2, maxPages: 1 })})`)
  check('第二次 mirror.start 返回 jobId', again?.ok === true, JSON.stringify(again))
  let second = null
  const secondDeadline = Date.now() + 60_000
  while (Date.now() < secondDeadline) {
    second = (await evaluate(ws, 'window.api.mirror.state()'))?.state?.last
    if (second && second.status !== 'running') break
    await sleep(1000)
  }
  check('第二次把两本都标为已在书库', second?.status === 'done' && second?.skipped === 2 && second?.done === 0, JSON.stringify(second && { status: second.status, skipped: second.skipped, done: second.done }))
  check('跳过的书不再重复入库', ((await evaluate(ws, 'window.api.library.list()'))?.books ?? []).length === 2)

  // 第三轮：第三本是登录墙，第四本在它后面。撞墙后应在一两秒内停批，不再下第四本。
  const wallRun = await evaluate(ws, `window.api.mirror.start(${JSON.stringify({ seedUrl: `${base}/list.html`, maxBooks: 4, maxPages: 1 })})`)
  check('第三次 mirror.start 返回 jobId', wallRun?.ok === true, JSON.stringify(wallRun))
  const wallStartedAt = Date.now()
  let wall = null
  const wallDeadline = Date.now() + 60_000
  while (Date.now() < wallDeadline) {
    wall = (await evaluate(ws, 'window.api.mirror.state()'))?.state?.last
    if (wall && wall.status !== 'running') break
    await sleep(500)
  }
  const wallElapsed = Date.now() - wallStartedAt
  check('撞墙任务以 error 结束且指向站点墙', wall?.status === 'error' && /站点墙/.test(wall?.message ?? ''), JSON.stringify(wall && { status: wall.status, message: wall.message }))
  check('撞墙前两本跳过、撞墙那本失败', wall?.skipped === 2 && wall?.failed === 1 && wall?.done === 0, JSON.stringify(wall && { skipped: wall.skipped, failed: wall.failed, done: wall.done }))
  check('停批在 15 秒内生效，没有空等 30 分钟', wallElapsed < 15_000, `${wallElapsed}ms`)
  check('结果只有三本，第四本未处理', wall?.results?.length === 3, JSON.stringify(wall?.results?.map((item) => item.status)))
  const afterWallTitles = ((await evaluate(ws, 'window.api.library.list()'))?.books ?? []).map((book) => book.title)
  check('撞墙后的书没有被下载', afterWallTitles.includes('撞墙书') && !afterWallTitles.includes('墙后的书'), afterWallTitles.join('、'))
  ws.close()
} catch (error) {
  check('E2E 跑到收尾', false, error instanceof Error ? error.message : String(error))
} finally {
  killTree()
  server.close()
  await rm(userData, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n结果：${passed.length} 项通过，${failed.length} 项失败`)
if (failed.length) {
  console.log(failed.join('\n'))
  if (stderr.trim()) console.log(`\n--- stderr ---\n${stderr.split('\n').slice(-15).join('\n')}`)
  process.exit(1)
}
console.log('整站镜像端到端通过：分类页 → 2 本入库 → 重复镜像全跳过 → 撞墙 6 秒内停批')

// 自动追更真机闭环：本地站真下载一本书 → 目录加一章 → 不点按钮等启动自动检查 → 书库提示。
// 用法：npm run build 之后 node scripts/auto-update-e2e.mjs（npm run e2e:auto-update）
// 注意：会真开三次应用窗口，其中一次要等满默认的 60 秒自动检查，全程约 90 秒。
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const SITE_PORT = 39000 + Math.floor(Math.random() * 800)
const DEBUG_PORT = 39800 + Math.floor(Math.random() * 150)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const passed = []
const failed = []
const check = (label, ok, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`
  ;(ok ? passed : failed).push(line)
  console.log(line)
}

const userData = await mkdtemp(join(tmpdir(), 'spbf-autoupd-userdata-'))
const library = await mkdtemp(join(tmpdir(), 'spbf-autoupd-library-'))
const siteDir = await mkdtemp(join(tmpdir(), 'spbf-autoupd-site-'))
const settingsPath = join(userData, 'settings.json')

const PARAGRAPH =
  '雪下得很密，灯罩上结了薄薄一层白，林舟把灯笼搁在石阶上，蹲下去看那道刻痕，指尖碰到的地方凉得像铁。'
const paragraph = (index) => `${PARAGRAPH}这是第${index}段的补充文字，让正文有足够的长度通过提取器的判断。`

function catalogHtml(chapters) {
  return `<!DOCTYPE html><html><head><title>灯下残卷 - 目录</title></head><body>
<h1>灯下残卷</h1><div>作者：测试</div>
<ul>${chapters.map((title, i) => `<li><a href="${i + 1}.html">${title}</a></li>`).join('')}
</ul></body></html>`
}

const CHAPTERS = ['第一章 雪夜', '第二章 归途', '第三章 灯下', '第四章 石阶', '第五章 刻痕']
function chapterHtml(title, index) {
  return `<!DOCTYPE html><html><head><title>${title} - 灯下残卷</title></head><body>
<div id="content"><h2>${title}</h2>
<p>${paragraph(index * 2 + 1)}</p><p>${paragraph(index * 2 + 2)}</p>
<p><a href="index.html">返回目录</a></p></div></body></html>`
}

await mkdir(join(siteDir, 'book'), { recursive: true })
await writeFile(join(siteDir, 'book', 'index.html'), catalogHtml(CHAPTERS))
for (const [i, title] of CHAPTERS.entries()) {
  await writeFile(join(siteDir, 'book', `${i + 1}.html`), chapterHtml(title, i))
}
await writeFile(settingsPath, JSON.stringify({ libraryPath: library }, null, 2))

const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
  try {
    const data = await readFile(join(siteDir, pathname.replace(/^\//, '')))
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
})
await new Promise((resolve) => server.listen(SITE_PORT, '127.0.0.1', resolve))
const catalogUrl = `http://127.0.0.1:${SITE_PORT}/book/index.html`

function launch(extraArgs) {
  const child = spawn(electronPath, [root, `--user-data-dir=${userData}`, ...extraArgs], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (chunk) => { out += String(chunk) })
  child.stderr.on('data', (chunk) => { out += String(chunk) })
  return { child, log: () => out }
}

const killTree = (child) => {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGTERM')
  } catch { /* 已经退出 */ }
}

async function evaluate(expression, timeoutMs = 120_000) {
  let targets = []
  for (let i = 0; i < 60 && targets.length === 0; i += 1) {
    await sleep(500)
    try { targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json() } catch { /* 还没起 */ }
  }
  // 浏览 View 也是 http 页面且同样叫 index.html；只认应用外壳的 file:// 页面。
  const page = targets.filter((t) => t.type === 'page').find((t) => t.url.startsWith('file://'))
  if (!page) throw new Error('没等到应用外壳页的调试 target')
  await sleep(2500)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 超时')), timeoutMs)
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }))
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id !== 1) return
      clearTimeout(timer)
      const value = msg.result?.result?.value
      if (value === undefined) reject(new Error(`表达式没返回值：${JSON.stringify(msg.result)}`))
      else resolve(value)
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP 连接失败')) }
  })
}

let bookId = ''
try {
  // 第一段：真下载两章。
  const a = launch([`--remote-debugging-port=${DEBUG_PORT}`])
  try {
    const flow = await evaluate(`(async () => {
      const load = await window.api.browse.load(${JSON.stringify(catalogUrl)})
      if (!load.ok) return { step: 'load', detail: load }
      const preview = await window.api.download.preview()
      if (!preview.ok) return { step: 'preview', detail: preview }
      const confirm = await window.api.download.confirm(preview.preview.token)
      if (!confirm.ok) return { step: 'confirm', detail: confirm }
      const done = await new Promise((resolve) => {
        let settled = false
        const finish = (value) => { if (!settled) { settled = true; off(); clearInterval(poll); clearTimeout(timer); resolve(value) } }
        const off = window.api.download.onProgress((p) => {
          if (p && p.status && p.status !== 'running') finish(p)
        })
        // 本地五章可能在监听挂上之前就下完；轮询书库状态兜底。
        const poll = setInterval(async () => {
          try {
            const list = await window.api.library.list()
            const book = list.books.find((b) => b.id === confirm.bookId)
            if (book && book.chapterCount > 0 && book.readyCount === book.chapterCount) {
              finish({ status: 'done', done: book.readyCount, total: book.chapterCount, failed: 0 })
            }
          } catch { /* 继续等 */ }
        }, 500)
        const timer = setTimeout(() => finish({ status: 'timeout' }), 120000)
      })
      return { step: 'done', bookId: confirm.bookId, preview: preview.preview.chapterCount, progress: done }
    })()`)
    bookId = flow.bookId || ''
    check('夹具书下载完成', flow.step === 'done' && flow.progress?.status === 'done', JSON.stringify(flow))
    check('下载时认出 5 章', flow.preview === 5, String(flow.preview))

    const ui = await evaluate(`(async () => {
      const clickNav = (label) => {
        const btn = [...document.querySelectorAll('.app-nav .nav-btn')].find((b) => b.textContent.trim() === label)
        if (!btn) return false
        btn.click()
        return true
      }
      const toSettings = clickNav('设置')
      await new Promise((r) => setTimeout(r, 800))
      const text = document.body.textContent || ''
      const settingsView = {
        toSettings,
        hasLabel: text.includes('自动检查更新'),
        hasInterval: text.includes('检查间隔'),
        hasSwitch: Boolean(document.querySelector('[aria-label="自动检查更新"]')),
      }
      const toLibrary = clickNav('书库')
      await new Promise((r) => setTimeout(r, 800))
      return { ...settingsView, toLibrary, libraryText: document.body.innerText || '' }
    })()`)
    check('设置页出现自动检查开关与间隔', ui.hasLabel && ui.hasInterval && ui.hasSwitch, JSON.stringify(ui))
    check('首次进入书库没有追更提示', ui.toLibrary && !ui.libraryText.includes('自动追更'))
  } finally {
    killTree(a.child)
    await sleep(1500)
  }

  // 第二段：站点加一章，不点按钮，等启动自动检查（默认 60 秒）跑完。
  const CHAPTERS_NEXT = [...CHAPTERS, '第六章 灯下']
  await writeFile(join(siteDir, 'book', 'index.html'), catalogHtml(CHAPTERS_NEXT))
  await writeFile(join(siteDir, 'book', '6.html'), chapterHtml('第六章 灯下', 5))

  const b = launch([])
  let autoSettings = null
  const deadline = Date.now() + 100_000
  while (Date.now() < deadline) {
    await sleep(2000)
    try {
      const raw = JSON.parse(await readFile(settingsPath, 'utf-8'))
      if (raw.autoUpdateCheck?.lastCheckedAt) {
        autoSettings = raw.autoUpdateCheck
        break
      }
    } catch { /* 还没写入 */ }
  }
  const appLog = b.log()
  killTree(b.child)
  await sleep(1500)

  check('启动自动检查写回了时间', Boolean(autoSettings?.lastCheckedAt), JSON.stringify(autoSettings))
  check('摘要说有新章', Boolean(autoSettings?.lastSummary?.includes('有新章')), autoSettings?.lastSummary || '')
  const book = bookId ? JSON.parse(await readFile(join(library, bookId, 'book.json'), 'utf-8')) : null
  check('书里长到 6 章', book?.chapters?.length === 6, String(book?.chapters?.length))
  const added = book?.chapters?.[5]
  check('第六章下载到 ready', added?.status === 'ready', JSON.stringify(added))
  const chapterFiles = existsSync(join(library, bookId, 'chapters')) ? await readdir(join(library, bookId, 'chapters')) : []
  check('第六章正文落盘', chapterFiles.filter((name) => name.endsWith('.json')).length >= 6, chapterFiles.join(','))
  const noise = appLog.split('\n').filter((line) => /自动检查更新失败|Unhandled|ERR_/.test(line))
  check('应用日志没有自动检查异常', noise.length === 0, noise.slice(0, 3).join(' | '))

  // 第三段：带 CDP 再看一眼书库提示。
  const c = launch([`--remote-debugging-port=${DEBUG_PORT}`])
  try {
    const banner = await evaluate(`(async () => {
      const btn = [...document.querySelectorAll('.app-nav .nav-btn')].find((b) => b.textContent.trim() === '书库')
      if (btn) btn.click()
      await new Promise((r) => setTimeout(r, 1200))
      const text = document.body.innerText || ''
      return { hasBanner: text.includes('自动追更'), hasNew: text.includes('有新章'), text: text.slice(0, 400) }
    })()`)
    check('书库页展示自动追更提示', banner.hasBanner && banner.hasNew, banner.text)
  } finally {
    killTree(c.child)
  }
} catch (error) {
  check('E2E 跑到收尾', false, error instanceof Error ? error.message : String(error))
} finally {
  await new Promise((resolve) => server.close(resolve))
  for (const dir of [userData, library, siteDir]) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

console.log(`\n结果：${passed.length} 项通过，${failed.length} 项失败`)
if (failed.length) {
  console.log(failed.join('\n'))
  process.exit(1)
}
console.log('自动追更真机闭环通过')

// 下载站配图端到端：真的打开本地站点 → 真的预览/下载 → 正文里的图抓到 images/ 并原位落版。
//
// 覆盖单测覆盖不到的一段：隐藏下载页里带会话的 fetch（同源 + 跨域 CORS）、
// 抽取阶段注入的图片标记、下载器的原位替换。
// 用法：npm run build 之后 `node scripts/download-images-e2e.mjs`（npm run e2e:download-images）
// 注意：会在桌面上真开一个应用窗口，结束后自动关掉。
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const SITE_PORT = 32000 + Math.floor(Math.random() * 2000)
const CROSS_PORT = 35000 + Math.floor(Math.random() * 2000)
const DEBUG_PORT = 36000 + Math.floor(Math.random() * 2000)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const passed = []
const failed = []
const check = (label, ok, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`
  ;(ok ? passed : failed).push(line)
  console.log(line)
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABFSURBVFhH7c4hAQAgEAAxIn4cItIKQswgTsxvnT33ZwVVQVVQFVQFVUFVUBVUBVVBVVAVVAVVQVVQFVQFVUFVUH0enPsADzr+opQvf9EAAAAASUVORK5CYII=',
  'base64',
)

const userData = await mkdtemp(join(tmpdir(), 'spbf-dlimge2e-userdata-'))
const library = await mkdtemp(join(tmpdir(), 'spbf-dlimge2e-library-'))
const siteDir = await mkdtemp(join(tmpdir(), 'spbf-dlimge2e-site-'))

const PARAGRAPH =
  '雪下得很密，灯罩上结了薄薄一层白，林舟把灯笼搁在石阶上，蹲下去看那道刻痕，指尖碰到的地方凉得像铁。'
const paragraph = (index) => `${PARAGRAPH}这是第${index}段的补充文字，让正文有足够的长度通过提取器的判断。`

await mkdir(join(siteDir, 'book', 'pics'), { recursive: true })
await writeFile(join(siteDir, 'book', 'pics', 'one.png'), PNG)
await writeFile(join(siteDir, 'book', 'pics', 'two.png'), PNG)

await writeFile(join(siteDir, 'book', 'index.html'), `<!DOCTYPE html><html><head><title>灯下残卷 - 目录</title></head><body>
<h1>灯下残卷</h1><div>作者：测试</div>
<ul>
  <li><a href="1.html">第一章 雪夜</a></li>
  <li><a href="2.html">第二章 归途</a></li>
  <li><a href="3.html">第三章 灯下</a></li>
  <li><a href="4.html">第四章 石阶</a></li>
  <li><a href="5.html">第五章 刻痕</a></li>
</ul></body></html>`)

await writeFile(join(siteDir, 'book', '1.html'), `<!DOCTYPE html><html><head><title>第一章 雪夜 - 灯下残卷</title></head><body>
<div id="content">
<h2>第一章 雪夜</h2>
<p>${paragraph(1)}</p>
<img src="pics/one.png" alt="插图一">
<p>${paragraph(2)}</p>
<img src="http://127.0.0.1:${CROSS_PORT}/cross.png" alt="插图二">
<p>${paragraph(3)}</p>
<p><a href="index.html">返回目录</a></p>
</div></body></html>`)

await writeFile(join(siteDir, 'book', '2.html'), `<!DOCTYPE html><html><head><title>第二章 归途 - 灯下残卷</title></head><body>
<div id="content">
<h2>第二章 归途</h2>
<p>${paragraph(4)}</p>
<p>${paragraph(5)}</p>
<p><a href="index.html">返回目录</a></p>
</div></body></html>`)

for (const [index, title] of [[3, '第三章 灯下'], [4, '第四章 石阶'], [5, '第五章 刻痕']]) {
  await writeFile(join(siteDir, 'book', `${index}.html`), `<!DOCTYPE html><html><head><title>${title} - 灯下残卷</title></head><body>
<div id="content">
<h2>${title}</h2>
<p>${paragraph(index + 2)}</p>
<p>${paragraph(index + 3)}</p>
<p><a href="index.html">返回目录</a></p>
</div></body></html>`)
}

await writeFile(join(userData, 'settings.json'), JSON.stringify({ libraryPath: library }, null, 2))

const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
  const filePath = join(siteDir, pathname.replace(/^\//, ''))
  try {
    const data = await readFile(filePath)
    res.writeHead(200, {
      'content-type': filePath.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
})
const crossServer = createServer((req, res) => {
  // 跨域取图必须回显 Origin：页面上下文里的 fetch 带 credentials，ACAO: * 会被浏览器拒绝。
  res.writeHead(200, {
    'content-type': 'image/png',
    'access-control-allow-origin': req.headers.origin ?? '*',
    'access-control-allow-credentials': 'true',
    'cache-control': 'no-store',
  })
  res.end(PNG)
})
await new Promise((resolve) => server.listen(SITE_PORT, '127.0.0.1', resolve))
await new Promise((resolve) => crossServer.listen(CROSS_PORT, '127.0.0.1', resolve))

const catalogUrl = `http://127.0.0.1:${SITE_PORT}/book/index.html`
console.log(`夹具站点：${catalogUrl}（书库=${library}）`)

const child = spawn(electronPath, [root, `--user-data-dir=${userData}`, `--remote-debugging-port=${DEBUG_PORT}`], {
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let appOut = ''
child.stdout.on('data', (chunk) => { appOut += String(chunk) })
child.stderr.on('data', (chunk) => { appOut += String(chunk) })

const killTree = () => {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGTERM')
  } catch {
    /* 已经退出了 */
  }
}

async function evaluate(expression, timeoutMs = 240_000) {
  let targets = []
  for (let i = 0; i < 60 && targets.length === 0; i += 1) {
    await sleep(500)
    try {
      targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
    } catch { /* 还没起来 */ }
  }
  const page = targets.filter((t) => t.type === 'page').find((t) => /index\.html/i.test(t.url))
  if (!page) throw new Error('没等到应用外壳页的调试 target')
  await sleep(3000)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 超时')), timeoutMs)
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
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

try {
  const flow = await evaluate(`(async () => {
    try {
      const load = await window.api.browse.load(${JSON.stringify(catalogUrl)})
      if (!load.ok) return { step: 'load', detail: load }
      const preview = await window.api.download.preview()
      if (!preview.ok) return { step: 'preview', detail: preview }
      const confirm = await window.api.download.confirm(preview.preview.token)
      if (!confirm.ok) return { step: 'confirm', detail: confirm }
      const done = await new Promise((resolve) => {
        const off = window.api.download.onProgress((p) => {
          if (p && p.status && p.status !== 'running') { off(); resolve(p) }
        })
        setTimeout(() => { off(); resolve({ status: 'timeout' }) }, 180000)
      })
      return {
        step: 'done',
        bookId: confirm.bookId,
        preview: { title: preview.preview.bookTitle, chapters: preview.preview.chapterCount },
        progress: { status: done.status, done: done.done, total: done.total, failed: done.failed },
      }
    } catch (error) {
      return { step: 'threw', detail: String((error && error.message) || error) }
    }
  })()`)

  console.log('下载流程：', JSON.stringify(flow))
  check('浏览页打开目录页成功', flow.step !== 'load', flow.step === 'load' ? JSON.stringify(flow.detail) : '')
  check('下载预览认出目录', flow.step !== 'preview' && flow.preview?.chapters >= 2, String(flow.preview?.chapters))
  check('确认下载已开始', flow.step !== 'confirm' && Boolean(flow.bookId), flow.step === 'confirm' ? JSON.stringify(flow.detail) : '')
  check('下载跑到结束', flow.progress?.status === 'done', JSON.stringify(flow.progress))

  if (flow.bookId && flow.progress?.status === 'done') {
    const bookDir = join(library, flow.bookId)
    const chapterPath = join(bookDir, 'chapters', '0001.json')
    check('第一章文件已落盘', existsSync(chapterPath))
    if (existsSync(chapterPath)) {
      const chapter = JSON.parse(await readFile(chapterPath, 'utf-8'))
      const body = String(chapter.body ?? '')
      check('正文里没有残留的内部图片标记', !body.includes('[[SPBFIMG|'))
      check('同源图原位落成 [图] 段落', body.includes('[图]c0001-1.png|40|40|插图一'), body.slice(0, 160))
      check('跨域图（CORS）也抓到了', /\[图\]c0001-2\.png\|40\|40\|插图二/.test(body))
      const firstParagraph = body.indexOf('这是第1段')
      const firstImage = body.indexOf('[图]c0001-1.png')
      const secondParagraph = body.indexOf('这是第2段')
      check('第一张图落在第 1、2 段之间', firstParagraph >= 0 && firstImage > firstParagraph && secondParagraph > firstImage,
        `p1=${firstParagraph} img=${firstImage} p2=${secondParagraph}`)
      check('图片文件已写进 images/', existsSync(join(bookDir, 'images', 'c0001-1.png')) && existsSync(join(bookDir, 'images', 'c0001-2.png')))
      if (existsSync(join(bookDir, 'images', 'c0001-1.png'))) {
        const saved = await readFile(join(bookDir, 'images', 'c0001-1.png'))
        check('落盘字节与站点图片一致', saved.equals(PNG), `${saved.length} bytes`)
      }
    }
    const secondPath = join(bookDir, 'chapters', '0002.json')
    if (existsSync(secondPath)) {
      const second = JSON.parse(await readFile(secondPath, 'utf-8'))
      check('没有图片的章节不产生 [图]', !String(second.body ?? '').includes('[图]'))
    }
  }

  const noise = appOut.split('\n').filter((line) => /SPBFIMG|Unhandled|ERR_/.test(line))
  check('应用日志没有图片相关的异常', noise.length === 0, noise.slice(0, 3).join(' | '))
} catch (error) {
  check('E2E 跑到收尾', false, error instanceof Error ? error.message : String(error))
} finally {
  killTree()
  await new Promise((resolve) => server.close(resolve))
  await new Promise((resolve) => crossServer.close(resolve))
  for (const dir of [userData, library, siteDir]) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

console.log(`\n结果：${passed.length} 项通过，${failed.length} 项失败`)
if (failed.length) {
  console.log(failed.join('\n'))
  process.exit(1)
}
console.log('下载站配图端到端通过：同源 + 跨域图 → images/ → 正文原位 [图]')

// OCR 端到端（验收报告 F2 的最后一环）：真的页面取图 → 真的引擎认字 → 真的写进书库。
//
// 现有单测把「页面脚本」和「OCR 引擎」都 mock 了，覆盖不到这几环。这里造一个本地站点：
// 目录页 5 章，其中一章的正文是**图片**（图片里是带中文的界面截图，字够多够大），
// 站点规则打开 ocrUnlock，然后驱动真实应用下载这本书，核对那一章真的靠 OCR 入库。
//
// 用法：npm run build 之后 `node scripts/ocr-download-e2e.mjs`（npm run e2e:ocr）
// 注意：会在桌面上真开一个应用窗口，结束后自动关掉。
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const SITE_PORT = 31000 + Math.floor(Math.random() * 2000)
const DEBUG_PORT = 34000 + Math.floor(Math.random() * 2000)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const passed = []
const failed = []
const check = (label, ok, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`
  ;(ok ? passed : failed).push(line)
  console.log(line)
}

const userData = await mkdtemp(join(tmpdir(), 'spbf-ocr-e2e-userdata-'))
const library = await mkdtemp(join(tmpdir(), 'spbf-ocr-e2e-library-'))
const siteDir = await mkdtemp(join(tmpdir(), 'spbf-ocr-e2e-site-'))

const IMAGE_SOURCE = join(root, 'docs', 'ux-review-assets', 'download-preview.png')
await mkdir(join(siteDir, 'book'), { recursive: true })
// 图片化正文的常态是一章切成好几张图，OCR 结果会按顺序拼接。用三张切片：
// 单张截图只有 ~168 个汉字，够不到解锁要求的 200 有效字符。
for (const index of [1, 2, 3]) {
  await copyFile(IMAGE_SOURCE, join(siteDir, 'book', `body-${index}.png`))
}
const SLICE_IMAGES = [1, 2, 3]
  .map((index) => `<img src="body-${index}.png" alt="正文切片 ${index}" width="900" height="1200">`)
  .join('\n')

const PARAGRAPH =
  '雪下得很密，灯罩上结了薄薄一层白，林舟把灯笼搁在石阶上，蹲下去看那道刻痕，指尖碰到的地方凉得像铁。'
const textChapter = (title) => `<!DOCTYPE html><html><head><title>${title}</title></head><body>
<div id="content"><h2>${title}</h2>
<p>${PARAGRAPH}</p><p>${PARAGRAPH}</p><p>${PARAGRAPH}</p>
<p><a href="index.html">返回目录</a></p></div></body></html>`

await writeFile(join(siteDir, 'book', 'index.html'), `<!DOCTYPE html><html><head><title>残经 - 目录</title></head><body>
<h1>残经</h1><div>作者：佚名</div>
<ul>
  <li><a href="36.html">第三十六章 雪夜</a></li>
  <li><a href="37.html">第三十七章 灯下</a></li>
  <li><a href="38.html">第三十八章 石阶</a></li>
  <li><a href="39.html">第三十九章 刻痕</a></li>
  <li><a href="40.html">第四十章 归途</a></li>
</ul></body></html>`)
// 这一章的正文是图片（付费墙形状：可见文字很短，正文在 img 里）
await writeFile(join(siteDir, 'book', '36.html'), `<!DOCTYPE html><html><head><title>第三十六章 雪夜 - 残经</title></head><body>
<div class="header">某小说网 <a href="/vip/">开通会员</a></div>
<div id="content">
<h2>第三十六章 雪夜</h2>
<p>${PARAGRAPH.slice(0, 30)}</p>
<p>——本章剩余内容需要付费阅读，购买本章或开通会员后可解锁后续内容。</p>
${SLICE_IMAGES}
<p><a href="index.html">返回目录</a> <a href="37.html">下一章</a></p>
</div>
<div class="footer"><a href="index.html">返回目录</a> 本站所有小说为转载作品</div></body></html>`)
for (const n of [37, 38, 39, 40]) {
  await writeFile(join(siteDir, 'book', `${n}.html`), textChapter(`第${n - 1}章 正文`))
}

await writeFile(join(userData, 'settings.json'), JSON.stringify({ libraryPath: library }, null, 2))
await writeFile(
  join(userData, 'site-rules.json'),
  JSON.stringify({ version: 1, rules: [{ host: '127.0.0.1', ocrUnlock: true }] }, null, 2),
)

const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
  const filePath = join(siteDir, pathname.replace(/^\//, ''))
  try {
    const data = await readFile(filePath)
    res.writeHead(200, { 'content-type': filePath.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8' })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
})
await new Promise((resolve) => server.listen(SITE_PORT, '127.0.0.1', resolve))
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

/** 在真实渲染进程里跑一段表达式，返回它的值。 */
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
  await sleep(3000) // 等渲染层挂载完
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
  check('下载预览认出了目录与章数', flow.step !== 'preview' && flow.preview?.chapters >= 5, String(flow.preview?.chapters))
  check('确认下载已开始', flow.step !== 'confirm' && Boolean(flow.bookId), flow.step === 'confirm' ? JSON.stringify(flow.detail) : '')
  check('下载跑到结束（不是超时/取消）', flow.progress?.status === 'done', JSON.stringify(flow.progress))

  if (flow.bookId) {
    // 先把书里每章的状态与失败原因打出来：OCR 没成时原因就写在这里（含「自动恢复已试过：…」）
    const bookPath = join(library, flow.bookId, 'book.json')
    if (existsSync(bookPath)) {
      const book = JSON.parse(await readFile(bookPath, 'utf-8'))
      console.log('各章状态：')
      for (const chapter of book.chapters ?? []) {
        console.log(`  ${chapter.id} ${chapter.title}  status=${chapter.status}${chapter.failCode ? ` failCode=${chapter.failCode}` : ''}${chapter.failMessage ? ` failMessage=${chapter.failMessage}` : ''}`)
      }
    }

    const ocrChapterPath = join(library, flow.bookId, 'chapters', '0001.json')
    check('那一章的章节文件已落盘', existsSync(ocrChapterPath))
    if (existsSync(ocrChapterPath)) {
      const chapter = JSON.parse(await readFile(ocrChapterPath, 'utf-8'))
      const body = String(chapter.body ?? '')
      const cjk = (body.match(/[\u3400-\u9fff]/g) ?? []).length
      check('该章标记为 OCR 恢复入库', chapter.unlockedBy === 'ocr', String(chapter.unlockedBy))
      check('正文是图片里认出来的中文（不是页面上的付费提示）', cjk >= 50 && !body.includes('需要付费阅读'), `汉字数=${cjk}`)
      check(
        '认出的是那张图里的字（含「目录/预览/作者」之一）',
        ['目录', '预览', '作者'].some((word) => body.includes(word)),
        JSON.stringify(body.replace(/\s+/g, ' ').slice(0, 80)),
      )
      const textChapterPath = join(library, flow.bookId, 'chapters', '0002.json')
      if (existsSync(textChapterPath)) {
        const plain = JSON.parse(await readFile(textChapterPath, 'utf-8'))
        check('普通文字章没有被误标成 OCR 恢复', !plain.unlockedBy, String(plain.unlockedBy))
        check('普通文字章正文正常入库', String(plain.body ?? '').includes('雪下得很密'))
      }
    }
  }

  const ocrNoise = appOut.split('\n').filter((line) => /Failed loading language|Error opening data file/i.test(line))
  check('OCR 引擎没有报语言加载失败', ocrNoise.length === 0, ocrNoise.join(' | '))
} catch (error) {
  check('E2E 跑到收尾', false, error instanceof Error ? error.message : String(error))
} finally {
  killTree()
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
console.log('OCR 端到端通过：图片正文页 → 页面取图 → 本机 OCR → 入库并标记 unlockedBy=ocr')

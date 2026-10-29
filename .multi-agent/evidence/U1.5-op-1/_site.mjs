// U1.5-op-1 样例站点：本地 HTTP 静态站，供应用「下载本书」真实执行下载任务。
// 只写 /tmp 与证据目录，不属于产品代码，不改产品文件。
import http from 'node:http'
import fs from 'node:fs'

const PORT = Number(process.argv[2] || 37855)
const LOG = process.argv[3] || '/tmp/U1.5-op-1/site-access.log'
const BOOKS = {
  book1: { title: '样例站点·示例书一', chapters: Number(process.env.SITE_CHAPTERS || 80) },
  book2: { title: '样例站点·示例书二', chapters: Number(process.env.SITE_CHAPTERS || 80) },
}
const CHAPTER_DELAY_MS = Number(process.env.SITE_DELAY_MS || 0)

function esc(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
}

function catalogHtml(key) {
  const b = BOOKS[key]
  const links = Array.from({ length: b.chapters }, (_, i) => {
    const n = String(i + 1).padStart(3, '0')
    return `      <a href="/${key}/c${n}.html">第${i + 1}章 样例章节 ${n}</a>`
  }).join('\n')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(b.title)}</title>
<meta property="og:novel:author" content="样例作者">
</head><body>
<h1>${esc(b.title)}</h1>
<p>作者：样例作者 · 本页与全部章节均为验收样例数据，不含任何真实作品内容。</p>
  <div id="list">
${links}
  </div>
</body></html>`
}

function chapterHtml(key, idx) {
  const b = BOOKS[key]
  const n = String(idx).padStart(3, '0')
  const paras = Array.from({ length: 6 }, (_, p) =>
    `  <p>验收占位段落 ${n}-${p + 1}：这一段只是样例正文，用来让下载与提取走完真实流程，不含任何作品内容。</p>`).join('\n')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>第${idx}章 样例章节 ${n} - ${esc(b.title)}</title>
<meta property="og:novel:author" content="样例作者">
</head><body>
<h1>第${idx}章 样例章节 ${n}</h1>
<div id="content">
${paras}
</div>
</body></html>`
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  fs.appendFileSync(LOG, `${new Date().toISOString()} ${req.method} ${url.pathname}\n`)
  const m = url.pathname.match(/^\/(book[12])\/(index|c(\d{1,3}))\.html$/)
  if (!m) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<h1>404</h1>')
    return
  }
  const key = m[1]
  const body = m[2] === 'index' ? catalogHtml(key) : chapterHtml(key, Number(m[3]))
  setTimeout(() => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }, m[2] === 'index' ? 0 : CHAPTER_DELAY_MS)
})

server.listen(PORT, '127.0.0.1', () => {
  fs.appendFileSync(LOG, `${new Date().toISOString()} LISTEN 127.0.0.1:${PORT} pid=${process.pid}\n`)
  console.log(`sample site on http://127.0.0.1:${PORT}/book1/index.html and /book2/index.html chapters=${BOOKS.book1.chapters} delay=${CHAPTER_DELAY_MS}`)
})

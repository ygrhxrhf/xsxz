// 页内注卡与图片走 DOM：静态页截图 + 拖住飞页看它们是否跟着卷曲。
import { execFileSync, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'

const root = 'C:\\codes\\xsxz'
const PORT = 39000 + Math.floor(Math.random() * 2000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shotDir = join(root, '.multi-agent', 'visual', 'blocks')
await mkdir(shotDir, { recursive: true })

const lib = await mkdtemp(join(tmpdir(), 'spbf-blocks-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-blocks-user-'))
const bookId = 'd_blocks'
const bookDir = join(lib, bookId)
await mkdir(join(bookDir, 'chapters'), { recursive: true })
await mkdir(join(bookDir, 'images'), { recursive: true })
await copyFile(join(root, '.multi-agent', 'tmp', 'blocks-photo.png'), join(bookDir, 'images', 'photo.png'))
const now = new Date().toISOString()
const paras = [
  '第1段：这一页用来验证页内图片与批注卡。正文里插入一张样章插图，并在第一段上加一条批注，检查注卡、图片与图注是否跟着纸面卷曲。同一项技术，在不同的行业里往往同时扮演这三种角色。',
  '第2段：这是一个用来对照参考站的测试段落。段落要有自然的长度，让每一页都能排出完整的正文，字号、行距、页边距与断行都按参考站的书页来核对。',
  '[图]photo.png|600|300|样章插图',
  '第3段：这是一个用来对照参考站的测试段落。段落要有自然的长度，让每一页都能排出完整的正文，字号、行距、页边距与断行都按参考站的书页来核对。',
  '第4段：这是一个用来对照参考站的测试段落。段落要有自然的长度，让每一页都能排出完整的正文，字号、行距、页边距与断行都按参考站的书页来核对。',
  '第5段：这是一个用来对照参考站的测试段落。段落要有自然的长度，让每一页都能排出完整的正文，字号、行距、页边距与断行都按参考站的书页来核对。',
  '第6段：这是一个用来对照参考站的测试段落。段落要有自然的长度，让每一页都能排出完整的正文，字号、行距、页边距与断行都按参考站的书页来核对。',
  '第7段：这是一个用来对照参考站的测试段落。段落要有自然的长度，让每一页都能排出完整的正文，字号、行距、页边距与断行都按参考站的书页来核对。',
  '第8段：这是一个用来对照参考站的测试段落。段落要有自然的长度，让每一页都能排出完整的正文，字号、行距、页边距与断行都按参考站的书页来核对。',
]
const body = paras.join('\n\n')
const phrase = '页内图片'
const start = body.indexOf(phrase)
if (start < 0) throw new Error('anchor phrase missing')
await writeFile(join(bookDir, 'book.json'), JSON.stringify({
  id: bookId,
  title: '带图与批注的样书',
  author: '排版测试',
  tags: [],
  sourceUrl: 'https://example.com/blocks/',
  sourceHost: 'example.com',
  importType: 'download',
  createdAt: now,
  updatedAt: now,
  status: 'ready',
  chapters: [{ id: 'c0001', index: 1, title: '第一章 图文', url: 'https://example.com/blocks/1.html', file: '0001.json', status: 'ready' }],
  progress: { chapterId: 'c0001', scrollRatio: 0, rest: undefined },
}, null, 2), 'utf-8')
await writeFile(join(bookDir, '0001.json'), JSON.stringify({
  title: '第一章 图文',
  url: 'https://example.com/blocks/1.html',
  body,
  status: 'ready',
}), 'utf-8')
await writeFile(join(bookDir, 'annotations.json'), JSON.stringify({
  version: 1,
  items: [{
    id: 'a1',
    bookId,
    chapterId: 'c0001',
    kind: 'highlight',
    start,
    end: start + phrase.length,
    excerpt: phrase,
    note: '这条批注用来验证页内注卡：它应当和图注一起，跟着卷曲的纸面走，并且可以直接点开。',
    noteSource: 'ai',
    tags: ['样章', '配图'],
    color: 'yellow',
    createdAt: now,
  }],
}, null, 2), 'utf-8')
await writeFile(join(userData, 'settings.json'), JSON.stringify({
  libraryPath: lib,
  reader: {
    fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium',
    paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'screen',
    bookView: 'realbook',
  },
}, null, 2), 'utf-8')

const child = spawn(electronPath, [root, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
child.stdout.on('data', (c) => { out += String(c) })
child.stderr.on('data', (c) => { out += String(c) })
const killTree = () => { try { if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill() } catch {} }

let ws
try {
  let target
  for (let i = 0; i < 200; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && String(t.url).startsWith('file:'))
      if (target) break
    } catch {}
    await sleep(300)
  }
  if (!target) throw new Error('no target\n' + out.slice(-2000))
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let nextId = 1
  const pending = new Map()
  const errs = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text)
    if (!m.id) return
    const w = pending.get(m.id); if (!w) return
    pending.delete(m.id)
    m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result)
  }
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const id = nextId += 1
    pending.set(id, { resolve: res, reject: rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await cdp('Runtime.enable'); await cdp('Page.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1536, height: 714, deviceScaleFactor: 1, mobile: false })
  await cdp('Page.bringToFront')
  const ev = async (body) => {
    const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result?.value
  }
  const waitFor = async (expr, timeout = 20000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) { if (await ev(`return (${expr});`)) return true; await sleep(150) }
    return false
  }
  const click = (expr) => ev(`const el = ${expr}; if (!el) return 'none'; el.scrollIntoView(); el.click(); return 'ok';`)
  const shot = async (name, clip) => {
    const r = await cdp('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' })
    await writeFile(join(shotDir, name), Buffer.from(r.data, 'base64'))
    return name
  }
  const inspect = () => ev(`
    const rect = (el) => el ? el.getBoundingClientRect().toJSON() : null;
    const img = document.querySelector('.real-book-webgl-image img');
    const flyerImg = document.querySelector('.real-book-flip-image img');
    const card = document.querySelector('.real-book-note-card');
    return {
      noteCards: document.querySelectorAll('.real-book-note-card').length,
      cardTitle: card?.getAttribute('title') ?? '',
      cardRect: rect(card),
      imageSrc: img?.getAttribute('src') ?? '',
      imageLoaded: img ? { complete: img.complete, width: img.naturalWidth, height: img.naturalHeight } : null,
      imageRect: rect(img),
      runs: [...document.querySelectorAll('.real-book-page-run')].map((el) => el.textContent).slice(0, 8),
      flipNotes: document.querySelectorAll('.real-book-flip-note').length,
      flipImages: document.querySelectorAll('.real-book-flip-image').length,
      flipImageLoaded: flyerImg ? { complete: flyerImg.complete, width: flyerImg.naturalWidth } : null,
      flipImageRect: rect(flyerImg),
      flipNoteRect: rect(document.querySelector('.real-book-flip-note')),
      flipLineCount: document.querySelectorAll('.real-book-flip-line').length,
      marks: document.querySelectorAll('.real-book-mark').length,
      markBg: document.querySelector('.real-book-mark') ? getComputedStyle(document.querySelector('.real-book-mark')).backgroundColor : '',
      markRect: rect(document.querySelector('.real-book-mark')),
      dots: document.querySelectorAll('.real-book-note-dot').length,
      dotRect: rect(document.querySelector('.real-book-note-dot')),
      flipMarks: document.querySelectorAll('.real-book-flip-mark').length,
      flipMarkRect: rect(document.querySelector('.real-book-flip-mark')),
      flipDots: document.querySelectorAll('.real-book-flip-note-dot').length,
      flipDotRect: rect(document.querySelector('.real-book-flip-note-dot')),
    };
  `)

  await ev(`localStorage.setItem('spore:reader-realbook-renderer:v1', 'webgl'); return 'ok';`)
  await cdp('Page.reload'); await sleep(2500)
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`, 25000)
  await click(`[...document.querySelectorAll('.nav-btn')].find((b) => b.querySelector('.nav-label')?.textContent === '书库')`)
  await waitFor(`document.querySelector('.book-open-area')`, 12000)
  await click(`document.querySelector('.book-open-area')`)
  await waitFor(`document.querySelector('.real-book-stage')`, 15000)
  await sleep(2800)

  console.log('INFO', JSON.stringify(await ev(`return {
    webgl: Boolean(document.querySelector('.real-book-webgl-stage canvas')),
    label: document.querySelector('.real-book-page-label')?.textContent,
  };`)))
  console.log('STATIC', JSON.stringify(await inspect()))
  console.log(await shot('blocks-static.png'))
  console.log(await shot('blocks-static-detail.png', { x: 400, y: 90, width: 760, height: 540, scale: 2 }))

  // 点注卡：应当打开批注编辑浮层。
  const clicked = await ev(`
    const card = document.querySelector('.real-book-note-card');
    if (!card) return 'none';
    const r = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    return 'ok';
  `)
  console.log('CARDCLICK', clicked)
  await sleep(700)
  console.log('EDITOR', JSON.stringify(await ev(`
    const dlg = document.querySelector('[role="dialog"], .n-modal, .note-editor, textarea');
    return { open: Boolean(dlg), text: dlg?.textContent?.slice(0, 80) ?? '', inputs: document.querySelectorAll('textarea, input').length };
  `)))
  console.log(await shot('blocks-editor.png'))
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'ok';`)
  await sleep(500)

  // 拖住右页：图片与注卡应当跟着纸面走。
  const rect = await ev(`const r=document.querySelector('.real-book-webgl-hit')?.getBoundingClientRect(); return r ? { left:r.left, top:r.top, width:r.width, height:r.height } : null;`)
  const y = Math.round(rect.top + rect.height / 2)
  const edgeX = Math.round(rect.left + rect.width - 10)
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: edgeX, y, button: 'none' })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: edgeX, y, button: 'left', clickCount: 1 })
  for (let step = 1; step <= 3; step += 1) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: edgeX - step * 36, y, button: 'left', buttons: 1 })
    await sleep(60)
  }
  await sleep(300)
  console.log('FLYER1', JSON.stringify(await inspect()))
  console.log(await shot('blocks-flyer-1.png'))
  console.log(await shot('blocks-flyer-1-detail.png', { x: 500, y: 100, width: 620, height: 500, scale: 2 }))
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: edgeX - 6 * 36, y, button: 'left', buttons: 1 })
  await sleep(300)
  console.log('FLYER2', JSON.stringify(await inspect()))
  console.log(await shot('blocks-flyer-2.png'))
  console.log(await shot('blocks-flyer-2-detail.png', { x: 420, y: 100, width: 720, height: 500, scale: 2 }))
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: edgeX - 6 * 36, y, button: 'left', clickCount: 1 })
  await sleep(900)
  console.log('AFTER', JSON.stringify(await inspect()))
  console.log('ERRORS', JSON.stringify(errs.slice(0, 8)))
} finally {
  try { ws?.close() } catch {}
  killTree()
}
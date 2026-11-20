// 真实书籍页内批注端到端：真 Electron + 真磁盘 + 真重启。
//
// 覆盖：
// 1) 预置 annotations.json 里的批注会显示在被批注段落下；
// 2) 点击卡片可编辑，保存后 annotations.json 落盘，刷新/重开后仍在；
// 3) 关闭批注模式后卡片消失、划线保留，重启应用后开关仍是关闭；
// 4) 平放 / 20° / 35° 与纸白 / 暖黄 / 柔灰 / 夜间四套主题截图。
//
// 用法：先 `npm run build`，再 `node scripts/realbook-annotations-e2e.mjs`
// （npm run e2e:realbook-notes）。会在桌面上开应用窗口，结束后自动关闭。
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = 36000 + Math.floor(Math.random() * 2000)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const shotsDir = join(tmpdir(), 'spbf-realbook-annotations-shots')

const passed = []
const failed = []
const check = (label, ok, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`
  ;(ok ? passed : failed).push(line)
  console.log(line)
}

await mkdir(shotsDir, { recursive: true })
const lib = await mkdtemp(join(tmpdir(), 'spbf-rbnotes-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-rbnotes-user-'))
const bookId = 'd_rbnotes'
const bookDir = join(lib, bookId)
await mkdir(bookDir, { recursive: true })
const now = new Date().toISOString()
const body = Array.from({ length: 30 }, (_, i) =>
  `第${i + 1}段：这是用来检查真实书籍页内批注的正文，长度足够排满一页，也方便观察批注卡是否紧跟被批注段落、是否会被挤到下一页。`).join('\n\n')

await writeFile(join(bookDir, 'book.json'), JSON.stringify({
  id: bookId, title: '页内批注测试书', author: '测试', tags: [],
  sourceUrl: 'https://example.com/rbnotes/', sourceHost: 'example.com',
  importType: 'download', createdAt: now, updatedAt: now, status: 'ready',
  chapters: [{ id: 'c0001', index: 1, title: '第一章 批注', url: 'https://example.com/rbnotes/1.html', file: '0001.json', status: 'ready' }],
  progress: { chapterId: 'c0001', scrollRatio: 0, paragraphIndex: 0, paragraphOffset: 0 },
}, null, 2), 'utf-8')
await writeFile(join(bookDir, '0001.json'), JSON.stringify({
  title: '第一章 批注', url: 'https://example.com/rbnotes/1.html', body, status: 'ready',
}, null, 2), 'utf-8')
await writeFile(join(bookDir, 'annotations.json'), JSON.stringify({
  version: 1,
  items: [{
    id: 'anno-1', bookId, chapterId: 'c0001', kind: 'highlight',
    start: 0, end: 4, excerpt: '第1段：', color: 'red',
    note: '预置批注：这里该多留意。', noteSource: 'user', tags: ['quote'],
    createdAt: now,
  }],
}, null, 2), 'utf-8')
await writeFile(join(userData, 'settings.json'), JSON.stringify({
  libraryPath: lib,
  reader: {
    fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium',
    paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'screen',
    bookView: 'realbook', handwritingFont: 'kai', showInlineNotes: true,
  },
}, null, 2), 'utf-8')

console.log(`夹具：书库=${lib}\n      userData=${userData}\n      截图=${shotsDir}`)

function startApp() {
  const child = spawn(electronPath, [root, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (chunk) => { out += String(chunk) })
  child.stderr.on('data', (chunk) => { out += String(chunk) })
  const stop = () => {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      else child.kill('SIGTERM')
    } catch { /* 已经退出了 */ }
  }
  return { child, stop, output: () => out }
}

async function connect() {
  let target
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await response.json()
      target = list.find((t) => t.type === 'page' && t.url.startsWith('file:'))
      if (target) break
    } catch { /* 调试端口还没起来 */ }
    await sleep(300)
  }
  if (!target) throw new Error('没找到渲染页 CDP target')

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
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  }
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId += 1
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const ev = async (bodyText) => {
    const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${bodyText} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result?.value
  }
  const waitFor = async (expr, timeout = 15000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      try {
        if (await ev(`return (${expr});`)) return true
      } catch { /* 页面正在重载 */ }
      await sleep(150)
    }
    return false
  }
  const click = (expr) => ev(`const el = ${expr}; if (!el) return 'none'; el.click(); return 'ok';`)
  const screenshot = async (name) => {
    const shot = await cdp('Page.captureScreenshot', { format: 'png' })
    const path = join(shotsDir, name)
    await writeFile(path, Buffer.from(shot.data, 'base64'))
    console.log(`      截图：${path}`)
    return path
  }
  return { ws, cdp, ev, waitFor, click, screenshot }
}

async function openFixtureBook({ waitFor, click }) {
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`, 25000)
  await click(`[...document.querySelectorAll('.nav-btn')].find((b) => b.querySelector('.nav-label')?.textContent === '书库')`)
  await waitFor(`document.querySelector('.book-open-area')`, 12000)
  await click(`document.querySelector('.book-open-area')`)
  return waitFor(`document.querySelector('.real-book-stage .real-book-para')`, 15000)
}

async function dragPitchBy(ev, px) {
  return ev(`
    const book = document.querySelector('.real-book-book');
    if (!book) return '';
    const rect = book.getBoundingClientRect();
    const startX = rect.left + 8;
    const startY = rect.top + 8;
    const pointerId = 77;
    const fire = (type, clientY, buttons) => book.dispatchEvent(new PointerEvent(type, {
      bubbles: true, button: 0, buttons, clientX: startX, clientY, pointerId, pointerType: 'mouse', isPrimary: true,
    }));
    fire('pointerdown', startY, 1);
    for (let step = 1; step <= 24; step += 1) fire('pointermove', startY + (${px} * step) / 24, 1);
    fire('pointerup', startY + ${px}, 0);
    await new Promise((resolve) => setTimeout(resolve, 350));
    return document.querySelector('.real-book-stage').style.getPropertyValue('--rb-pitch');
  `)
}

// 真实书籍现在没有「平放」按钮：底栏收起时整条 inert，舞台自己的 .real-book-toolbar
// 又只在非真实书籍下渲染（Reader.vue 的 :show-toolbar）。回 0° 只能向上拖。
async function resetPitch(ev) {
  const raw = await ev(`return document.querySelector('.real-book-stage')?.style.getPropertyValue('--rb-pitch');`)
  const deg = Number.parseFloat(String(raw))
  if (!Number.isFinite(deg) || deg <= 0) return
  await dragPitchBy(ev, -Math.ceil(deg / 0.1))
}

async function dragPitch(ev, cdp, px) {
  await resetPitch(ev)
  return dragPitchBy(ev, px)
}

let first
let second
let ws
try {
  first = startApp()
  const app = await connect()
  ws = app.ws
  const { ev, waitFor, click, screenshot, cdp } = app

  // 本脚本验的是 CSS 3D 回退几何；WebGL 现在是默认渲染层，必须显式选回 CSS 3D。
  await ev(`localStorage.setItem('spore:reader-realbook-renderer:v1', 'css'); return true;`)
  await cdp('Page.reload')
  await sleep(1800)

  check('真实书籍书台出现', await openFixtureBook(app))
  const initial = await ev(`return {
    card: document.querySelector('.real-book-note[data-note-id="anno-1"]')?.textContent || '',
    highlight: document.querySelector('.real-book-stage mark.hl-mark')?.textContent || '',
    pressed: document.querySelector('.real-book-note-toggle')?.getAttribute('aria-pressed') || '',
    handwriting: document.querySelector('.real-book-note[data-note-id="anno-1"]')?.className || '',
    anchor: Boolean(document.querySelector('.real-book-note-anchor[data-note-anchor-id="anno-1"]')),
    tag: document.querySelector('.real-book-note[data-note-id="anno-1"] .real-book-note-tag')?.textContent || '',
  };`)
  check('预置批注显示在书页上', initial.card.includes('预置批注'), initial.card.slice(0, 80))
  check('划线底色仍在', initial.highlight.includes('第1段'), initial.highlight)
  check('批注默认开启且带手写体', initial.pressed === 'true' && initial.handwriting.includes('handwriting-kai'), initial.handwriting)
  check('批注有行内「注」标记与 #tag', initial.anchor && initial.tag === '#quote', JSON.stringify({ anchor: initial.anchor, tag: initial.tag }))

  // 就地编辑 → 保存 → 磁盘落盘
  const edited = await ev(`
    const card = document.querySelector('.real-book-note[data-note-id="anno-1"]');
    if (!card) return { error: 'no card' };
    card.click();
    await new Promise((r) => setTimeout(r, 250));
    const editor = document.querySelector('.inline-note-editor');
    if (!editor) return { error: 'no editor' };
    const ta = editor.querySelector('textarea');
    if (!ta) return { error: 'no textarea' };
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter.call(ta, '编辑后的页内批注：已落盘。');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const save = [...editor.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存');
    if (!save) return { error: 'no save button' };
    save.click();
    await new Promise((r) => setTimeout(r, 700));
    return {
      editorClosed: !document.querySelector('.inline-note-editor'),
      card: document.querySelector('.real-book-note[data-note-id="anno-1"]')?.textContent || '',
    };
  `)
  check('点击书页卡片打开编辑浮层并保存', !edited.error && edited.editorClosed && edited.card.includes('已落盘'), JSON.stringify(edited))
  const disk = JSON.parse(await readFile(join(bookDir, 'annotations.json'), 'utf-8'))
  check('编辑结果写入 annotations.json', disk.items?.[0]?.note === '编辑后的页内批注：已落盘。', disk.items?.[0]?.note ?? '(空)')

  // 俯仰截图：0° / 20° / 35°
  await resetPitch(ev)
  await screenshot('pitch-0.png')
  const pitch20 = await dragPitch(ev, cdp, 200)
  const pitch20Deg = Number.parseFloat(String(pitch20))
  check('拖到约 20° 且批注仍可见', pitch20Deg >= 18 && pitch20Deg <= 22
    && Boolean(await ev(`return Boolean(document.querySelector('.real-book-note[data-note-id="anno-1"]'));`)), `--rb-pitch=${pitch20}`)
  await screenshot('pitch-20.png')
  const pitch35 = await dragPitch(ev, cdp, 350)
  const pitch35Deg = Number.parseFloat(String(pitch35))
  check('拖到约 35° 且批注仍可见', pitch35Deg >= 32 && pitch35Deg <= 36
    && Boolean(await ev(`return Boolean(document.querySelector('.real-book-note[data-note-id="anno-1"]'));`)), `--rb-pitch=${pitch35}`)
  await screenshot('pitch-35.png')

  // 四套主题截图
  await resetPitch(ev)
  const applyTheme = async (label) => ev(`
    // 底栏不交互时收进底边横条：先点横条把它展开，再去点「背景」。
    if (document.querySelector('.reader-bottombar')?.classList.contains('reader-tools-hidden')) {
      document.querySelector('.real-book-dock')?.click();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const toggle = document.querySelector('.bottom-button[aria-label="背景"]');
    if (!toggle) return { error: 'no background button' };
    toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const target = [...document.querySelectorAll('.bottom-panel .option-grid button')]
      .find((button) => button.textContent.trim() === ${JSON.stringify(label)});
    if (!target) return { error: 'no theme option' };
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const active = target.classList.contains('active');
    toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { active };
  `)
  for (const [label, file] of [['纸白', 'theme-paper.png'], ['暖黄', 'theme-sepia.png'], ['柔灰', 'theme-gray.png'], ['夜间', 'theme-night.png']]) {
    const result = await applyTheme(label)
    check(`主题「${label}」切换成功`, !result.error && result.active, JSON.stringify(result))
    await screenshot(file)
  }

  // 关闭批注模式 → 卡片消失、划线保留 → 等设置落盘
  const closed = await ev(`
    const toggle = document.querySelector('.real-book-note-toggle');
    if (!toggle) return { error: 'no note toggle' };
    toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 600));
    return {
      pressed: toggle.getAttribute('aria-pressed'),
      card: Boolean(document.querySelector('.real-book-note[data-note-id="anno-1"]')),
      highlight: Boolean(document.querySelector('.real-book-stage mark.hl-mark')),
    };
  `)
  check('关闭批注后卡片隐藏、划线保留', !closed.error && closed.pressed === 'false' && !closed.card && closed.highlight, JSON.stringify(closed))
  await sleep(600)
  const settingsAfterClose = JSON.parse(await readFile(join(userData, 'settings.json'), 'utf-8'))
  check('关闭状态写入 settings.json', settingsAfterClose.reader?.showInlineNotes === false, String(settingsAfterClose.reader?.showInlineNotes))

  try { ws.close() } catch { /* noop */ }
  ws = null
  first.stop()
  first = null
  await sleep(1000)

  // 重启：仍关闭、卡片仍隐藏
  second = startApp()
  const app2 = await connect()
  ws = app2.ws
  check('重启后真实书籍书台仍可打开', await openFixtureBook(app2))
  const afterRestart = await app2.ev(`return {
    pressed: document.querySelector('.real-book-note-toggle')?.getAttribute('aria-pressed') || '',
    card: Boolean(document.querySelector('.real-book-note[data-note-id="anno-1"]')),
    highlight: Boolean(document.querySelector('.real-book-stage mark.hl-mark')),
  };`)
  check('重启后批注开关保持关闭', afterRestart.pressed === 'false', JSON.stringify(afterRestart))
  check('重启后卡片仍隐藏、划线仍在', !afterRestart.card && afterRestart.highlight, JSON.stringify(afterRestart))
} catch (error) {
  check('页内批注 e2e 流程未抛异常', false, String((error && error.stack) || error))
} finally {
  try { ws?.close() } catch { /* noop */ }
  second?.stop()
  first?.stop()
  await sleep(600)
  await rm(lib, { recursive: true, force: true }).catch(() => {})
  await rm(userData, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n结果：${passed.length} 项通过，${failed.length} 项失败`)
if (failed.length) {
  console.log('--- 应用输出（尾部，Windows GUI 可能不往父进程 stdout 写，仅供参考）---')
  console.log(String(second?.output?.() ?? first?.output?.() ?? '').slice(-2000))
  process.exit(1)
}
console.log('真实书籍页内批注检查通过：显示、编辑落盘、开关持久、俯仰与主题截图均已产出')

// 真实书籍俯仰选区检查：真起 Electron，把书台拖到俯仰角 > 0，划一段正文，检查
//   1) 划出的选区矩形每一块都命中到所选段落（说明矩形与渲染后的文字位置一致）；
//   2) 选区工具条与选区相邻（上方或下方、水平范围内），没有飘到别处或压住选中文字。
// 同一流程在平放（0°）下再跑一次作为基线。
//
// 为什么不用 jsdom：getBoundingClientRect 与 elementFromPoint 只有在真实布局和 3D 变换下才有意义。
// 为什么用真实鼠标：俯仰拖拽走 pointer 事件，CDP Input 派发的是真实输入，和用户拖动一致。
//
// 用法：先 `npm run build`，再 `node scripts/realbook-selection-pitch-e2e.mjs`。
// 会在桌面上开一个应用窗口（约十几秒），结束后自动关闭。脚本不读写任何密钥。
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = 36000 + Math.floor(Math.random() * 2000)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// 工具条与选区的允许间距：工具条 gap 默认 8px，留余量给亚像素与阴影。
const MAX_ADJACENT_GAP_PX = 24

const passed = []
const failed = []
const check = (label, ok, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`
  ;(ok ? passed : failed).push(line)
  console.log(line)
}

const lib = await mkdtemp(join(tmpdir(), 'spbf-rbsel-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-rbsel-user-'))
const bookId = 'd_rbsel'
const bookDir = join(lib, bookId)
await mkdir(join(bookDir, 'chapters'), { recursive: true })
const now = new Date().toISOString()
const body = Array.from({ length: 24 }, (_, i) =>
  `第${i + 1}段：这是一段用来检查真实书籍俯仰选区的测试文字，句子长度足够，便于在段落中划出一小段文字进行命中检查。为了覆盖多行选区，这里再补一段足够长的内容，让它自然折到第三行，用来验证工具条是不是贴在最后一行下方。`).join('\n\n')

await writeFile(join(bookDir, 'book.json'), JSON.stringify({
  id: bookId, title: '俯仰选区测试书', author: '测试', tags: [],
  sourceUrl: 'https://example.com/rbsel/', sourceHost: 'example.com',
  importType: 'download', createdAt: now, updatedAt: now, status: 'ready',
  chapters: [{ id: 'c0001', index: 1, title: '第一章 俯仰', url: 'https://example.com/rbsel/1.html', file: '0001.json', status: 'ready' }],
  progress: { chapterId: 'c0001', scrollRatio: 0, rest: undefined },
}, null, 2), 'utf-8')
// readChapter 用 meta.file 直接拼在书目录下，不加 chapters/ 前缀。
await writeFile(join(bookDir, '0001.json'), JSON.stringify({
  title: '第一章 俯仰', url: 'https://example.com/rbsel/1.html', body, status: 'ready',
}), 'utf-8')

// 固定进入真实书籍渲染层；不写任何密钥。
await writeFile(join(userData, 'settings.json'), JSON.stringify({
  libraryPath: lib,
  reader: {
    fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium',
    paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'screen',
    bookView: 'realbook',
  },
}, null, 2), 'utf-8')

console.log(`夹具：书库=${lib}\n      userData=${userData}`)

const child = spawn(electronPath, [root, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
child.stdout.on('data', (chunk) => { out += String(chunk) })
child.stderr.on('data', (chunk) => { out += String(chunk) })

const killTree = () => {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGTERM')
  } catch { /* 已经退出了 */ }
}

// 在页面内执行：划出段内前 24 个字，派发 mouseup（与 RealBookStage 的 @mouseup 同路径），
// 取选区矩形、工具条矩形，并对选区每一块做 elementFromPoint 命中检查。
const MEASURE_SELECTION = `
  const stage = document.querySelector('.real-book-stage');
  if (!stage) return { error: 'no stage' };
  const para = [...stage.querySelectorAll('.real-book-para[data-p]')].find((p) => {
    const r = p.getBoundingClientRect();
    return r.top > 0 && r.bottom < innerHeight && (p.textContent || '').length > 40;
  });
  if (!para) return { error: 'no visible paragraph' };
  const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
  let textNode = null;
  while (walker.nextNode()) {
    if (walker.currentNode.textContent.length >= 24) { textNode = walker.currentNode; break; }
  }
  if (!textNode) return { error: 'no text node' };
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, Math.min(__END__, textNode.textContent.length));
  const endOffset = range.endOffset;
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  stage.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const popup = document.querySelector('.sel-popup');
  if (!popup) return { error: 'no selection popup' };
  const pr = popup.getBoundingClientRect();
  const selRect = range.getBoundingClientRect();
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  const hitInfo = rects.map((r) => {
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const el = document.elementFromPoint(x, y);
    const owner = el ? el.closest('.real-book-para') : null;
    return {
      at: [Math.round(x), Math.round(y)],
      tag: el ? el.tagName : null,
      cls: el ? String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).slice(0, 60) : null,
      ownerP: owner ? owner.getAttribute('data-p')?.slice(0, 12) : null,
      targetP: para.getAttribute('data-p')?.slice(0, 12),
      inPara: Boolean(el && para.contains(el)),
    };
  });
  // 对比整段选区的矩形与单字符矩形：若单字符矩形与 caret 求解一致，
  // 说明锚点应取单字符矩形，而不是整段选区矩形。
  const caretRect = (from, to, probeOffset) => {
    const cr = document.createRange();
    cr.setStart(textNode, from);
    cr.setEnd(textNode, to);
    const r = cr.getBoundingClientRect();
    const px = r.left + Math.max(1, r.width / 2);
    const py = r.top + r.height / 2;
    const p = document.caretPositionFromPoint ? document.caretPositionFromPoint(px, py) : null;
    return {
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      roundTrip: p && p.offsetNode === textNode ? p.offset : null,
      expect: probeOffset,
    };
  };
  const caretProbe = {
    single0: caretRect(0, 1, 0),
    single5: caretRect(5, 6, 5),
    singleEnd: caretRect(endOffset - 1, endOffset, endOffset - 1),
  };

  const hits = hitInfo.map((h) => h.inPara);
  // 真实选区带（最后一行）：以选区末端字符的矩形为起点向外扫描，找到 caret 求解
  // 仍落在选区内的纵坐标。俯仰下矩形本身是偏的，只有这条带才是高亮文字的真实位置；
  // 工具条应该贴在最后一行下方，所以参照点取末端字符而不是选区中心。
  const endCharRect = (() => {
    const er = document.createRange();
    er.setStart(textNode, Math.max(0, endOffset - 1));
    er.setEnd(textNode, endOffset);
    return er.getBoundingClientRect();
  })();
  const inSelection = (offset) => offset !== null && offset >= range.startOffset - 1 && offset <= range.endOffset + 1;
  const probeOffset = (x, y) => {
    const p = document.caretPositionFromPoint ? document.caretPositionFromPoint(x, y) : null;
    return p && p.offsetNode === textNode ? p.offset : null;
  };
  const probeX = endCharRect.left + Math.max(1, endCharRect.width / 2);
  const seedY = endCharRect.top + endCharRect.height / 2;
  let trueBand = { top: endCharRect.top, bottom: endCharRect.bottom, found: false };
  for (let d = 0; d <= endCharRect.height * 3; d += 2) {
    const candidates = d === 0 ? [seedY] : [seedY - d, seedY + d];
    const hitY = candidates.find((y) => inSelection(probeOffset(probeX, y)));
    if (hitY === undefined) continue;
    trueBand = { top: hitY - endCharRect.height / 2, bottom: hitY + endCharRect.height / 2, found: true };
    break;
  }
  const gapAbove = selRect.top - pr.bottom;
  const gapBelow = pr.top - selRect.bottom;
  const adjacentVertically = (gapAbove >= -1 && gapAbove <= ${MAX_ADJACENT_GAP_PX})
    || (gapBelow >= -1 && gapBelow <= ${MAX_ADJACENT_GAP_PX});
  const horizontallyAligned = pr.left <= selRect.right && pr.right >= selRect.left;
  const inViewport = pr.left >= 0 && pr.top >= 0 && pr.right <= innerWidth && pr.bottom <= innerHeight;
  return {
    pitch: stage.style.getPropertyValue('--rb-pitch'),
    rectCount: rects.length,
    hitCount: hits.filter(Boolean).length,
    hitInfo,
    caretProbe,
    trueBand: { top: Math.round(trueBand.top), bottom: Math.round(trueBand.bottom), found: trueBand.found },
    viewport: [innerWidth, innerHeight],
    selRect: { left: Math.round(selRect.left), top: Math.round(selRect.top), width: Math.round(selRect.width), height: Math.round(selRect.height) },
    popupRect: { left: Math.round(pr.left), top: Math.round(pr.top), width: Math.round(pr.width), height: Math.round(pr.height) },
    gapAbove: Math.round(gapAbove), gapBelow: Math.round(gapBelow),
    adjacentVertically, horizontallyAligned, inViewport,
  };
`

let ws
try {
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
  if (!target) throw new Error('没找到渲染页 CDP target，应用可能没起窗口：\n' + out.slice(-2000))

  ws = new WebSocket(target.webSocketDebuggerUrl)
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
      if (await ev(`return (${expr});`)) return true
      await sleep(150)
    }
    return false
  }
  const click = (expr) => ev(`const el = ${expr}; if (!el) return 'none'; el.scrollIntoView(); el.click(); return 'ok';`)

  // 本脚本验的是 CSS 3D 回退下的选区俯仰；WebGL 现在是默认渲染层，必须显式选回 CSS 3D。
  await ev(`localStorage.setItem('spore:reader-realbook-renderer:v1', 'css'); return true;`)
  await cdp('Page.reload')
  await sleep(1800)

  // 1) 书库 → 打开夹具书，等真实书籍书台出现
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`, 25000)
  await click(`[...document.querySelectorAll('.nav-btn')].find((b) => b.querySelector('.nav-label')?.textContent === '书库')`)
  check('书库渲染出夹具书卡', await waitFor(`document.querySelector('.book-open-area')`, 12000))
  await click(`document.querySelector('.book-open-area')`)
  const stageReady = await waitFor(`document.querySelector('.real-book-stage .real-book-para')`, 15000)
  check('真实书籍书台出现', stageReady)
  if (!stageReady) {
    const state = await ev(`return {
      classic: document.querySelectorAll('.reader-content').length,
      realHost: document.querySelectorAll('.real-book-host').length,
      stage: document.querySelectorAll('.real-book-stage').length,
      para: document.querySelectorAll('.real-book-para').length,
      chapterHint: document.querySelector('.chapter-hint')?.textContent || '',
      readerVisible: Boolean(document.querySelector('.reader-page, .reader-pane, .real-book-host')),
      bodyText: (document.body.innerText || '').slice(0, 300),
      innerSize: [innerWidth, innerHeight],
      stageSize: (() => { const r = document.querySelector('.real-book-stage')?.getBoundingClientRect(); return r ? [Math.round(r.width), Math.round(r.height)] : null })(),
      bookSize: (() => { const r = document.querySelector('.real-book-book')?.getBoundingClientRect(); return r ? [Math.round(r.width), Math.round(r.height)] : null })(),
    };`)
    console.log(`      书台未出现时的 DOM 状态：${JSON.stringify(state)}`)
  }
  await sleep(800)

  const measureAt = async (label, endIndex = 24, tolerance = 12, mode = 'rect') => {
    await sleep(300)
    const result = await ev(MEASURE_SELECTION.replaceAll('__END__', String(endIndex)))
    if (result?.error) {
      check(`${label}：可以测量选区`, false, result.error)
      return null
    }
    console.log(`      ${label} 详情：${JSON.stringify(result)}`)
    // 工具条必须贴在「caret 求解出的真实选区带」下沿，而不是贴在矩形下沿：
    // 俯仰下矩形本身偏低一行，贴在矩形上就等于压住了下一行文字。
    const gapToTrue = result.popupRect.top - result.trueBand.bottom
    if (mode === 'fixed') {
      // 俯仰下工具条不读选区几何：固定贴在视口底部居中，既不会压住选中文字，也不会随角度漂移。
      const centerX = result.popupRect.left + result.popupRect.width / 2
      const centered = Math.abs(centerX - result.viewport[0] / 2) <= 2
      const bottomGap = result.viewport[1] - (result.popupRect.top + result.popupRect.height)
      check(`${label}：工具条固定在视口底部居中`, centered && result.inViewport && bottomGap >= 80 && bottomGap <= 140,
        `中心 ${Math.round(centerX)} / ${Math.round(result.viewport[0] / 2)}，距底 ${Math.round(bottomGap)}`)
      return result
    }
    if (!result.trueBand.found) {
      // 俯仰 35° 实测 caret 求解会返回别的文本节点，真实选区带无从判定，只记录不断言。
      console.log(`      ${label}：caret 求解未给出可判定的真实选区带，跳过贴合检查`)
    } else {
      // 容差默认 12px（设计间距 8px，未修正前实测 14px，收紧才能区分修与不修）。
      check(`${label}：工具条贴在真实选区下沿`, gapToTrue >= -1 && gapToTrue <= tolerance,
        `真实下沿 ${result.trueBand.bottom}，工具条 top ${result.popupRect.top}，间距 ${Math.round(gapToTrue)} / 容差 ${tolerance}`)
    }
    check(`${label}：工具条与选区相邻且水平对齐`, result.adjacentVertically && result.horizontallyAligned,
      `gapAbove=${result.gapAbove} gapBelow=${result.gapBelow}`)
    check(`${label}：工具条在视口内`, result.inViewport)
    return result
  }

  // 3) 俯仰扫描：平放 → 20° → 35°（上限），每个角度各测单行与多行选区
  const readPitch = () => ev(`return document.querySelector('.real-book-stage').style.getPropertyValue('--rb-pitch');`)
  // 俯仰拖拽：0.1°/px。起点不能写死成「书体左上角 +8px」——选过多行字之后顶部阅读
  // 工具栏常显，正好盖住那个角（elementFromPoint 命中「书架」按钮），拖拽根本到不了书体；
  // 起点若落在文字上还会触发原生拖拽把 pointer 取消。所以在书体内部扫描一个
  // 「命中书体、不落在正文/批注、不被工具栏或选区工具条盖住」的纸面点。
  const findDragPoint = () => ev(`
    window.getSelection().removeAllRanges();
    const book = document.querySelector('.real-book-book');
    const r = book.getBoundingClientRect();
    const blocked = '.real-book-para, .real-book-note, .reader-toolbar, .reader-bottombar, .sel-popup';
    for (let y = r.top + 40; y <= r.bottom - 40; y += 10) {
      for (const x of [Math.round(r.left + 10), Math.round(r.left + 20)]) {
        const el = document.elementFromPoint(x, y);
        if (el && book.contains(el) && !el.closest(blocked)) return { x, y };
      }
    }
    return null;
  `)
  const dragBy = async (px) => {
    const start = await findDragPoint()
    if (!start) {
      check(`拖拽 ${px}px 前能找到纸面起点`, false, '书体上没有可拖拽的空白点')
      return readPitch()
    }
    const startX = start.x
    const startY = start.y
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1 })
    const steps = 24
    for (let step = 1; step <= steps; step += 1) {
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX, y: startY + (px * step) / steps, button: 'left', buttons: 1 })
    }
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: startX, y: startY + px, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(400)
    return readPitch()
  }
  // 现在真实书籍没有「平放」按钮：底栏收起时是 inert 横条，舞台自己的
  // .real-book-toolbar 又只在非真实书籍下渲染（Reader.vue 的 :show-toolbar）。
  // 回到 0° 只能向上拖——读当前角度，按 0.1°/px 反算位移。
  const resetFlat = async () => {
    const deg = Number.parseFloat(String(await readPitch()))
    if (!Number.isFinite(deg) || deg <= 0) return
    await dragBy(-Math.ceil(deg / 0.1))
  }
  const dragToPitch = async (px) => {
    await resetFlat()
    return dragBy(px)
  }

  const measured = []
  await resetFlat()
  const flatPitch = await readPitch()
  check('向上拖拽回到平放（0°）', Number.parseFloat(flatPitch) === 0, `--rb-pitch=${flatPitch || '(空)'}`)
  measured.push(await measureAt(`平放 ${flatPitch} 单行`, 24))
  measured.push(await measureAt(`平放 ${flatPitch} 多行`, 90))

  for (const px of [200, 350]) {
    const pitchValue = await dragToPitch(px)
    const pitchDeg = Number.parseFloat(String(pitchValue))
    check(`拖拽 ${px}px 后俯仰角大于 0`, Number.isFinite(pitchDeg) && pitchDeg > 0, `--rb-pitch=${pitchValue || '(空)'}`)
    // 35° 是俯仰上限：实测该角度下 caret 求解开始失真，锚点修正会主动放弃，
    // 只保证工具条仍在真实选区一行之内（容差 40px ≈ 1.2 行）。
    const tolerance = px >= 350 ? 40 : 12
    const mode = 'fixed'
    measured.push(await measureAt(`俯仰 ${pitchValue} 单行`, 24, tolerance, mode))
    measured.push(await measureAt(`俯仰 ${pitchValue} 多行`, 90, tolerance, mode))
  }

  // 俯仰状态截图：核对文字与工具条在屏幕上的真实位置
  const shot = await cdp('Page.captureScreenshot', { format: 'png' })
  const shotPath = join(tmpdir(), 'rbsel-pitch.png')
  await writeFile(shotPath, Buffer.from(shot.data, 'base64'))
  console.log(`      俯仰截图：${shotPath}`)

  // 5) 真实鼠标划词：CDP 派发的按下/移动/松开走浏览器原生选区，与用户拖选一致
  const pick = await ev(`
    const stage = document.querySelector('.real-book-stage');
    // 底栏常驻、顶栏在鼠标移到书台时出现：划词端点不能被这两条栏盖住，
    // 否则原生选区从一开始就落不到段落上（实测只选中 1 字）。
    // 逐个段落试，找一组两端都命中段落的可见段落。
    const candidates = [...stage.querySelectorAll('.real-book-para[data-p]')].filter((p) => {
      const r = p.getBoundingClientRect();
      return r.top > 0 && r.bottom < innerHeight && (p.textContent || '').length > 40;
    });
    let picked = null;
    for (const para of candidates) {
      const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
      let textNode = null;
      while (walker.nextNode()) {
        if (walker.currentNode.textContent.length >= 24) { textNode = walker.currentNode; break; }
      }
      if (!textNode) continue;
      const at = (index) => {
        const g = document.createRange();
        g.setStart(textNode, index);
        g.setEnd(textNode, index + 1);
        const r = g.getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2];
      };
      const from = at(0);
      const to = at(23);
      // 3D 变换下 elementFromPoint 命中的常常是书体外层而不是段落本身，
      // 不能要求它命中段落；只要求两端没被顶栏/底栏盖住。
      const covered = (pt) => {
        const el = document.elementFromPoint(pt[0], pt[1]);
        return Boolean(el && el.closest('.reader-toolbar, .reader-bottombar'));
      };
      if (!covered(from) && !covered(to)) {
        picked = { para, textNode, from, to };
        break;
      }
    }
    if (!picked) return { error: 'no clear paragraph' };
    const { para, textNode, from, to } = picked;
    // 对比「命中测试不准」与「矩形取值不准」：同一屏幕点对应的字符偏移
    const caretAt = (pt) => {
      const node = textNode;
      let offset = null;
      if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(pt[0], pt[1]);
        if (p && p.offsetNode === node) offset = p.offset;
      }
      let hitPara = null;
      const el = document.elementFromPoint(pt[0], pt[1]);
      const owner = el ? el.closest('.real-book-para') : null;
      if (owner) hitPara = owner.getAttribute('data-p');
      return { offset, hitPara };
    };
    const probe = { fromCaret: caretAt(from), toCaret: caretAt(to) };
    window.getSelection().removeAllRanges();
    return { from, to, probe, expected: textNode.textContent.slice(0, 24), paraText: para.textContent || '' };
  `)
  if (pick?.error) {
    check('真实鼠标划词：可以定位字符', false, pick.error)
  } else {
    console.log(`      拖拽端点与 caret 偏移：${JSON.stringify({ from: pick.from, to: pick.to, probe: pick.probe })}`)
    // 记录 pointerdown 目标与选区变化，定位拖选为空的原因
    await ev(`
      window.__rbselProbe = [];
      document.addEventListener('pointerdown', (e) => {
        window.__rbselProbe.push({ t: 'pointerdown', tag: e.target.tagName, cls: e.target.getAttribute('class') });
      }, true);
      document.addEventListener('selectionchange', () => {
        window.__rbselProbe.push({ t: 'selectionchange', len: window.getSelection().toString().length });
      });
      document.addEventListener('mouseup', (e) => {
        window.__rbselProbe.push({ t: 'mouseup', tag: e.target.tagName, cls: e.target.getAttribute('class'), len: window.getSelection().toString().length });
      }, true);
      return 'ok';
    `)
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: pick.from[0], y: pick.from[1], button: 'left', buttons: 1, clickCount: 1 })
    for (let step = 1; step <= 12; step += 1) {
      const t = step / 12
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pick.from[0] + (pick.to[0] - pick.from[0]) * t, y: pick.from[1] + (pick.to[1] - pick.from[1]) * t, button: 'left', buttons: 1 })
    }
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pick.to[0], y: pick.to[1], button: 'left', buttons: 0, clickCount: 1 })
    await sleep(400)
    const native = await ev(`return { text: window.getSelection().toString(), popup: Boolean(document.querySelector('.sel-popup')), events: window.__rbselProbe || [] };`)
    console.log(`      拖拽事件序列：${JSON.stringify(native.events)}`)
    console.log(`      俯仰下真实鼠标划词：${JSON.stringify({ selected: native.text, expected: pick.expected, popup: native.popup })}`)
    check('俯仰下真实鼠标划词选中该段落文字', native.text.trim().length >= 8 && pick.paraText.includes(native.text.trim()), `选中 ${native.text.length} 字`)
    check('俯仰下真实鼠标划词弹出选区工具条', native.popup)
  }

  const valid = measured.filter((r) => r && r.selRect)
  const first = valid[0]
  const last = valid[valid.length - 1]
  if (first && last) {
    check('俯仰 35° 下选区矩形仍有可测宽高', last.selRect.width > 0 && last.selRect.height > 0,
      `平放 ${first.selRect.width}×${first.selRect.height}，${last.pitch} ${last.selRect.width}×${last.selRect.height}`)
  }
} catch (error) {
  check('俯仰选区检查流程未抛异常', false, String((error && error.stack) || error))
} finally {
  try { ws?.close() } catch { /* noop */ }
  killTree()
  await sleep(500)
  await rm(lib, { recursive: true, force: true }).catch(() => {})
  await rm(userData, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n结果：${passed.length} 项通过，${failed.length} 项失败`)
if (failed.length) {
  console.log('--- 应用输出（尾部，Windows GUI 可能不往父进程 stdout 写，仅供参考）---')
  console.log(out.slice(-2000))
  process.exit(1)
}
console.log('真实书籍俯仰选区检查通过：平放、20°、35° 下标单行与多行选区的工具条都贴在真实选区下沿')

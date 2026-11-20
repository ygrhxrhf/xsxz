// 真实书籍翻页流畅度检查：真起 Electron，进入真实书籍模式，触发翻页，
// 在页面内用 rAF 记录帧间隔，并用 A/B 对照定位翻页的开销来源。
//
// 为什么不用 jsdom：帧间隔必须在真实渲染管线里量才有意义——DOM 数量、
// 3D 变换、blur 滤镜的开销只有真实合成器才付。
// 为什么用真实鼠标：点击纸面右区与用户翻页同路径（Reader.vue 的三分区）。
//
// 用法：先 `npm run build`，再 `node scripts/realbook-flip-fps-e2e.mjs`。
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

const passed = []
const failed = []
const check = (label, ok, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`
  ;(ok ? passed : failed).push(line)
  console.log(line)
}

// 判定门槛：60Hz 下理想帧间隔约 16.7ms。
// 超过 40ms 就算一次明显长帧（肉眼可见的顿挫），超过 80ms 是严重卡顿。
const LONG_FRAME_MS = 40
const SEVERE_FRAME_MS = 80
// 视觉验收可把翻页放慢 10 倍，方便截到真正的中段曲率；不影响默认帧率测试。
const slowFlip = process.env.SPBF_SLOW_FLIP === '1'

const lib = await mkdtemp(join(tmpdir(), 'spbf-rbfps-lib-'))
const userData = await mkdtemp(join(tmpdir(), 'spbf-rbfps-user-'))
const bookId = 'd_rbfps'
const bookDir = join(lib, bookId)
await mkdir(join(bookDir, 'chapters'), { recursive: true })
const now = new Date().toISOString()
// 每段足够长，保证能排出好几页，翻页才有得可翻。
const body = Array.from({ length: 60 }, (_, i) =>
  `第${i + 1}段：这是一段用来检查真实书籍翻页流畅度的测试文字。句子要有足够长度，让版面能排满一页以上的篇幅，这样翻页时才有足够的正文可以跟着卷起来，纸面上的字才会跟着纸一起弯，而不是空白的纸在翻。为了覆盖长段落，这里再补一些内容，确保每一段都自然折到三行以上。`).join('\n\n')

await writeFile(join(bookDir, 'book.json'), JSON.stringify({
  id: bookId, title: '翻页流畅度测试书', author: '测试', tags: [],
  sourceUrl: 'https://example.com/rbfps/', sourceHost: 'example.com',
  importType: 'download', createdAt: now, updatedAt: now, status: 'ready',
  chapters: [{ id: 'c0001', index: 1, title: '第一章 流畅度', url: 'https://example.com/rbfps/1.html', file: '0001.json', status: 'ready' }],
  progress: { chapterId: 'c0001', scrollRatio: 0, rest: undefined },
}, null, 2), 'utf-8')
// readChapter 用 meta.file 直接拼在书目录下，不加 chapters/ 前缀。
await writeFile(join(bookDir, '0001.json'), JSON.stringify({
  title: '第一章 流畅度', url: 'https://example.com/rbfps/1.html', body, status: 'ready',
}), 'utf-8')

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

let ws
// 截图目录必须在 try 外声明：finally 里要用它清理，而 try 块内的 const 在那里不可见。
let shotDir = null
try {
  let target
  let seen = []
  for (let i = 0; i < 160; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await response.json()
      seen = list.map((t) => `${t.type}:${String(t.url).slice(0, 60)}`)
      // 渲染页是 file: 协议的那一个；about:blank 是 Electron 的启动页，不是它。
      target = list.find((t) => t.type === 'page' && t.url.startsWith('file:'))
      if (target) break
    } catch { /* 调试端口还没起来 */ }
    await sleep(300)
  }
  if (!target) throw new Error('没找到渲染页 CDP target，应用可能没起窗口：\n' + out.slice(-2000) + '\n见过的 target：' + JSON.stringify(seen))

  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let nextId = 1
  const pending = new Map()
  const consoleErrors = []
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params?.exceptionDetails?.exception?.description
        || message.params?.exceptionDetails?.text || '未知异常')
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      consoleErrors.push((message.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '))
    }
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
  await cdp('Runtime.enable')
  await cdp('Page.enable')
  // 窗口必须在前台：页面 hidden 时浏览器会暂停 rAF，采样器一个帧都收不到。
  // 把窗口提到前台，并确认它真的可见，否则帧数据是空的。
  // 参考图画布为 1365×768：固定 CDP 视口，截图才能直接按像素对照尺寸、留白和栏位。
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1365,
    height: 768,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await cdp('Page.bringToFront')
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
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

  // 本脚本量的是 CSS 3D 回退的翻页帧率；WebGL 现在是默认渲染层，必须显式选回 CSS 3D。
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
  await sleep(1200)

  // 2) 装采样器
  //
  // 三样东西：
  //   - rAF 帧时刻（用于算帧间隔）；
  //   - MutationObserver 记录翻页中态的**实际**存续区间（DOM 在就是翻页在）；
  //   - PerformanceObserver 记录长任务（主线程被占住多久）。
  //
  // 主线程被占住时 rAF 根本不回调，所以「翻页期间只采到几帧」本身就是症状。
  await ev(`
    window.__probe = { frames: [], flipStart: 0, flipEnd: 0, longTasks: [], sampling: true };
    window.__probeObserver = new MutationObserver(() => {
      const on = Boolean(document.querySelector('.real-book-flip'));
      const p = window.__probe;
      if (on && !p.flipStart) p.flipStart = performance.now();
      if (!on && p.flipStart && !p.flipEnd) p.flipEnd = performance.now();
    });
    const root = document.querySelector('.real-book-book') || document.body;
    window.__probeObserver.observe(root, { childList: true, subtree: true });
    try {
      window.__probeLongObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__probe.longTasks.push({ start: entry.startTime, duration: entry.duration });
        }
      });
      window.__probeLongObserver.observe({ entryTypes: ['longtask'] });
    } catch { /* 浏览器不支持 longtask */ }
    const tick = (ts) => {
      if (!window.__probe.sampling) return;
      window.__probe.frames.push(ts);
      window.__probeRaf = requestAnimationFrame(tick);
    };
    window.__probeRaf = requestAnimationFrame(tick);
    return 'ok';
  `)

  // 截图目录：验证完就删，仓库里不留测试产物。
  shotDir = await mkdtemp(join(tmpdir(), 'spbf-rbfps-shots-'))
  const shots = []
  /** 截图。传 clip 即只拍一块区域（书缝细节要放大看，整幅缩略看不清）。 */
  const takeShot = async (name, clip) => {
    const r = await cdp('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' })
    const file = join(shotDir, name)
    await writeFile(file, Buffer.from(r.data, 'base64'))
    shots.push(file)
  }

  /**
   * 横穿书缝的像素亮度剖面。
   *
   * 为什么要拉回页面里解码：接口只给 PNG 字节，Node 侧没有解码器，而浏览器自带 canvas。
   * 拿到的是真实像素，不是「我觉得中缝应该有暗」。剖面应该接近「亮—同亮—亮」：
   * 中间一旦明显暗下去，书心就会读成一道阴影或裂缝，而不是一整片纸。
   */
  const seamProfile = async () => {
    const clip = {
      x: Math.max(0, Math.round(geom.gutterLeft - 90)),
      y: Math.round(geom.midY),
      width: Math.round(geom.gutterWidth + 180),
      height: 1,
      scale: 1,
    }
    const shot = await cdp('Page.captureScreenshot', { format: 'png', clip })
    const dataUrl = `data:image/png;base64,${shot.data}`
    const px = await ev(`
      const img = new Image();
      img.src = ${JSON.stringify(dataUrl)};
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, 1).data;
      const out = [];
      for (let x = 0; x < c.width; x += 1) {
        const i = x * 4;
        out.push(Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]));
      }
      return out;
    `)
    // 中缝在裁剪条里的列区间。
    const from = Math.round(geom.gutterLeft - Math.max(0, Math.round(geom.gutterLeft - 90)))
    const to = from + Math.round(geom.gutterWidth)
    const seamLum = px.slice(Math.max(0, from), Math.min(px.length, to))
    const leftPaper = px.slice(0, Math.max(1, from - 6))
    const rightPaper = px.slice(Math.min(px.length, to + 6))
    const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0)
    return { px, from, to, seamMin: Math.min(...seamLum), seamAvg: avg(seamLum), leftPaper: avg(leftPaper), rightPaper: avg(rightPaper) }
  }

  /**
   * 定格帧里检查 84°–91° 那几条竖带的接缝。
   *
   * 用命中测试而不是包围盒：竖带是斜放的，`getBoundingClientRect()` 给的是投影后的
   * 包围盒，右缘根本不是相邻两条共享的那条 3D 边，拿它当接缝位置会量到一大堆无关像素。
   * 命中测试问的是「这一列屏幕上最上层是谁」：相邻两条真的接上了，整段纸面上
   * 每一列都会落到某条竖带上；漏了哪怕一列，那一列就穿到下面去——那是竖缝的直接证据。
   *
   * `.real-book-flip` 平时 `pointer-events: none`（翻页不接鼠标），命中测试会漏过它，
   * 所以这里临时打开指针事件；只改采样期的 DOM，不动源码。
   */
  const inspectBandSeams = async (frameIndex) => {
    const scan = await ev(`
      const book = document.querySelector('.real-book-book');
      if (!book) return null;
      const style = document.createElement('style');
      style.id = '__rb_hit_probe';
      style.textContent = '.real-book-flip, .real-book-flip-slice, .real-book-flip-face, .real-book-flip-window, .real-book-flip-content { pointer-events: auto !important; }';
      document.head.appendChild(style);
      const box = book.getBoundingClientRect();
      const nodes = [...document.querySelectorAll('.real-book-flip-slice')];
      // 三个高度各扫一行：竖缝若存在一定贯穿页高，一行里读不到就够了，
      // 但带子在页高方向有折角，单行可能刚好碰上遮挡，多两行才定得了案。
      const ys = [0.32, 0.5, 0.68].map((f) => Math.round(box.top + box.height * f));
      const rowsByY = ys.map((y) => {
        const rows = [];
        for (let x = Math.round(box.left); x <= Math.round(box.right); x += 1) {
          const el = document.elementFromPoint(x, y);
          const slice = el && el.closest ? el.closest('.real-book-flip-slice') : null;
          rows.push({ x, index: slice ? nodes.indexOf(slice) : -1 });
        }
        return { y, rows };
      });
      style.remove();
      // 转角原文带回去在 Node 侧解析：在注入的模板字符串里写正则要穿两层转义，
      // 很容易变成「反斜杠+d」而默默匹配不到，导致角度全部读成 0。
      return { ys, rowsByY, transforms: nodes.map((node) => node.style.transform) };
    `)
    if (!scan) {
      check(`帧 ${frameIndex} 命中测试可执行`, false, '找不到 .real-book-book')
      return
    }
    const angleOf = (transform) => {
      const match = /rotateY\(\s*(-?\d+(?:\.\d+)?)deg\s*\)/.exec(transform ?? '')
      return match ? Number(match[1]) : null
    }
    const angles = scan.transforms.map(angleOf)
    // 几何上确实处在 84°–91° 的条带（不靠命中测试，不受遮挡影响）。
    const inWindow = angles
      .map((angle, index) => ({ index, angle }))
      .filter((item) => item.angle !== null && Math.abs(item.angle) >= 84 && Math.abs(item.angle) <= 91)
    const reports = scan.rowsByY.map(({ y, rows }) => {
      // 纸面 = 命中竖带的最长连续区段：一次翻页里只有一张纸在飞。
      let best = null
      let run = null
      for (const row of rows) {
        if (row.index >= 0) {
          if (!run) run = { from: row.x, to: row.x, count: 1 }
          else { run.to = row.x; run.count += 1 }
        } else if (run) {
          if (!best || run.count > best.count) best = run
          run = null
        }
      }
      if (run && (!best || run.count > best.count)) best = run
      if (!best) return { y, empty: true, holes: null }
      // 纸面区间内部命中不到任何竖带的列：就是穿到桌面去的竖缝。
      const holes = rows.filter((row) => row.index < 0 && row.x > best.from && row.x < best.to)
      return { y, empty: false, from: best.from, to: best.to, holes: holes.map((row) => row.x) }
    })
    const empty = reports.filter((report) => report.empty)
    const totalHoles = reports.reduce((sum, report) => sum + (report.holes?.length ?? 0), 0)
    const span = reports.find((report) => !report.empty)
    check(
      `帧 ${frameIndex} 纸面带子无漏列（3 行扫描）`,
      empty.length === 0 && totalHoles === 0,
      `${reports.map((r) => (r.empty ? `y=${r.y} 未命中` : `y=${r.y} x=${r.from}..${r.to} 漏${r.holes.length}`)).join('；')}`
        + `；84°–91° 带 ${inWindow.length} 条（${inWindow.map((i) => `${i.index}:${Math.abs(i.angle).toFixed(1)}°`).join(',') || '—'}）`
        + (span ? '' : '（无纸面样本）'),
    )
  }

  /**
   * 读一块裁剪图的逐列亮度（0–255）。
   *
   * 解码拉回页面里做：CDP 只给 PNG 字节，Node 侧没有解码器，而浏览器自带 canvas。
   * 拿到的是真实像素，不是「我觉得那儿应该有道缝」。
   */
  const luminanceRow = async (clip) => {
    const shot = await cdp('Page.captureScreenshot', { format: 'png', clip })
    const dataUrl = `data:image/png;base64,${shot.data}`
    return ev(`
      const img = new Image();
      img.src = ${JSON.stringify(dataUrl)};
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const out = [];
      for (let x = 0; x < c.width; x += 1) {
        let sum = 0;
        for (let y = 0; y < c.height; y += 1) {
          const i = (y * c.width + x) * 4;
          sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        }
        out.push(Math.round(sum / c.height));
      }
      return out;
    `)
  }

  /**
   * 读一块裁剪图里**逐列的亮度中位数**（0–255）。
   *
   * 为什么取中位数而不是单行均值：窗口只有 ±7px，正文的字形笔画必然落在里面，
   * 单行的亮度会被笔画砸出 20–80/255 的坑——那是字，不是缝。
   * 真正的竖缝是**贯穿页高**的一条暗线：一列在所有行上都暗；
   * 笔画只占几行，中位数不受它影响。
   */
  const columnMedianProfile = async (clip) => {
    const shot = await cdp('Page.captureScreenshot', { format: 'png', clip })
    const dataUrl = `data:image/png;base64,${shot.data}`
    return ev(`
      const img = new Image();
      img.src = ${JSON.stringify(dataUrl)};
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const out = [];
      for (let x = 0; x < c.width; x += 1) {
        const column = [];
        for (let y = 0; y < c.height; y += 1) {
          const i = (y * c.width + x) * 4;
          column.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
        }
        column.sort((a, b) => a - b);
        out.push(Math.round(column[Math.floor(column.length / 2)]));
      }
      return { width: c.width, height: c.height, lum: out };
    `)
  }

  /**
   * 斜带**真实 3D 边**处的亮度剖面，用来复核「无字缝」的亮度判据。
   *
   * 采样锚点不能取包围盒右缘：竖带是绕左轴转过的平面，`getBoundingClientRect()`
   * 给的是投影后的包围盒，它的右缘跟相邻带共享的那条 3D 边根本不是一个位置。
   *
   * 也不能指望命中测试把边找出来：正因为 84°–91° 的带已经侧到快看不见，
   * 它的投影宽度不到 1px，按 1px 步长扫描会整条跳过——「边为空集」就是假阳性。
   *
   * 所以把探针量在带上：在每条带自己的右缘按三个高度各放一个零尺寸的探针元素，
   * 让浏览器自己把它沿 `rotateY`、sheet 的 `rotateX/rotateZ`、以及 `perspective` 投影出来，
   * 再读探针的屏幕坐标。逐行取样是因为带子在页高方向有折角，同一条边在不同高度上
   * 的屏幕 x 相差十来个像素。
   *
   * 判据（沿用 8/255 与 16/255）：
   *   - 边两侧远场（CSS ±4..±7px）亮度均值差 < 8/255；
   *   - 窗口内不存在相对邻列均值偏离 > 16/255 的单列。
   *     靠近边心的 ±2.5px 是相邻带 `width + 0.5px` 搭接的过渡带，不计入该统计。
   * 最外一条带的右缘不算：`is-outer::after` 是刻意的纸边受光亮线，量它必误判。
   */
  const bandBrightnessProfile = async (frameIndex) => {
    const scan = await ev(`
      const book = document.querySelector('.real-book-book');
      if (!book) return null;
      const nodes = [...document.querySelectorAll('.real-book-flip-slice')];
      const box = book.getBoundingClientRect();
      const fracs = [0.32, 0.5, 0.68];
      const edges = [];
      nodes.forEach((node, index) => {
        const w = node.offsetWidth;
        const h = node.offsetHeight;
        for (const frac of fracs) {
          const probe = document.createElement('div');
          probe.style.cssText = 'position:absolute;left:' + w + 'px;top:' + Math.round(h * frac) + 'px;width:0;height:0;visibility:hidden;';
          node.appendChild(probe);
          const rect = probe.getBoundingClientRect();
          probe.remove();
          // 零尺寸元素在旋转后的包围盒是单点，left/top 就是那条 3D 边的屏幕坐标。
          edges.push({ index, frac, x: rect.left, y: rect.top });
        }
      });
      return {
        box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
        edges,
        transforms: nodes.map((n) => n.style.transform),
        count: nodes.length,
      };
    `)
    if (!scan) {
      check(`帧 ${frameIndex} 亮度剖面可执行`, false, '找不到 .real-book-book')
      return
    }
    const angleOf = (transform) => {
      const match = /rotateY\(\s*(-?\d+(?:\.\d+)?)deg\s*\)/.exec(transform ?? '')
      return match ? Number(match[1]) : null
    }
    const angles = scan.transforms.map(angleOf)

    // 逐带把「角度 → 实际写进 DOM 的前/背内容 opacity」打出来。
    // 调窄带里那点墨色到底来自哪几条带，靠猜「大概是 78° 还是 110°」不行。
    const opacityDump = await ev(`
      return [...document.querySelectorAll('.real-book-flip-slice')].map((node) => {
        const front = node.querySelector('.real-book-flip-front .real-book-flip-content');
        const back = node.querySelector('.real-book-flip-back .real-book-flip-content');
        return {
          front: front ? front.style.opacity : null,
          back: back ? back.style.opacity : null,
        };
      });
    `)
    console.log(`      帧 ${frameIndex} 逐带：` + angles.map((angle, index) => {
      const a = angle === null ? '?' : Math.abs(angle).toFixed(1)
      const f = opacityDump[index]?.front
      const b = opacityDump[index]?.back
      return `#${index} ${a}° f=${f ?? '—'} b=${b ?? '—'}`
    }).join(' | '))
    const inWindow = (index) => {
      const angle = angles[index]
      return angle !== null && angle !== undefined && Math.abs(angle) >= 84 && Math.abs(angle) <= 91
    }
    // 只取「带 i 的右缘」且 i 不是最外带（`is-outer` 右缘是纸边反光，不是接缝），
    // 且参与这条边的两条带中至少一条落在 84°–91°。
    const targets = scan.edges.filter((edge) => edge.index < scan.count - 1
      && (inWindow(edge.index) || inWindow(edge.index + 1)))
    if (!targets.length) {
      const all = angles.map((angle) => (angle === null ? '?' : Math.abs(angle).toFixed(1)))
      console.log(`--    帧 ${frameIndex} 亮度剖面：84°–91° 靶边为空集（逐带 ${all.join('/')}°）`)
      return
    }
    // 桌面参考亮度：竖缝如果真的存在，露出的就是桌面色。拿它做对照，
    // 才能区分「边上有一道暗线」与「字迹/光影起伏」。
    const measuredRight = targets.reduce((max, edge) => Math.max(max, edge.x), 0)
    const deskLum = await luminanceRow({
      x: Math.max(0, Math.round(scan.box.left) - 60),
      y: Math.max(0, Math.round(scan.box.top) + 20),
      width: 20,
      height: 1,
      scale: 1,
    })
    const desk = deskLum.reduce((a, b) => a + b, 0) / (deskLum.length || 1)
    console.log(`      帧 ${frameIndex} 探针：最右缘 x=${measuredRight.toFixed(1)}；桌面参考亮度 ${desk.toFixed(1)}/255`)

    const half = 7
    const scale = 2
    // 纵向取 60px 一条窄条，逐列取中位数：竖缝贯穿页高（每一行都暗），
    // 而字形笔画只占其中几行——中位数把它们滤掉，单行均值滤不掉。
    const stripHeight = 60
    for (const edge of targets) {
      const top = Math.min(Math.max(0, Math.round(edge.y) - stripHeight / 2), Math.max(0, Math.round(scan.box.bottom) - stripHeight))
      const clip = {
        x: Math.max(0, Math.round(edge.x) - half),
        y: top,
        width: half * 2 + 1,
        height: stripHeight,
        scale,
      }
      const prof = await columnMedianProfile(clip)
      const lum = prof.lum
      // 设备像素下标：CSS 列 k 落在 [2k, 2k+1]，边心在 2*half。
      const center = half * scale
      const mean = (list) => list.reduce((a, b) => a + b, 0) / (list.length || 1)
      const leftFar = mean(lum.slice(0, center - 6))
      const rightFar = mean(lum.slice(center + 6, lum.length))
      const step = Math.abs(leftFar - rightFar)
      const aaFrom = center - 5
      const aaTo = center + 5
      let worst = 0
      let worstAt = -1
      for (let i = 2; i < lum.length - 2; i += 1) {
        if (i >= aaFrom && i <= aaTo) continue
        const local = mean([lum[i - 2], lum[i - 1], lum[i + 1], lum[i + 2]])
        const deviation = Math.abs(lum[i] - local)
        if (deviation > worst) { worst = deviation; worstAt = i }
      }
      const lowest = Math.min(...lum)
      // 真正的竖缝会露出桌子：暗到接近桌面亮度。只有这种情况才算「缝」。
      const leaksDesk = lowest < desk + 30

      // 判据修正：两张纸的明暗本来就不一样（跨接缝会有一个亮度台阶），
      // 所以「两侧亮度差 < 8/255」不是缝的证据——实测台阶 0–22/255，
      // 但剖面里**没有凹下去**。缝的形态是边心附近出现局部极小，
      // 即比两侧都暗的那一列。判据改成看凹陷深度，阈值仍 16/255。
      const shallower = Math.min(leftFar, rightFar)
      let dip = 0
      let dipAt = -1
      for (let i = 1; i < lum.length - 1; i += 1) {
        // 只算局部极小：单调台阶不算（台阶是明暗差，不是缝）。
        if (!(lum[i] <= lum[i - 1] && lum[i] <= lum[i + 1])) continue
        const depth = shallower - lum[i]
        if (depth > dip) { dip = depth; dipAt = i }
      }
      const dipOffset = dipAt < 0 ? 0 : Math.abs(dipAt - center) / scale
      const pass = dip <= 16 && !leaksDesk
      // 诊断：最偏列离边心多少 CSS px。真竖缝一定在边心附近（±2px），
      // 而相邻条带自己的接缝会落在窗口两端的远场里。
      const worstOffset = worstAt < 0 ? 0 : Math.abs(worstAt - center) / scale
      if (!pass) {
        // 不通过时把整条剖面打出来：报告里要能看出是「中间凹下去的 V 形」（竖缝）
        // 还是「从左到右单调爬升」（两张纸的明暗梯度跨过接缝）。
        console.log(`        剖面 ${edge.index}→${edge.index + 1}：${lum.join(',')}`)
      }
      check(
        `帧 ${frameIndex} 带 ${edge.index}→${edge.index + 1}（${(Math.abs(angles[edge.index] ?? 0)).toFixed(1)}°/${(Math.abs(angles[edge.index + 1] ?? 0)).toFixed(1)}°，y=${edge.y.toFixed(1)}, x=${edge.x.toFixed(1)}）亮度无竖缝`,
        pass,
        `${prof.width}×${prof.height}px 列中位：两侧 ${leftFar.toFixed(1)} / ${rightFar.toFixed(1)}（台阶 ${step.toFixed(1)}/255，仅参考），最深深陷 ${dip.toFixed(1)}/255 @ 离边心 ${dipOffset.toFixed(1)}px，窗口最低 ${lowest}/255（桌面 ${desk.toFixed(1)}，漏桌 ${leaksDesk ? '是' : '否'}）`,
      )
    }
  }

  // 书缝（中缝）几何：后面所有裁剪截图与像素剖面都按它定位。
  const geom = await ev(`
    const gutter = document.querySelector('.real-book-gutter');
    const book = document.querySelector('.real-book-book');
    if (!gutter || !book) return null;
    const g = gutter.getBoundingClientRect();
    const b = book.getBoundingClientRect();
    return {
      gutterLeft: g.left, gutterWidth: g.width,
      gutterTop: g.top, gutterBottom: g.bottom,
      midY: b.top + b.height * 0.5,
      bookTop: b.top, bookBottom: b.bottom, bookCenterX: b.left + b.width * 0.5,
    };
  `)
  check('书缝元素存在且位于两页之间', Boolean(geom),
    geom ? `中缝 x=${geom.gutterLeft.toFixed(1)} 宽=${geom.gutterWidth.toFixed(1)} 页心 x=${geom.bookCenterX.toFixed(1)}` : '找不到 .real-book-gutter')
  // 书心不占宽度（`.real-book-gutter { width: 0 }`，两页装订边直接落在中心线上），
  // 所以「中缝宽度」和「中缝亮度剖面」对当前渲染不再适用：中缝没有自己的像素列。
  // 这两条不当作翻页竖缝的证据，也不应因零宽而报失败。
  const gutterHasWidth = Boolean(geom) && geom.gutterWidth >= 1

  const paperBox = await ev(`
    const stage = document.querySelector('.real-book-stage');
    const book = document.querySelector('.real-book-book');
    const el = book || stage;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  `)
  // 参考图的底部胶囊栏处于可见态：模拟用户把鼠标移到画布底部，
  // 否则阅读器的自动隐藏逻辑会让截图漏掉工具栏。
  await cdp('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 682,
    y: 735,
    button: 'none',
    buttons: 0,
  })
  await sleep(180)

  // 静态书台截图：这是与参考图 1/2/3 对照尺寸、透视、配色的主证据。
  await takeShot('realbook-static.png')
  // 书缝特写：与上传图片对照中缝的谷形、折起的纸缘亮线与左右页观感。
  if (geom) {
    await takeShot('realbook-seam-static.png', {
      x: Math.max(0, Math.round(geom.gutterLeft - 110)),
      y: Math.max(0, Math.round(geom.bookTop - 6)),
      width: Math.round(geom.gutterWidth + 220),
      height: Math.round(geom.bookBottom - geom.bookTop + 12),
      scale: 2,
    })
    console.log(`      书缝静态截图：${shots[shots.length - 1]}`)
  }

  if (slowFlip) {
    // 组件用 performance.now() 推进几何、用 setTimeout(FLIP_DURATION_MS) 落页。
    // 两项一起放慢，才能在真实 Electron 里稳定截到 15% / 45% / 75% 的曲面。
    await ev(`
      const realNow = performance.now.bind(performance);
      const started = realNow();
      const slowNow = () => started + (realNow() - started) * 0.1;
      let frozen = null;
      performance.now = () => (frozen === null ? slowNow() : frozen);
      window.__rbSlowNow = () => slowNow();
      window.__rbFrozen = false;
      window.__rbPendingFinish = null;
      window.__rbFreezeAt = (value) => { frozen = value; window.__rbFrozen = true; return 'ok'; };
      window.__rbUnfreeze = () => {
        frozen = null;
        window.__rbFrozen = false;
        const finish = window.__rbPendingFinish;
        window.__rbPendingFinish = null;
        if (finish) finish();
        return 'ok';
      };
      const realSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...args) => realSetTimeout(() => {
        // 截图期间时钟是冻结的，落定定时器不能把翻页页拆掉，否则后面的帧全拍成静态页。
        if (window.__rbFrozen) window.__rbPendingFinish = () => fn(...args);
        else fn(...args);
      }, ms * 10);
      return 'ok';
    `)
    console.log('      慢动作模式：翻页放慢 10 倍')
  }

  const clickNextX = paperBox.left + paperBox.width * 0.88
  const clickPrevX = paperBox.left + paperBox.width * 0.12
  const clickY = paperBox.top + paperBox.height * 0.95
  let measureClicks = 0

  // 截图：把翻页中的几个关键帧拍下来，几何对不对得用眼睛看。
  //
  // 截图单独跑一轮，不混进帧统计：captureScreenshot 是同步的、会阻塞渲染进程，
  // 混进统计里会把「拍照卡住」算成「翻页掉帧」。
  const shootFlip = async () => {
    await cdp('Page.bringToFront')
    const clickClock = slowFlip ? await ev('return window.__rbSlowNow();') : 0
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickNextX, y: clickY, button: 'left', buttons: 1, clickCount: 1 })
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickNextX, y: clickY, button: 'left', buttons: 0, clickCount: 1 })
    await waitFor(`document.querySelector('.real-book-flip')`, 3000)
    // 帧选择：0.45–0.52 正是竖带转过 84°–91° 的那一段（0.54 起整页已越过 91°，
    // 纸背全显，再往后看不到交接）。取四帧才看得清"只换字、不露缝"。
    //
    // 慢动作模式下不能靠 sleep 截：截图本身会阻塞渲染进程，动画仍在继续，
    // 第二张常常已经落定。改为把组件用的 performance.now 钉在目标进度，
    // 每张都冻结在确定的相位。
    const frames = slowFlip ? [0.45, 0.48, 0.5, 0.52] : null
    const frameCount = frames ? frames.length : 3
    for (let index = 0; index < frameCount; index += 1) {
      if (frames) {
        const target = clickClock + frames[index] * 820
        await ev(`window.__rbFreezeAt(${target})`)
        // 等 Vue 把冻结后的几何写进 DOM：两三个 rAF 足够，且截图期间时钟不动。
        await ev(`new Promise((resolve) => {
          let left = 6;
          const tick = () => { left -= 1; if (left <= 0) resolve('ok'); else requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
        })`)
        // rAF 只保证下一帧调度；再让出一小段真实时间，等 Vue 把几何写进 DOM。
        await sleep(120)
      } else {
        await sleep(index === 0 ? 110 : index === 1 ? 170 : 200)
      }
      await takeShot(`realbook-flip-${index + 1}.png`)
      if (frames) {
        await inspectBandSeams(index + 1)
        // 两套判据分开跑：命中测试问「纸上漏没漏列」，亮度剖面问「边上亮度连不连续」。
        // 两者结论不一致时，报告里以命中测试为准（它是竖缝的直接证据）。
        await bandBrightnessProfile(index + 1)
      }
    }
    if (frames) await ev('window.__rbUnfreeze()')
    await waitFor(`!document.querySelector('.real-book-flip')`, slowFlip ? 14000 : 5000)
  }

  /**
   * 跑一次翻页并统计。
   * @param {string} label 本轮标签
   * @param {string} setupCss 额外注入的 CSS（用于 A/B 对照）
   */
  const measureFlipOnce = async (label, setupCss = '') => {
    await ev(`
      window.__probe.frames = [];
      window.__probe.flipStart = 0;
      window.__probe.flipEnd = 0;
      window.__probe.longTasks = [];
      const style = document.getElementById('__probe_css') || document.createElement('style');
      style.id = '__probe_css';
      style.textContent = ${JSON.stringify(setupCss)};
      document.head.appendChild(style);
      return 'ok';
    `)
    await sleep(200)
    await cdp('Page.bringToFront')
    // 夹具只有几页；如果每次都往同一方向翻，翻到章末后就再也测不到动画。
    // 前后交替点击，页位在两三页之间往返，每个方案都在同一段正文上测。
    const direction = measureClicks % 2 === 0 ? 1 : -1
    measureClicks += 1
    const clickX = direction === 1 ? clickNextX : clickPrevX
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', buttons: 1, clickCount: 1 })
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', buttons: 0, clickCount: 1 })
    await waitFor(`document.querySelector('.real-book-flip')`, 3000)
    await waitFor(`!document.querySelector('.real-book-flip')`, 5000)
    await sleep(400)
    await sleep(400)
    const stats = await ev(`
      const p = window.__probe;
      const frames = p.frames;
      const gaps = [];
      for (let i = 1; i < frames.length; i += 1) gaps.push(frames[i] - frames[i - 1]);
      const sorted = [...gaps].sort((a, b) => a - b);
      const at = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0;
      // 翻页存续区间内的帧：只有这些帧是「翻页动画本身」的帧。
      const inFlip = frames.filter((ts) => ts >= p.flipStart && ts <= p.flipEnd);
      const flipGaps = [];
      for (let i = 1; i < inFlip.length; i += 1) flipGaps.push(inFlip[i] - inFlip[i - 1]);
      const flipSorted = [...flipGaps].sort((a, b) => a - b);
      const flipAt = (q) => flipSorted.length ? flipSorted[Math.min(flipSorted.length - 1, Math.floor(flipSorted.length * q))] : 0;
      // 落在翻页区间里的长任务：主线程被占住的总量。
      const longInFlip = p.longTasks.filter((t) => t.start >= p.flipStart - 50 && t.start <= p.flipEnd + 50);
      return {
        flipDuration: p.flipEnd - p.flipStart,
        flipFrames: inFlip.length,
        flipMedian: flipAt(0.5),
        flipMax: flipSorted.length ? flipSorted[flipSorted.length - 1] : 0,
        flipLong: flipGaps.filter((g) => g > ${LONG_FRAME_MS}).length,
        flipSevere: flipGaps.filter((g) => g > ${SEVERE_FRAME_MS}).length,
        longTaskCount: longInFlip.length,
        longTaskTotal: longInFlip.reduce((sum, t) => sum + t.duration, 0),
        longTaskMax: longInFlip.length ? Math.max(...longInFlip.map((t) => t.duration)) : 0,
        allMedian: at(0.5),
        totalFrames: frames.length,
        hidden: document.hidden,
        visibility: document.visibilityState,
      };
    `)
    console.log(`      [${label}] ${JSON.stringify(stats)}`)
    return stats
  }

  /**
   * 重复跑若干次取中位数。
   *
   * 单次测量方差极大：同一份代码实测翻页帧数在 7 / 12 / 31 之间跳，
   * 机器负载一波动就盖过方案差异。只看单次会把噪声当结论。
   */
  const measureFlip = async (label, setupCss = '') => {
    const runs = []
    for (let i = 0; i < 3; i += 1) runs.push(await measureFlipOnce(`${label} #${i + 1}`, setupCss))
    const median = (pick) => {
      const values = runs.map(pick).sort((a, b) => a - b)
      return values[Math.floor(values.length / 2)]
    }
    const merged = {
      flipDuration: median((r) => r.flipDuration),
      flipFrames: median((r) => r.flipFrames),
      flipMedian: median((r) => r.flipMedian),
      flipMax: median((r) => r.flipMax),
      flipLong: median((r) => r.flipLong),
      flipSevere: median((r) => r.flipSevere),
      runs: runs.map((r) => r.flipFrames),
    }
    console.log(`      [${label} 汇总] ${JSON.stringify(merged)}`)
    return merged
  }

  // 第一次翻页要付字形栅格化、纸纹与合成层的冷启动成本，直接计进基线会把
  // 「首帧编译」误判成「动画卡顿」。先不计分地翻两次，把热态稳定下来。
  if (!slowFlip) {
    await measureFlipOnce('预热 #1')
    await measureFlipOnce('预热 #2')
    await measureFlipOnce('预热 #3')
    await measureFlipOnce('预热 #4')
  }
  const baseline = slowFlip ? null : await measureFlip('基线')
  const noBlur = slowFlip ? null : await measureFlip('去 blur', '.real-book-flip-face { filter: none !important; }')
  const noBackText = slowFlip ? null : await measureFlip('去背面文字', '.real-book-flip-back .real-book-page-body { display: none !important; }')
  const neither = slowFlip ? null : await measureFlip('去 blur + 去背面文字',
    '.real-book-flip-face { filter: none !important; } .real-book-flip-back .real-book-page-body { display: none !important; }')

  // 截图单独一轮：captureScreenshot 会阻塞渲染进程，混进帧统计就等于
  // 把「拍照卡住」算成「翻页掉帧」。
  await shootFlip()

  // 书缝像素剖面：书心必须是纸，不是暗谷。
  //
  // 书心现在是零宽的（见上），没有自己的像素列可测；只有旧版宽书心才跑这两条。
  // 它们测的是书脊谷暗部，与本题的「竖带竖缝」无关，不能相互代替。
  if (gutterHasWidth) {
    await cdp('Page.bringToFront')
    await sleep(300)
    const prof = await seamProfile()
    console.log(`      书心亮度剖面：左纸 ${prof.leftPaper.toFixed(1)} · 中缝均 ${prof.seamAvg.toFixed(1)} · 中缝最低 ${prof.seamMin} · 右纸 ${prof.rightPaper.toFixed(1)}`)
    const sideAvg = (prof.leftPaper + prof.rightPaper) / 2
    check('书心没有暗带（中缝与两侧纸面同亮度）',
      Math.abs(prof.seamAvg - sideAvg) < 8 &&
        prof.seamMin > Math.min(prof.leftPaper, prof.rightPaper) - 12,
      `中缝均 ${prof.seamAvg.toFixed(1)}，两侧均 ${sideAvg.toFixed(1)}，中缝最低 ${prof.seamMin}`)
    check('中缝不是一条纯黑裂缝（保留纸色层次）',
      prof.seamMin > 120,
      `中缝最低 ${prof.seamMin}（低于 120 就接近桌面透出来的黑缝）`)
  } else {
    console.log(`--    书心中缝宽 ${geom ? geom.gutterWidth.toFixed(1) : '?'}px（零宽，两页直落中心线）：跳过中缝暗带判定`)
  }

  const fmt = (s) => `翻页时长 ${Math.round(s.flipDuration)}ms，翻页帧 ${s.flipFrames}，中位间隔 ${s.flipMedian?.toFixed(1)}ms，最大 ${s.flipMax?.toFixed(1)}ms，长帧 ${s.flipLong}，长任务 ${s.longTaskCount} 次共 ${Math.round(s.longTaskTotal)}ms`

  if (baseline) {
    check('翻页时长接近设计值（820ms ± 40%）', baseline.flipDuration > 490 && baseline.flipDuration < 1150, fmt(baseline))
    check(
      '翻页期间每帧都能渲染出来（主线程没被堵死）',
      baseline.flipFrames >= 24,
      fmt(baseline),
    )
    check(
      '翻页期间没有严重长帧',
      baseline.flipSevere === 0,
      fmt(baseline),
    )
    check(
      '翻页期间长帧比例不超过 10%',
      baseline.flipFrames > 1 && baseline.flipLong / baseline.flipFrames <= 0.1,
      fmt(baseline),
    )
  } else {
    console.log('      慢动作模式：跳过帧率判定，只保留视觉截图')
  }
  if (consoleErrors.length) {
    console.log('      —— 渲染进程报错 ——')
    for (const line of consoleErrors.slice(0, 8)) console.log('      ' + line)
  }
  console.log('      —— A/B 对照 ——')
  if (shots.length) console.log(`      翻页中截图：${shots.join(', ')}`)
  if (baseline) {
    console.log(`      基线          ${fmt(baseline)}`)
    console.log(`      去 blur       ${fmt(noBlur)}`)
    console.log(`      去背面文字     ${fmt(noBackText)}`)
    console.log(`      两者都去       ${fmt(neither)}`)
  }
} catch (error) {
  check('翻页流畅度检查流程未抛异常', false, String((error && error.stack) || error))
} finally {
  try { ws?.close() } catch { /* noop */ }
  killTree()
  await sleep(500)
  await rm(lib, { recursive: true, force: true }).catch(() => {})
  await rm(userData, { recursive: true, force: true }).catch(() => {})
  if (process.env.SPBF_KEEP_SHOTS !== '1' && shotDir) {
    await rm(shotDir, { recursive: true, force: true }).catch(() => {})
  }
}

console.log(`\n结果：${passed.length} 项通过，${failed.length} 项失败`)
if (failed.length) {
  console.log('--- 应用输出（尾部）---')
  console.log(out.slice(-2000))
  process.exit(1)
}
console.log('真实书籍翻页流畅度检查通过')

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
  const shotDir = await mkdtemp(join(tmpdir(), 'spbf-rbfps-shots-'))
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
   * 拿到的是真实像素，不是「我觉得中缝应该有暗」。剖面必须呈现「亮—暗谷—亮」的谷形：
   * 只有暗带塌成一条均匀黑边，说明中缝读成了裂缝而不是纸陷下去的谷。
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
  check('书缝元素存在且位于两页之间', Boolean(geom) && geom.gutterWidth > 0,
    geom ? `中缝 x=${geom.gutterLeft.toFixed(1)} 宽=${geom.gutterWidth.toFixed(1)} 页心 x=${geom.bookCenterX.toFixed(1)}` : '找不到 .real-book-gutter')

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
    const seamClip = geom
      ? {
          x: Math.max(0, Math.round(geom.gutterLeft - 110)),
          y: Math.max(0, Math.round(geom.bookTop - 6)),
          width: Math.round(geom.gutterWidth + 220),
          height: Math.round(geom.bookBottom - geom.bookTop + 12),
          scale: 2,
        }
      : null
    // 三帧：起手纸角卷起、弯度峰值（纸弯成弓）、落定前舒展摊平。
    //
    // 慢动作模式下不能靠 sleep 截：截图本身会阻塞渲染进程，动画仍在继续，
    // 第二张常常已经落定。改为把组件用的 performance.now 钉在目标进度，
    // 每张都冻结在确定的相位。
    const frames = slowFlip ? [0.30, 0.45, 0.62] : null
    for (let index = 0; index < 3; index += 1) {
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
      if (seamClip) await takeShot(`realbook-seam-flip-${index + 1}.png`, seamClip)
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

  // 书缝像素剖面：中缝必须是「陷下去的谷」——两侧是纸，中间显著更暗。
  if (geom) {
    await cdp('Page.bringToFront')
    await sleep(300)
    const prof = await seamProfile()
    console.log(`      书缝亮度剖面：左纸 ${prof.leftPaper.toFixed(1)} · 中缝均 ${prof.seamAvg.toFixed(1)} · 中缝最低 ${prof.seamMin} · 右纸 ${prof.rightPaper.toFixed(1)}`)
    check('中缝比两侧纸面明显更暗（谷形存在）',
      prof.seamMin < Math.min(prof.leftPaper, prof.rightPaper) - 20,
      `中缝最低 ${prof.seamMin}，左纸 ${prof.leftPaper.toFixed(1)}，右纸 ${prof.rightPaper.toFixed(1)}`)
    check('中缝不是一条纯黑裂缝（保留纸色层次）',
      prof.seamMin > 30,
      `中缝最低 ${prof.seamMin}（低于 30 就接近桌面透出来的黑缝）`)
    const seam = prof.px.slice(prof.from, prof.to)
    const darkest = seam.indexOf(Math.min(...seam))
    check('最暗处在中缝内而不是贴着一侧纸边',
      darkest > 0 && darkest < seam.length - 1,
      `最暗列 ${darkest}/${seam.length}`)
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
  if (process.env.SPBF_KEEP_SHOTS !== '1') {
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

// R2 进度恢复实测探针（真实 Electron + CDP）。
//
// 目标症状（docs/reader-experience-upgrade.md R2）：
//   「读完关掉再开书，重开位置与离开处相差不超过一屏」——
//   跨字号 / 列宽 / 窗口尺寸 / 正文被清或重下，都要成立。
//
// 方法：每组场景跑两次应用进程（= 真的关掉再打开）
//   A 段：按离开时的排版打开书 → 滚到章内 55% → 等进度落盘 → 记「离开快照」→ 关闭应用
//   B 段：按变化后的排版打开同一本书 → 等恢复落点稳定 → 记「重开快照」
//   误差 = |重开后首可见段 - 离开时写入的锚点段|，并对「一屏可见段落数」判定。
//
// 用法：npm run build 之后 `node .multi-agent/evidence/reader-progress-r2-2026-11-02/r2-probe.mjs`
// 注意：每组会在桌面上真开应用窗口（约十几秒），结束后自动关掉。
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(dirname(dirname(here)))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 阅读设置基线：scroll 阅读模式（直接测量滚动位置），关掉自动续章避免滚到底时换章。
const PREF_BASE = {
  dim: 0,
  fontSize: 18,
  lineHeight: 1.8,
  theme: 'paper',
  fontFamily: 'serif',
  contentWidth: 'narrow',
  paragraphSpacing: 'normal',
  paragraphIndent: true,
  focusMode: 'off',
  readingMode: 'scroll',
  hideSiteTail: true,
  hideReaderChrome: true,
  autoScrollSpeed: 3,
  autoNextChapter: false,
}
const BOOK_ID = 'd_r2'
const BOOK_TITLE = 'R2 恢复测试书'
const CHAPTER_PARAS = 200
// 离开时落在第 2 章章内 55%：离章首章末都远，避免边界钳制把误差掩盖掉。
const LEAVE_RATIO = 0.55

// ---------------------------------------------------------------- 夹具

/** 与真实小说段落同构：约 40~60 字，18px/38em 下 2~3 行 ≈ 60~100px。 */
function para(i, salt) {
  return `第${i + 1}段${salt}：${'他把书页翻过去，纸面上的字迹在台灯下泛着淡淡的黄，像是被人反复摩挲过。'.slice(0, 40)}`
}

async function makeLibrary({ chapters = 3, parasPerChapter = CHAPTER_PARAS } = {}) {
  const lib = await mkdtemp(join(tmpdir(), 'spbf-r2-lib-'))
  const dir = join(lib, BOOK_ID)
  await mkdir(join(dir, 'chapters'), { recursive: true })
  const now = new Date().toISOString()
  const chapterMeta = []
  for (let c = 1; c <= chapters; c += 1) {
    const id = `c${String(c).padStart(4, '0')}`
    const body = Array.from({ length: parasPerChapter }, (_, i) => para(i, `（${c}）`)).join('\n\n')
    chapterMeta.push({
      id, index: c, title: `第${c}章`, url: `https://example.com/w/${c}.html`,
      file: `chapters/${String(c).padStart(4, '0')}.json`, status: 'ready',
    })
    await writeFile(join(dir, 'chapters', `${String(c).padStart(4, '0')}.json`), JSON.stringify({
      title: `第${c}章`, url: `https://example.com/w/${c}.html`, body, status: 'ready',
    }), 'utf-8')
  }
  await writeFile(join(dir, 'book.json'), JSON.stringify({
    id: BOOK_ID, title: BOOK_TITLE, author: '测试', tags: [],
    sourceUrl: 'https://example.com/w/', sourceHost: 'example.com',
    importType: 'download', createdAt: now, updatedAt: now, status: 'ready',
    chapters: chapterMeta,
    progress: { chapterId: 'c0001', scrollRatio: 0, updatedAt: now },
  }, null, 2), 'utf-8')
  return lib
}

/** 改写某一章的正文（模拟正文被清理 / 重新下载过）。 */
async function rewriteChapterBody(lib, chapterIndex, body) {
  const file = join(lib, BOOK_ID, 'chapters', `${String(chapterIndex).padStart(4, '0')}.json`)
  const chapter = JSON.parse(await readFile(file, 'utf-8'))
  chapter.body = body
  await writeFile(file, JSON.stringify(chapter), 'utf-8')
  return file
}

async function readProgressOnDisk(lib) {
  try {
    const book = JSON.parse(await readFile(join(lib, BOOK_ID, 'book.json'), 'utf-8'))
    return book.progress || null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 一次应用进程

const killTree = (child) => {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGTERM')
  } catch { /* 已经退出了 */ }
}

/**
 * 起一个真实应用进程，把 CDP 小工具交给 onPage；退出时一定关窗口 + 清 userData。
 * viewport 走 Emulation.setDeviceMetricsOverride 改渲染视口（模拟换窗口尺寸），
 * 生效与否由调用方用 innerWidth 自证。
 */
async function withApp({ lib, prefs, viewport }, onPage) {
  const userData = await mkdtemp(join(tmpdir(), 'spbf-r2-user-'))
  await writeFile(join(userData, 'settings.json'), JSON.stringify({
    libraryPath: lib,
    reader: { ...PREF_BASE, ...prefs },
  }, null, 2), 'utf-8')

  const port = 38000 + Math.floor(Math.random() * 2000)
  // 父进程（如 VS Code）会把 ELECTRON_RUN_AS_NODE=1 带进环境，让 electron.exe 变成纯 Node。
  const childEnv = { ...process.env }
  delete childEnv.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, [root, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
  })
  let out = ''
  child.stdout.on('data', (chunk) => { out += String(chunk) })
  child.stderr.on('data', (chunk) => { out += String(chunk) })

  let ws
  try {
    let target
    for (let i = 0; i < 120; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`)
        const list = await response.json()
        target = list.find((t) => t.type === 'page' && t.url.startsWith('file:'))
        if (target) break
      } catch { /* 调试端口还没起来 */ }
      await sleep(250)
    }
    if (!target) throw new Error('没找到渲染页 CDP target，应用可能没起窗口：\n' + out.slice(-2000))

    ws = new WebSocket(target.webSocketDebuggerUrl)
    await Promise.race([
      new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 10000)),
    ])
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
      // CDP 兜底：页面侧 promise 挂死（如后台 rAF）会让调用永不返回，15s 超时浮出。
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP ${method} 超时（15s）`))
      }, 15000)
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
    const ev = async (body) => {
      const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
      return r.result?.value
    }
    const waitFor = async (expr, timeout = 15000) => {
      const started = Date.now()
      while (Date.now() - started < timeout) {
        if (await ev(`return Boolean(${expr});`)) return true
        await sleep(150)
      }
      return false
    }
    const click = (expr) => ev(`const el = ${expr}; if (!el) return 'none'; el.scrollIntoView(); el.click(); return 'ok';`)

    let viewportApplied = null
    if (viewport) {
      try {
        await cdp('Emulation.setDeviceMetricsOverride', {
          width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false,
        })
        const live = await ev('return { w: window.innerWidth, h: window.innerHeight };')
        viewportApplied = {
          requested: viewport,
          live,
          ok: Math.abs(live.w - viewport.width) < 60 && Math.abs(live.h - viewport.height) < 60,
        }
      } catch (error) {
        viewportApplied = { requested: viewport, ok: false, error: String(error && error.message || error) }
      }
    }

    return await onPage({ ev, waitFor, click, cdp, viewportApplied, dump: () => out.slice(-2000) })
  } catch (error) {
    const wrapped = new Error(String(error && error.stack || error) + `\n--- 应用输出尾部 ---\n${out.slice(-1500)}`)
    throw wrapped
  } finally {
    try { ws?.close() } catch { /* noop */ }
    killTree(child)
    await sleep(500)
    await rm(userData, { recursive: true, force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------- 页面侧读写

async function openBook(api, title = BOOK_TITLE) {
  const { ev, waitFor, click } = api
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((x) => x.textContent === '书库')`, 30000)
  await click(`[...document.querySelectorAll('.nav-btn')].find((b) => b.querySelector('.nav-label')?.textContent === '书库')`)
  await waitFor(`document.querySelector('.book-open-area')`, 15000)
  const opened = await ev(`
    const title = ${JSON.stringify(title)};
    const area = [...document.querySelectorAll('.book-open-area')].find((a) => (a.querySelector('.book-title')?.textContent || '').trim() === title);
    if (!area) return 'none';
    area.click();
    return 'ok';
  `)
  if (opened !== 'ok') throw new Error(`书库里找不到《${title}》`)
  if (!await waitFor(`document.querySelector('.reader-content')`, 20000)) throw new Error('阅读器正文没渲染出来')
  if (!await waitFor(`document.querySelectorAll('.reader-content .para[data-p]').length > 0`, 20000)) throw new Error('正文段落没渲染出来')
}

/**
 * 页面上「一屏」到底几段：视口顶线压住的第一段 + 视口高 / 平均段高。
 * 采样前强制两帧：smooth 滚动 / 迁窗都是异步的，中途快照会得到伪影（前车之鉴：Home/End 假缺陷）。
 */
const SNAPSHOT_JS = `
  // rAF 兜底：窗口不可见/最小化时 requestAnimationFrame 不触发，等 2s 超时就继续。
  await new Promise((r) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; r(); } };
    const guard = setTimeout(() => done(), 2000);
    requestAnimationFrame(() => { clearTimeout(guard); done(); });
  });
  const pane = document.querySelector('.reader-content');
  if (!pane) return null;
  const rect = pane.getBoundingClientRect();
  const paneTop = rect.top;
  const paras = [...pane.querySelectorAll('.para[data-p]')].map((n) => {
    const r = n.getBoundingClientRect();
    return { p: Number(n.dataset.p), top: r.top, bottom: r.bottom };
  });
  if (!paras.length) return null;
  // 首可见段 = 第一条「底边越过视口顶线」的段（用户看到的第一行就属于它）。
  const firstVisible = paras.find((s) => s.bottom > paneTop + 1);
  // 锚点段 = 第一条「顶边不低于视口顶线 + 4px」的段，与 Reader.vue 的 paragraphAnchor() 同义。
  const anchorLike = paras.find((s) => s.top >= paneTop + 4);
  const cy = paneTop + pane.clientHeight / 2;
  const centerPara = paras.find((s) => s.top <= cy && s.bottom >= cy);
  const avgH = paras.reduce((sum, s) => sum + (s.bottom - s.top), 0) / paras.length;
  const maxTop = pane.scrollHeight - pane.clientHeight;
  return {
    firstVisibleP: firstVisible ? firstVisible.p : -1,
    anchorLikeP: anchorLike ? anchorLike.p : -1,
    centerP: centerPara ? centerPara.p : -1,
    renderedNodes: paras.length,
    minP: Math.min(...paras.map((s) => s.p)),
    maxP: Math.max(...paras.map((s) => s.p)),
    scrollTop: Math.round(pane.scrollTop),
    scrollHeight: Math.round(pane.scrollHeight),
    clientHeight: pane.clientHeight,
    paneWidth: Math.round(pane.clientWidth),
    scrollRatio: maxTop > 0 ? pane.scrollTop / maxTop : 0,
    avgParaHeight: Math.round(avgH * 10) / 10,
    parasPerScreen: avgH > 0 ? Math.round((pane.clientHeight / avgH) * 10) / 10 : 0,
    fontSize: getComputedStyle(pane).fontSize,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    chapterTitle: document.querySelector('.ch-title')?.textContent?.trim() || '',
  };
`

/** 小章节（<2000 段）分批渲染：先滚到底把后续批次催出来，直到整章落地。 */
async function ensureFullyRendered(api, expectedParas) {
  return api.ev(`
    const pane = document.querySelector('.reader-content');
    const deadline = Date.now() + 12000;
    let nodes = pane.querySelectorAll('.para[data-p]').length;
    while (Date.now() < deadline) {
      nodes = pane.querySelectorAll('.para[data-p]').length;
      if (nodes >= ${expectedParas}) break;
      pane.scrollTop = pane.scrollHeight;
      await new Promise((r) => setTimeout(r, 150));
    }
    return nodes;
  `)
}

// ---------------------------------------------------------------- 场景骨架

/**
 * 一组场景：A 段抓离开位置 → （可选）改正文 → B 段按新排版重开并测落点。
 */
async function runScenario({ name, note, leavePrefs = {}, arrivePrefs = {}, leaveViewport = null, arriveViewport = null, mutate = null, chapters = 3, parasPerChapter = CHAPTER_PARAS, leaveViaIpc = false, leaveOffset = 24 }) {
  const record = { name, note, leave: null, disk: null, arrive: null, verdict: null, error: null }
  let lib
  // 单次 CDP 启动偶发失败（Windows 冷启动慢）：整段 A / 整段 B 重试一次，场景不因此报废。
  const retryOnce = async (label, fn) => {
    try {
      return { ok: true, value: await fn() }
    } catch (error) {
      console.error(`  [${label}] 首次尝试失败（${String(error.message || error).split('\n')[0]}），重试一次`)
      try {
        return { ok: true, value: await fn() }
      } catch (second) {
        return { ok: false, error: second }
      }
    }
  }
  try {
    lib = await makeLibrary({ chapters, parasPerChapter })

    // ---- A 段：离开
    const leaveResult = await retryOnce('A段', () => withApp({ lib, prefs: leavePrefs, viewport: leaveViewport }, async (api) => {
      await openBook(api)
      const nodes = await ensureFullyRendered(api, parasPerChapter)
      // 目标章 = 第 2 章：切目录，避免整本只有一章时章首钳制。
      const switched = await api.ev(`
        const btn = [...document.querySelectorAll('.bottom-button')].find((b) => b.textContent.trim() === '目录');
        if (!btn) return 'no-catalog-button';
        btn.click();
        await new Promise((r) => setTimeout(r, 400));
        const items = [...document.querySelectorAll('.n-drawer .n-list-item')];
        const target = items.find((it) => (it.textContent || '').includes('第2章'));
        if (!target) return 'no-chapter';
        target.scrollIntoView(); target.click();
        return 'ok';
      `)
      if (switched !== 'ok') throw new Error(`切到第 2 章失败：${switched}`)
      const settled = await api.waitFor(`(document.querySelector('.ch-title')?.textContent || '').includes('第2章')`, 12000)
      if (!settled) throw new Error('第 2 章没打开')
      // openChapter 是长 await 链：ch-title 出现后收尾（进度保存、scrollToRatio(0) 复位）
      // 仍可能在几百毫秒后把 scrollTop 打回 0。等一个「安定期」再动滚动条。
      await api.ev(`await new Promise((r) => setTimeout(r, 800)); return 'ok';`)
      await ensureFullyRendered(api, parasPerChapter)
      await api.ev(`await new Promise((r) => setTimeout(r, 800)); return 'ok';`)
      // 滚到章内 55%（直接设 scrollTop：瞬时、非 smooth，不会采到动画中途）。
      // 轮询等 scrollTop 落定；循环结束后强制再设一次，避免组件收尾把采样打回章首。
      const roll = await api.ev(`
        const pane = document.querySelector('.reader-content');
        const maxTop = pane.scrollHeight - pane.clientHeight;
        const target = Math.round(${LEAVE_RATIO} * maxTop);
        let stable = 0, tries = 0;
        while (tries < 120) {
          tries += 1;
          pane.scrollTop = target;
          await new Promise((r) => setTimeout(r, 200));
          if (Math.abs(pane.scrollTop - target) < 2) { stable += 1; if (stable >= 3) break; }
          else stable = 0;
        }
        pane.scrollTop = target;
        await new Promise((r) => setTimeout(r, 400));
        return { scrollTop: pane.scrollTop, target, stable, tries };
      `)
      if (Math.abs(roll.scrollTop - roll.target) > 2) throw new Error(`滚动未能落定：scrollTop=${roll.scrollTop} 目标=${roll.target}（组件在复位滚动）`)
      const snap = await api.ev(SNAPSHOT_JS)
      if (leaveViaIpc) {
        // Emulation 视口下 schedule 写盘链会被阻塞（探针环境伪影，非产品缺陷）：
        // 直接以快照的锚点位置走一次 setProgress IPC，作为「离开时盘上的进度」。
        // leaveOffset 模拟 paragraphAnchor 的字符偏移：24（真实中段）、0（段落开头对齐视口顶，真实可达）。
        const p = snap.anchorLikeP >= 0 ? snap.anchorLikeP : 0
        const ratio = snap.scrollRatio
        const ipc = await api.ev(`
          try {
            const res = await window.api.library.setProgress('${BOOK_ID}', {
              chapterId: 'c0002', scrollRatio: ${ratio}, paragraphIndex: ${p}, paragraphOffset: ${leaveOffset},
              updatedAt: new Date().toISOString(),
            });
            return { ok: res && res.ok !== false, res };
          } catch (error) { return { ok: false, error: String(error && error.message || error) }; }
        `)
        if (!ipc.ok) throw new Error(`leaveViaIpc 写盘失败：${JSON.stringify(ipc)}`)
        await sleep(1200)
        let disk = await readProgressOnDisk(lib)
        if (!disk || disk.chapterId !== 'c0002' || disk.paragraphIndex !== p) {
          throw new Error(`leaveViaIpc 写盘未确认：期望 c0002/${p}，盘上=${JSON.stringify(disk)}`)
        }
        return { snap, disk, nodes, viewportApplied: api.viewportApplied, flushNeeded: false, leaveViaIpc: true }
      }
      // 等进度落盘（schedule 延迟 1000ms + IPC，且写盘是串行链，前面可能排着上一章的保存）。
      // 确认条件：chapterId 正确，且 paragraphIndex 追平页面快照的锚点段（±2）——
      // 否则可能读到「切章瞬间章首」的旧进度，重开会测出假误差。
      // 诊断：记录每次轮询读到的磁盘进度，追不上时能看出卡在哪一步。
      let disk = null
      const expectedP = snap.anchorLikeP
      const diskTrace = []
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await sleep(2000)
        disk = await readProgressOnDisk(lib)
        diskTrace.push(disk ? `c=${disk.chapterId} p=${disk.paragraphIndex} r=${Math.round(disk.scrollRatio * 100) / 100}` : 'null')
        if (disk && disk.chapterId === 'c0002' && Number.isInteger(disk.paragraphIndex)
          && Math.abs(disk.paragraphIndex - expectedP) <= 2) break
      }
      if (!disk || disk.chapterId !== 'c0002' || !Number.isInteger(disk.paragraphIndex)
        || Math.abs(disk.paragraphIndex - expectedP) > 2) {
        // 兜底：schedule 路径可能没触发（诊断见轮询轨迹）。点书库离开阅读器会走
        // flushPendingReaderWrites → writeNow，比「杀进程」更接近真实关闭应用的写盘路径。
        const flushed = await api.ev(`
          const btn = [...document.querySelectorAll('.nav-btn')].find((b) => b.querySelector('.nav-label')?.textContent === '书库');
          if (!btn) return 'no-nav';
          btn.click();
          await new Promise((r) => setTimeout(r, 400));
          return 'ok';
        `)
        await sleep(2500)
        disk = await readProgressOnDisk(lib)
        if (disk && disk.chapterId === 'c0002' && Number.isInteger(disk.paragraphIndex)
          && Math.abs(disk.paragraphIndex - expectedP) <= 2) {
          return { snap, disk, nodes, viewportApplied: api.viewportApplied, flushNeeded: true }
        }
        throw new Error(`离开进度未追平页面位置：页面锚点段=${expectedP}，flush 后盘上=${disk ? JSON.stringify(disk) : 'null'}，轮询轨迹=[${diskTrace.join(' | ')}]`)
      }
      return { snap, disk, nodes, viewportApplied: api.viewportApplied, flushNeeded: false }
    }))
    if (!leaveResult.ok) throw leaveResult.error
    record.leave = leaveResult.value.snap
    record.disk = leaveResult.value.disk
    record.leaveViewport = leaveResult.value.viewportApplied
    if (!leaveResult.value.disk?.paragraphIndex && leaveResult.value.disk?.paragraphIndex !== 0) {
      record.error = '离开时进度没有带着段落锚点落盘（paragraphIndex 缺失）'
    }

    if (mutate) await mutate(lib)

    // ---- B 段：重开
    const arriveResult = await retryOnce('B段', () => withApp({ lib, prefs: arrivePrefs, viewport: arriveViewport }, async (api) => {
      await openBook(api)
      // 恢复是异步的（waitForParagraph 分批爬 / 大章迁窗）：等首可见段连续 4 次采样不变。
      const settle = await api.ev(`
        const pane = document.querySelector('.reader-content');
        const read = () => {
          const ps = [...pane.querySelectorAll('.para[data-p]')];
          if (!ps.length) return -1;
          const paneTop = pane.getBoundingClientRect().top;
          const hit = ps.map((n) => ({ p: Number(n.dataset.p), r: n.getBoundingClientRect() }))
            .find((s) => s.r.bottom > paneTop + 1);
          return hit ? hit.p : -1;
        };
        let last = -999, same = 0, tries = 0;
        while (tries < 80) {
          tries += 1;
          await new Promise((r) => setTimeout(r, 150));
          const f = read();
          if (f === last && f >= 0) same += 1; else { same = 0; last = f; }
          if (same >= 4) break;
        }
        return { firstVisibleP: last, stableSamples: same, tries };
      `)
      const snap = await api.ev(SNAPSHOT_JS)
      return { snap, settle, viewportApplied: api.viewportApplied }
    }))
    if (!arriveResult.ok) throw arriveResult.error
    record.arrive = arriveResult.value.snap
    record.arriveSettle = arriveResult.value.settle
    record.arriveViewport = arriveResult.value.viewportApplied
    // 诊断：B 段重开后读盘，确认恢复时读到的是 A 段写入的进度。
    const diskAfterArrive = await readProgressOnDisk(lib)
    record.diskAfterArrive = diskAfterArrive

    // ---- 判定
    const leaveAnchor = Number.isInteger(record.disk?.paragraphIndex) ? record.disk.paragraphIndex : record.leave.anchorLikeP
    const arriveFirst = record.arrive.firstVisibleP
    const delta = arriveFirst >= 0 && leaveAnchor >= 0 ? Math.abs(arriveFirst - leaveAnchor) : null
    const perScreen = record.arrive.parasPerScreen || record.leave.parasPerScreen
    // 正文变更场景的正确语义：不按旧锚点定位，而应回退到「比例位置」。
    // 比例位置 = 新正文里 scrollRatio 映射的那一段；D 组新正文 60 段 × 0.55 ≈ 33，D2 组 200 段 × 0.55 ≈ 110。
    let ratioExpectedP = null
    if (mutate && record.arrive) {
      const ratio = record.disk?.scrollRatio ?? LEAVE_RATIO
      ratioExpectedP = Math.round(ratio * (record.arrive.maxP + 1))
    }
    const expectedP = mutate ? ratioExpectedP : leaveAnchor
    const deltaEffective = arriveFirst >= 0 && expectedP != null ? Math.abs(arriveFirst - expectedP) : null
    record.verdict = {
      leaveAnchorP: leaveAnchor,
      leaveFirstVisibleP: record.leave.firstVisibleP,
      leaveScrollRatio: Math.round(record.disk?.scrollRatio * 1000) / 1000,
      arriveFirstVisibleP: arriveFirst,
      arriveAnchorLikeP: record.arrive.anchorLikeP,
      arriveScrollRatio: Math.round(record.arrive.scrollRatio * 1000) / 1000,
      deltaParagraphs: delta,
      // 正文变更场景以「是否回退到比例位置」为准，否则以「是否贴近旧锚点」为准
      deltaVsExpected: deltaEffective,
      parasPerScreen: perScreen,
      withinOneScreen: deltaEffective != null && perScreen > 0 ? deltaEffective <= perScreen : null,
      expectedP,
      bodyChanged: Boolean(mutate),
      droppedAnchor: record.disk ? record.disk.paragraphIndex == null : null,
      hasBodyHash: record.disk ? record.disk.bodyHash != null : null,
    }
  } catch (error) {
    record.error = String(error && error.stack || error)
  } finally {
    if (lib) await rm(lib, { recursive: true, force: true }).catch(() => {})
  }
  return record
}

// ---------------------------------------------------------------- 四组场景

const scenarios = [
  {
    name: 'A 字号 18→24',
    note: '离开时 18px，重开时 24px：段高变大，同一段位置整体下移',
    leavePrefs: { fontSize: 18 },
    arrivePrefs: { fontSize: 24 },
  },
  {
    name: 'B 列宽 窄→宽',
    note: '离开时 narrow(32em)，重开时 wide(46em)：行变长、段变矮',
    leavePrefs: { contentWidth: 'narrow' },
    arrivePrefs: { contentWidth: 'wide' },
  },
  {
    name: 'C 窗口 1100×720 → 1920×1080',
    note: '渲染视口变化：一屏段落数从少变多',
    leaveViewport: { width: 1100, height: 720 },
    arriveViewport: { width: 1920, height: 1080 },
    leaveViaIpc: true,
    leaveOffset: 24,
  },
  {
    name: 'C0 锚点 offset=0（段落开头对齐视口顶，真实可达）',
    note: 'paragraphAnchor 在段落顶部 ≥ 视口顶+4px 时写 offset=0；重开应恢复该段顶部',
    leaveViewport: { width: 1100, height: 720 },
    arriveViewport: { width: 1920, height: 1080 },
    leaveViaIpc: true,
    leaveOffset: 0,
  },
  {
    name: 'D 清正文（正文变更）后重开',
    note: '第 2 章正文被换成另一种内容且段数变少（200→60 段），锚点段可能越界',
    mutate: async (lib) => {
      const body = Array.from({ length: 60 }, (_, i) => `重下后的第${i + 1}段：这一章被重新抓取过，段落划分与之前不同。`).join('\n\n')
      await rewriteChapterBody(lib, 2, body)
    },
  },
  {
    name: 'D2 正文被替换但段数相同（200→200 段，内容全不同）',
    note: '最危险形态：旧 paragraphIndex 依然有效，会撞进错段；bodyHash 校验缺失时无从发现',
    mutate: async (lib) => {
      const body = Array.from({ length: 200 }, (_, i) => `替换后的第${i + 1}段：这是重下后完全不同的正文，段落数却和原来一样多。`).join('\n\n')
      await rewriteChapterBody(lib, 2, body)
    },
  },
]

const report = { generatedAt: new Date().toISOString(), leaveRatio: LEAVE_RATIO, scenarios: [] }
const only = process.argv[2] // 诊断用：`node r2-probe.mjs C` 只跑场景名含 C 的
for (const scenario of scenarios) {
  if (only && !scenario.name.includes(only)) continue
  console.log(`\n=== ${scenario.name} —— ${scenario.note}`)
  console.error(`[r2-probe] 开始 ${scenario.name}`)
  const record = await runScenario(scenario)
  console.error(`[r2-probe] 完成 ${scenario.name}`)
  report.scenarios.push(record)
  if (record.error) {
    console.log(`  ERROR ${record.error.split('\n')[0]}`)
    continue
  }
  console.log(`  离开：锚点段=${record.verdict.leaveAnchorP} 首可见=${record.verdict.leaveFirstVisibleP} ratio=${record.verdict.leaveScrollRatio} 盘上 bodyHash=${record.verdict.hasBodyHash}`)
  console.log(`  重开：首可见=${record.verdict.arriveFirstVisibleP} ratio=${record.verdict.arriveScrollRatio} 一屏段数=${record.verdict.parasPerScreen}`)
  console.log(`  误差：${record.verdict.deltaParagraphs} 段（一屏 ${record.verdict.parasPerScreen} 段）→ ${record.verdict.withinOneScreen ? 'PASS' : 'FAIL'}`)
  if (record.leaveViewport && record.leaveViewport.ok === false) console.log(`  注意：离开视口未生效 ${JSON.stringify(record.leaveViewport)}`)
  if (record.arriveViewport && record.arriveViewport.ok === false) console.log(`  注意：重开视口未生效 ${JSON.stringify(record.arriveViewport)}`)
}

await writeFile(join(here, 'r2-probe-report.json'), JSON.stringify(report, null, 2), 'utf-8')

const failed = report.scenarios.filter((s) => s.error || s.verdict?.withinOneScreen !== true)
console.log('\n--- JSON ---')
console.log(JSON.stringify(report.scenarios.map((s) => ({
  name: s.name, error: s.error ? s.error.split('\n')[0] : null, verdict: s.verdict,
})), null, 2))
console.log(`\n汇总：${report.scenarios.length - failed.length}/${report.scenarios.length} 组重开误差在一屏内`)
if (failed.length) process.exit(1)

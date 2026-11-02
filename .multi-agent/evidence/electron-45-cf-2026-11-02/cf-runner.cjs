// Electron 主进程侧：跑指定载体，输出结构化结果。
// 注意：Windows 上 Electron 是 GUI 进程，stdout 可能到不了父进程 —— 结果一律写文件。
//
// 用法（由 cf-probe.mjs 驱动）：
//   CF_VARIANT=A  可见 BrowserWindow（模拟用户在内置浏览里过验证）
//   CF_VARIANT=B  产品真实下载视图配置（sandbox + setVisible(false) + 负坐标 + 不挂窗口）
//   CF_VARIANT=C  同上但挂到隐藏窗口（用于区分「未挂载」与「隐藏」的影响）
const { app, BrowserWindow, WebContentsView, session } = require('electron')
const { writeFileSync, appendFileSync } = require('node:fs')
const { join } = require('node:path')

const TARGET = process.env.CF_TARGET || 'https://www.uaa001.com/'
const VARIANT = process.env.CF_VARIANT || 'A'
const OUT = join(__dirname, `cf-report-${VARIANT}.json`)
const LOG = join(__dirname, 'cf-probe.log')
const PARTITION = process.env.CF_PARTITION || 'persist:cfprobe'
const BUDGET_MS = Number(process.env.CF_BUDGET_MS || 45_000)
const POLL_MS = 1_000

const log = (msg) => {
  try { appendFileSync(LOG, `[${new Date().toISOString()}] [${VARIANT}] ${msg}\n`) } catch { /* ignore */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function linksIn(html) {
  const anchors = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
  const chapterish = anchors.filter(([, href, text]) =>
    /\/\d+\.html?$/i.test(href) || /第[一二三四五六七八九十百零\d]+章/.test(text))
  // 挑战页是近乎空白的骨架；正常内容页正文必然很长、链接很多。
  // 不同站的书目链接形态差异大（/book/123、?id=、纯 hash），所以主判据用正文长度 + 链接总数。
  return { totalAnchors: anchors.length, chapterish: chapterish.length }
}

/** 是否已放行：正文有量且链接成型。挑战页两项都会接近 0。 */
function isContentPage(snap) {
  return !!snap && snap.bodyChars >= 1000 && snap.totalAnchors >= 10
}

async function hasClearance(ses, origin) {
  const cookies = await ses.cookies.get({ url: origin })
  return cookies.some((c) => c.name === 'cf_clearance')
}

async function snapshot(wc) {
  const html = await wc.executeJavaScript('document.documentElement.outerHTML').catch(() => '')
  return {
    url: wc.getURL(),
    title: await wc.executeJavaScript('document.title').catch(() => ''),
    bodyChars: await wc.executeJavaScript('document.body?.innerText?.length ?? 0').catch(() => 0),
    ...linksIn(typeof html === 'string' ? html : ''),
  }
}

function watchEvents(wc, result) {
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    result.failLoads.push({ code, desc, url, isMainFrame })
    log(`did-fail-load code=${code} desc=${desc} url=${url} main=${isMainFrame}`)
  })
  wc.on('render-process-gone', (_e, details) => {
    result.renderGone = details
    log('render-process-gone ' + JSON.stringify(details))
  })
  wc.on('unresponsive', () => log('unresponsive'))
  wc.on('certificate-error', (_e, url, error) => log(`certificate-error ${url} ${error}`))
}

app.whenReady().then(async () => {
  log('app ready')
  const result = {
    variant: VARIANT,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    partition: PARTITION,
    target: TARGET,
    at: new Date().toISOString(),
    loadError: null,
    failLoads: [],
    renderGone: null,
    clearanceAtMs: null,
    initial: null,
    reload: null,
  }

  let win = null
  let wc = null
  try {
    if (VARIANT === 'A') {
      win = new BrowserWindow({
        show: true, width: 1200, height: 900,
        webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
      })
      wc = win.webContents
    } else {
      // B/C 都按产品下载视图配置；C 额外挂到隐藏窗口，B 不挂（与 download.ts 一致）
      win = new BrowserWindow({ show: false, width: 1280, height: 800 })
      const view = new WebContentsView({
        webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
      })
      if (VARIANT === 'C') win.contentView.addChildView(view)
      view.setVisible(false)
      view.setBounds({ x: -2400, y: -2400, width: 800, height: 600 })
      wc = view.webContents
    }

    const ses = session.fromPartition(PARTITION)
    ses.setUserAgent(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`)
    watchEvents(wc, result)

    const started = Date.now()
    try {
      await wc.loadURL(TARGET, { timeout: 60_000 })
    } catch (error) {
      result.loadError = String(error && error.message ? error.message : error)
    }
    log(`首次加载结束 错误=${result.loadError}`)
    result.initial = await snapshot(wc)

    while (Date.now() - started < BUDGET_MS) {
      if (await hasClearance(ses, TARGET).catch(() => false)) {
        result.clearanceAtMs = Date.now() - started
        break
      }
      await sleep(POLL_MS)
    }
    log(`clearanceAtMs=${result.clearanceAtMs}`)

    if (result.clearanceAtMs !== null) {
      const reloadAt = Date.now()
      try {
        await wc.loadURL(TARGET, { timeout: 60_000 })
      } catch (error) {
        result.reload = { error: String(error && error.message ? error.message : error) }
      }
      result.reload = { ...(result.reload || {}), ms: Date.now() - reloadAt, ...(await snapshot(wc)) }
      log('重载结果 ' + JSON.stringify(result.reload))
    }
  } catch (error) {
    result.fatal = String(error && error.message ? error.message : error)
    log('异常：' + result.fatal)
  }

  writeFileSync(OUT, JSON.stringify(result, null, 2))
  log('report written')
  try { win?.destroy() } catch { /* ignore */ }
  const ok = isContentPage(result.reload ?? result.initial)
  log(ok ? 'PASS' : 'FAIL')
  app.quit()
  process.exit(ok ? 0 : 1)
}).catch((error) => {
  log('顶层异常：' + (error && error.stack ? error.stack : error))
  try { writeFileSync(OUT, JSON.stringify({ fatal: String(error && error.message ? error.message : error) }, null, 2)) } catch { /* ignore */ }
  app.quit()
  process.exit(1)
})

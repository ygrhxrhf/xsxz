// 只读读数：字体面板开关状态、顶栏 visibility/高度、正文段落实际文字、settings.json 字段。
import fs from 'node:fs'
import { connect, READ_TOOLS } from './_cdp-lib.mjs'
import { pageWs } from './_ws.mjs'
export const EV = '/home/goot/cod/xs/xsxz/.multi-agent/evidence/U1.6-op-1'
export const SETTINGS = '/tmp/U1.6-op-1/userData/settings.json'
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const READ_SWITCHES = `(() => {
  const rows = [...document.querySelectorAll('.bottom-panel .control-label')]
  const pick = (label) => {
    const row = rows.find((r) => (r.textContent || '').replace(/\\s+/g, '').includes(label))
    if (!row) return { present: false }
    const sw = row.querySelector('.n-switch')
    const r = row.getBoundingClientRect()
    const cc = sw ? getComputedStyle(sw) : null
    return {
      present: true,
      label: (row.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
      switchClass: sw ? sw.className : null,
      checkedByClass: sw ? sw.classList.contains('n-switch--active') : null,
      ariaChecked: sw ? sw.getAttribute('aria-checked') : null,
      visibility: cc ? cc.visibility : null,
      rowRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    }
  }
  return {
    panelPresent: !!document.querySelector('.bottom-panel'),
    panelText: (document.querySelector('.bottom-panel')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 400),
    purge: pick('净化'),
    alwaysShow: pick('工具一直显示'),
  }
})()`

export const READ_PARAS = `(() => {
  const nodes = [...document.querySelectorAll('.reader-content .para')]
  const vh = innerHeight
  return nodes.map((n) => {
    const r = n.getBoundingClientRect()
    return {
      p: n.getAttribute('data-p'),
      text: (n.textContent || '').replace(/\\s+/g, ' ').trim(),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      inViewport: r.height > 0 && r.bottom > 0 && r.top < vh,
      display: getComputedStyle(n).display,
      visibility: getComputedStyle(n).visibility,
    }
  })
})()`

export function readSettingsFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS, 'utf-8'))
    return { path: SETTINGS, reader: raw.reader ?? null, libraryPath: raw.libraryPath ?? null, mtime: fs.statSync(SETTINGS).mtimeMs }
  } catch (e) {
    return { path: SETTINGS, error: String(e) }
  }
}

export async function stateOf(c, extra) {
  const tools = await c.evaluate(READ_TOOLS)
  const sw = await c.evaluate(READ_SWITCHES)
  const paras = await c.evaluate(READ_PARAS)
  const prefs = await c.evaluate('window.api.settings.get()')
  const s = readSettingsFile()
  return {
    at: new Date().toISOString(),
    step: extra?.step,
    toolbar: tools.error ? { error: tools.error } : {
      hiddenClass: tools.hiddenClass, ariaHidden: tools.ariaHidden, inert: tools.inert,
      visibility: tools.computed.visibility, opacity: tools.computed.opacity,
      height: tools.computed.height, rect: tools.rect, innerText: tools.innerText,
    },
    bottombarHidden: tools.bottombarHidden ?? null,
    switches: sw,
    paras,
    tailParagraphRendered: paras.some((p) => p.text.includes('请收藏本站')),
    apiReader: { hideSiteTail: prefs.reader?.hideSiteTail, hideReaderChrome: prefs.reader?.hideReaderChrome },
    file: { hideSiteTail: s.reader?.hideSiteTail, hideReaderChrome: s.reader?.hideReaderChrome, path: s.path, error: s.error, mtime: s.mtime },
    extra: extra ?? null,
  }
}
export { connect, pageWs }

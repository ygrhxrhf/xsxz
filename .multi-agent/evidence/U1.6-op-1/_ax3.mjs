// 只读 AX 摘录（带开关归属）：按 DOM 顺序把无名 switch 与它所在行文字对齐，再取 AX checked。
import fs from 'node:fs'
import { connect, pageWs, sleep } from './_readers.mjs'
const c = await connect(await pageWs())
const domOrder = await c.evaluate(`(() => [...document.querySelectorAll('.bottom-panel .n-switch')].map((s) => {
  const row = s.closest('.control-label')
  return { label: (row?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30), domChecked: s.getAttribute('aria-checked'),
    className: s.className, rect: (() => { const r = s.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })() }
}))()`)
const nodes = await c.ax()
const axSwitches = nodes.filter((n) => n.role?.value === 'switch').map((n) => ({
  checked: (n.properties || []).find((p) => p.name === 'checked')?.value?.value,
  ignored: n.ignored,
}))
const merged = domOrder.map((d, i) => ({ ...d, axChecked: axSwitches[i]?.checked, axIgnored: axSwitches[i]?.ignored }))
const out = { at: new Date().toISOString(), note: 'CDP AX 树里 n-switch 无 accessible name，按 DOM 顺序与行文字对齐', switches: merged }
fs.writeFileSync('_ax-panel.json', JSON.stringify(out, null, 2))
fs.writeFileSync('_ax-panel.txt', merged.map((m) => `switch\t${m.label}\tdomChecked=${m.domChecked}\taxChecked=${m.axChecked}\tclass=${m.className}`).join('\n') + '\n')
console.log(JSON.stringify(merged, null, 2))
c.close()

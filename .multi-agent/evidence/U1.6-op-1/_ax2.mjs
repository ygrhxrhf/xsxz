// 只读 AX 摘录：唤出工具层 + 字体面板后，抓开关与顶栏控件的可访问性节点。
import fs from 'node:fs'
import { connect, pageWs, sleep } from './_readers.mjs'
const c = await connect(await pageWs())
const CENTER = { x: 666, y: 386 }
const barHidden = () => c.evaluate(`document.querySelector('.reader-toolbar')?.classList.contains('reader-tools-hidden') === true`)
if (await barHidden()) { await c.click(CENTER.x, CENTER.y); await sleep(900) }
if (!(await c.evaluate(`!!document.querySelector('.bottom-panel')`))) { await c.click(1225, 455); await sleep(900) }
const nodes = await c.ax()
const rows = []
for (const n of nodes) {
  const role = n.role?.value, name = n.name?.value || ''
  const props = Object.fromEntries((n.properties || []).map((p) => [p.name, p.value?.value]))
  if (role === 'switch' || ['书架', '搜索', '标记', '朗读', 'AI', '设置', '浏览', '字体', '目录', '进度', '背景'].includes(name)) {
    rows.push({ role, name, checked: props.checked, ignored: n.ignored })
  }
}
fs.writeFileSync('/home/goot/cod/xs/xsxz/.multi-agent/evidence/U1.6-op-1/_ax-panel.json', JSON.stringify(rows, null, 2))
fs.writeFileSync('/home/goot/cod/xs/xsxz/.multi-agent/evidence/U1.6-op-1/_ax-panel.txt',
  rows.map((r) => `${r.role}\t${r.name || '(无名)'}\tchecked=${r.checked ?? '-'}\tignored=${r.ignored}`).join('\n') + '\n')
await c.shot('/home/goot/cod/xs/xsxz/.multi-agent/evidence/U1.6-op-1/_t11-ax-panel.png')
console.log(JSON.stringify(rows, null, 2))
c.close()

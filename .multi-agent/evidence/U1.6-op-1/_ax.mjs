// 只读 AX 摘录：字体面板两个开关与顶栏节点（CDP Accessibility 树）。
import fs from 'node:fs'
import { connect, pageWs, sleep } from './_readers.mjs'
const c = await connect(await pageWs())
const nodes = await c.ax()
const flat = nodes.filter((n) => n.role?.value !== 'generic' || n.name?.value)
const pick = flat.filter((n) => {
  const name = n.name?.value || ''
  return ['净化', '工具一直显示', '本章显示原文', '字体', '书架', '搜索'].includes(name) ||
    (n.role?.value === 'switch') || (n.role?.value === 'toolbar')
})
const out = pick.map((n) => ({ role: n.role?.value, name: n.name?.value, checked: n.properties?.find((p) => p.name === 'checked')?.value?.value, ignored: n.ignored }))
fs.writeFileSync('/home/goot/cod/xs/xsxz/.multi-agent/evidence/U1.6-op-1/_ax.json', JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
c.close()

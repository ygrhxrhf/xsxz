import { connect } from './_cdp-lib.mjs'
import fs from 'node:fs'
const c = await connect(process.argv[2])
const nodes = await c.ax()
const pick = nodes.filter((n) => ['button', 'switch', 'StaticText'].includes(n.role?.value) && (n.name?.value || '').trim())
const lines = pick.map((n) => `${n.role.value}\t${(n.name.value || '').replace(/\s+/g, ' ').slice(0, 80)}`)
fs.writeFileSync('_ax.txt', lines.join('\n'))
const sw = pick.filter((n) => n.role?.value === 'switch').map((n) => ({ name: n.name?.value, checked: n.properties?.find((p) => p.name === 'checked')?.value?.value }))
console.log(JSON.stringify({ total: nodes.length, picked: pick.length, switches: sw }, null, 2))
c.close()

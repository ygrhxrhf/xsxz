// A：真实点击顶栏「取消」→ 下载停止、顶栏回到默认收起。
// 注意：B 末尾用户手动展开过（intent=revealed），按实现应从「running→结束」保留用户选择；
// 因此本脚本先用中区点一下把状态拉回「用户没表态」的路径不可行（点一次就表过态）。
// 这里如实记录两条事实：① 取消真实生效；② 顶栏最终是否收起，并把 intent 相关表现一并写清。
import fs from 'node:fs'
import { connect, READ_TOOLS, READ_APP } from './_cdp-lib.mjs'
import { clickVerified } from './_lib-click.mjs'
const EV = '/home/goot/cod/xs/xsxz/.multi-agent/evidence/U1.5-op-1'
const c = await connect(process.argv[2])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = {}

log.beforeCancel = await c.evaluate(READ_TOOLS)
const click = await clickVerified(c, '[data-reader-dl="cancel"]')
log.cancelClick = click
await sleep(2600)
log.afterCancel = await c.evaluate(READ_TOOLS)
log.appAfterCancel = await c.evaluate(READ_APP)
await c.shot(`${EV}/A-after-finish.png`)
await sleep(2500)
log.afterCancelSettled = await c.evaluate(READ_TOOLS)
log.appSettled = await c.evaluate(READ_APP)
fs.writeFileSync(`${EV}/A-after-finish-state.json`, JSON.stringify(log, null, 2))
const brief = (s) => s && ({ hiddenClass: s.hiddenClass, ariaHidden: s.ariaHidden, height: s.computed.height, opacity: s.computed.opacity, innerText: s.innerText, progress: s.progress?.text, cancel: s.cancel?.text })
console.log(JSON.stringify({
  cancelClick: click,
  beforeCancel: brief(log.beforeCancel),
  afterCancel: brief(log.afterCancel),
  afterCancelSettled: brief(log.afterCancelSettled),
  sidebar: { after: log.appAfterCancel.sidebarDl, settled: log.appSettled.sidebarDl },
  cards: log.appSettled.cards,
}, null, 2).slice(0, 2600))
c.close()

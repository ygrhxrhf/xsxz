// 收尾前最后一次只读确认：当前页面仍是这一刀的产物，且顶栏处于收起。
import { connect, READ_TOOLS } from './_cdp-lib.mjs'
const c = await connect(process.argv[2])
const s = await c.evaluate(READ_TOOLS)
const url = await c.evaluate('location.href')
console.log(JSON.stringify({ url, hiddenClass: s?.hiddenClass, height: s?.computed?.height, innerText: s?.innerText }, null, 2))
c.close()

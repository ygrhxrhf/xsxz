// 窗口佐证：CDP 截图与 X11 抓屏同一时刻，证明 CDP 画面就是这块真实窗口。
import { connect } from './_cdp-lib.mjs'
const c = await connect(process.argv[2])
const r = await c.evaluate(`({ chapter: document.querySelector('.ch-title')?.textContent.trim() ?? null, barHidden: document.querySelector('.reader-bottombar')?.classList.contains('reader-tools-hidden') === true })`)
await c.shot(process.argv[3])
console.log(JSON.stringify(r))
c.close()

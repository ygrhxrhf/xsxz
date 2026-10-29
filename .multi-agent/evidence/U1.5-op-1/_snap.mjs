import { connect, READ_TOOLS, READ_APP } from './_cdp-lib.mjs'
const c = await connect(process.argv[2])
const out = { app: await c.evaluate(READ_APP) }
if (out.app.hasReaderToolbar) out.tools = await c.evaluate(READ_TOOLS)
out.overlay = await c.evaluate(`({ masks: document.querySelectorAll('.n-drawer-mask, .n-modal-mask').length, drawers: [...document.querySelectorAll('.n-drawer-header__main')].map(x=>x.textContent.trim()) })`)
console.log(JSON.stringify(out, null, 2).slice(0, 3200))
c.close()

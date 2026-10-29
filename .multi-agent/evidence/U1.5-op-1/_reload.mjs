import { connect } from './_cdp-lib.mjs'
const c = await connect(process.argv[2])
await c.send('Page.enable')
await c.send('Page.reload', { ignoreCache: true })
console.log('reloaded')
c.close()

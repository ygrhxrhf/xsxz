import fs from 'node:fs'
import { connect, READ_APP } from './_cdp-lib.mjs'
import { pageWs } from './_ws.mjs'
const EV = '/home/goot/cod/xs/xsxz/.multi-agent/evidence/U1.6-op-1'
const c = await connect(await pageWs())
const out = { app: await c.evaluate(READ_APP), settings: await c.evaluate('window.api.settings.get()') }
await c.shot(`${EV}/_t00-boot.png`)
fs.writeFileSync(`${EV}/_probe0.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify({ nav: out.app.nav, cards: out.app.cards, reader: out.app.hasReaderToolbar,
  readerPrefs: out.settings.reader, libraryPath: out.settings.libraryPath, body: out.app.bodyHead }, null, 2))
c.close()

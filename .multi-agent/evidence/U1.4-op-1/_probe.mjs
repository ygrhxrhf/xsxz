import { connect } from './_cdp-lib.mjs'
const c = await connect(process.argv[2])
const info = await c.evaluate(`({ url: location.href, title: document.title, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, body: (document.body.innerText||'').slice(0,400), navs: [...document.querySelectorAll('.nav-btn')].map(b=>b.textContent.trim()) })`)
console.log(JSON.stringify(info, null, 2))
const ua = await c.send('Browser.getVersion')
console.log(JSON.stringify(ua))
c.close()

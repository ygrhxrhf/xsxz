import crypto from 'node:crypto'
import fs from 'node:fs'
const FILES = [
  '/tmp/U1.4-op-1/userData/settings.json',
  '/tmp/U1.4-op-1/library/index.json',
  '/tmp/U1.4-op-1/library/sample_u14/book.json',
  '/tmp/U1.4-op-1/library/sample_u14/chapters/0001.json',
  '/tmp/U1.4-op-1/library/sample_u14/chapters/0002.json',
  '/tmp/U1.4-op-1/library/sample_u14/reading-frontier.json',
]
const out = { tag: process.argv[2] || 'end', at: new Date().toISOString(), files: {} }
for (const f of FILES) {
  const buf = fs.readFileSync(f)
  const st = fs.statSync(f)
  out.files[f] = { sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length, mtimeMs: st.mtimeMs }
}
fs.writeFileSync(`_hash-${out.tag}.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify(Object.fromEntries(Object.entries(out.files).map(([k, v]) => [k.replace('/tmp/U1.4-op-1/', ''), v.sha256.slice(0, 16)])), null, 2))

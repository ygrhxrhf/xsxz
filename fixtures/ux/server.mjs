// 静态 fixture 服务：5180 UTF-8+charset / 5181 UTF-8 无 charset / 5182 GBK+charset
// 站点目录默认取 fixtures/ux/site-root，也可以用第一个参数指定。
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(HERE, 'site-root')

const PORTS = [
  [5180, path.join(ROOT, 'site'), 'text/html; charset=utf-8'],
  [5181, path.join(ROOT, 'site-nocharset'), 'text/html'],
  [5182, path.join(ROOT, 'site-gbk'), 'text/html; charset=gbk'],
]

for (const [port, dir, ct] of PORTS) {
  http
    .createServer(async (req, res) => {
      const p = req.url.split('?')[0]
      const file = path.join(dir, p === '/' ? '/index.html' : p)
      try {
        const data = await readFile(file)
        res.writeHead(200, { 'content-type': ct })
        res.end(data)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
      }
    })
    .listen(port, '127.0.0.1', () => console.log('serving', dir, 'on', port))
}

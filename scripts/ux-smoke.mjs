// 一键起本地夹具：生成三种编码站点 + 静态服务 + 假 AI 服务，并打印手工验证清单。
// 用法：node scripts/ux-smoke.mjs
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const ux = join(root, 'fixtures', 'ux')

await new Promise((resolve, reject) => {
  const run = spawn(process.execPath, [join(ux, 'mksite.mjs')], { stdio: 'inherit' })
  run.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`mksite 退出码 ${code}`))))
})

const children = [
  spawn(process.execPath, [join(ux, 'server.mjs')], { stdio: 'inherit' }),
  spawn(process.execPath, [join(ux, 'mock-ai.mjs')], { stdio: 'inherit' }),
]
const stop = () => { for (const child of children) child.kill('SIGTERM') }
process.on('SIGINT', () => { stop(); process.exit(0) })
process.on('SIGTERM', () => { stop(); process.exit(0) })

console.log(`
夹具已就绪：
  规范站    http://127.0.0.1:5180/index.html   UTF-8 + charset
  老站      http://127.0.0.1:5181/index.html   UTF-8 无 charset
  GBK 站    http://127.0.0.1:5182/index.html   GBK + charset=gbk
  假 AI     http://127.0.0.1:18080/v1         配合任意密钥

手工验证清单（每条都能只用界面走完）：
  1. 浏览页打开 5180 目录 → 下载本书 → 书库出现新书
  2. 5181 / 5182 各下载一次：三本站的章节标题与正文应完全一致（编码要被正确识别）
  3. 导入 fixtures/ux/crlf-novel.txt 与 lf-novel.txt：两份正文与分段一致，不出现整章挤成一段
  4. 阅读器：目录、翻章、Home/End 到底、返回书库（左上书脊）、目录点当前章不跳走
  5. 读到章末再翻下一章 → AI 追剧把本章入队；本章不足一屏时翻章同样入队
  6. 设置页把接口地址填成 http://127.0.0.1:18080/v1 → AI 面板能出结果；未填时面板显示「去设置」
  7. 设置页 OCR 状态：本机装没装 tesseract.js 都要有明确一行说明
  8. 删除一本书 → 回收站显示占用大小；还原后书回到书库
`)

// 端到端验「启动时书库目录不可用」这条路（验收报告 F1）。
//
// 为什么需要它：这条链路的最后一公里要真的弹原生窗、点按钮，没有 GUI 自动化就跑不到。
// 做法：用独立的 --user-data-dir 起一个真实的 Electron 主进程，把 settings.json 里的
// libraryPath 指到一个不存在的盘，再用 SPBF_STARTUP_DIALOG_SCRIPT 把弹窗脚本化成
// 「点『选择新目录…』→ 选一个可用目录」，然后核对应用是否真的换了目录并继续启动。
//
// 用法：npm run build 之后 `node scripts/startup-fallback-e2e.mjs`
// 注意：会在桌面上真开一个应用窗口（约十秒），结束后自动关掉。
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const BAD_PATH = 'Q:\\spbf\\no-such-drive\\library' // 本机没有 Q 盘
const PORT = 20000 + Math.floor(Math.random() * 20000)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const passed = []
const failed = []
const check = (label, ok, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`
  ;(ok ? passed : failed).push(line)
  console.log(line)
}

const userData = await mkdtemp(join(tmpdir(), 'spbf-e2e-userdata-'))
const libParent = await mkdtemp(join(tmpdir(), 'spbf-e2e-newlib-'))
const goodDir = join(libParent, 'library')
const logPath = join(userData, 'dialog-log.jsonl')
const settingsPath = join(userData, 'settings.json')

await writeFile(settingsPath, JSON.stringify({ libraryPath: BAD_PATH }, null, 2))
console.log(`夹具：userData=${userData}`)
console.log(`      坏路径=${BAD_PATH}`)
console.log(`      将切换到=${goodDir}`)

const child = spawn(electronPath, [root, `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], {
  env: {
    ...process.env,
    SPBF_STARTUP_DIALOG_SCRIPT: JSON.stringify({ messageBox: [0], openDialog: [goodDir], log: logPath }),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += String(chunk) })
child.stderr.on('data', (chunk) => { stderr += String(chunk) })

const killTree = () => {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGTERM')
  } catch {
    /* 已经退出了 */
  }
}

try {
  // 1) 等它自己把书库路径改到我们脚本里选的目录
  const deadline = Date.now() + 60_000
  let switched = false
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break
    try {
      const parsed = JSON.parse(await readFile(settingsPath, 'utf-8'))
      if (parsed.libraryPath === goodDir) { switched = true; break }
    } catch {
      /* settings.json 还没写出来 */
    }
    await sleep(300)
  }
  check('启动兜底把书库路径改成了用户脚本里选的目录', switched, switched ? '' : `进程退出码 ${child.exitCode ?? '(仍在跑)'}`)
  if (!switched) throw new Error('没等到切换，后面的断言没有意义')

  // 2) 给它一点时间跑完剩余启动步骤（开窗口）
  await sleep(4000)

  const settings = JSON.parse(await readFile(settingsPath, 'utf-8'))
  check('落盘的 libraryPath 与所选目录一致', settings.libraryPath === goodDir, settings.libraryPath)
  check('新书库目录已就绪（书库目录与 __tmp__ 都已建）', existsSync(goodDir) && existsSync(join(goodDir, '__tmp__')))
  check('进程没有静默退出（窗口进程仍在）', child.exitCode === null, child.exitCode === null ? `pid ${child.pid}` : `退出码 ${child.exitCode}`)

  // 3) 弹窗文案：这条是「用户看到什么」的证据
  const entries = (await readFile(logPath, 'utf-8'))
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
  const box = entries.find((entry) => entry.kind === 'messageBox')
  const picker = entries.find((entry) => entry.kind === 'openDialog')
  check('弹出了「应用没能启动」的说明弹窗', box?.title === '小说浏览器无法启动' && box?.message === '书库目录不可用，应用没能启动。', box?.message)
  check('弹窗 detail 带当前路径、真实原因与自救指引', typeof box?.detail === 'string' && box.detail.includes(BAD_PATH) && box.detail.includes('ENOENT') && box.detail.includes('也可以先退出'), box?.detail?.split('\n')[3])
  check('弹窗按钮是「选择新目录…/退出」', Array.isArray(box?.buttons) && box.buttons.join('/') === '选择新目录…/退出', box?.buttons?.join('/'))
  check('目录选择框标题为「选择书库目录」', picker?.title === '选择书库目录', picker?.title)

  // 4) 真的开了窗口：不用 GUI 自动化，问 Chromium 调试端点要 page target
  let targets = null
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    targets = await response.json()
  } catch (error) {
    check('能连上 Chromium 调试端点', false, String(error))
  }
  const page = Array.isArray(targets) ? targets.find((target) => target.type === 'page') : undefined
  check('恢复后确实开了应用窗口（调试端点里有 page target）', Boolean(page), page?.url)
} catch (error) {
  check('E2E 跑到收尾', false, error instanceof Error ? error.message : String(error))
} finally {
  killTree()
  await rm(userData, { recursive: true, force: true }).catch(() => {})
  await rm(libParent, { recursive: true, force: true }).catch(() => {})
}

if (stdout.trim() || stderr.trim()) {
  console.log('\n--- 应用输出（Windows GUI 进程可能不往父进程 stdout 写，仅供参考）---')
  if (stdout.trim()) console.log(stdout.trim().split('\n').slice(-12).join('\n'))
  if (stderr.trim()) console.log(stderr.trim().split('\n').slice(-12).join('\n'))
}

console.log(`\n结果：${passed.length} 项通过，${failed.length} 项失败`)
if (failed.length) {
  console.log(failed.join('\n'))
  process.exit(1)
}
console.log('F1 启动兜底端到端通过：坏路径 → 弹窗说明 → 换成可用目录 → 应用继续启动并开窗口')

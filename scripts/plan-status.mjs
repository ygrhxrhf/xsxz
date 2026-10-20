// 收尾自检：计划项是否真的做完 + 工作区是否干净。
//
// 用法：
//   npm run plan:status            # 只把未提交的已跟踪文件算失败
//   npm run plan:status -- --strict # 未跟踪文件也算失败
//
// 为什么存在：模型经常在 turn 边界停下，而「完成」不能靠自述。
// 判据只有两条：计划里的勾都有命令证据、工作区没有半成品改动。
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const planDir = join(root, '.multi-agent', 'plan')
const strict = process.argv.includes('--strict')

let problems = 0

if (existsSync(planDir)) {
  const files = readdirSync(planDir).filter((name) => name.endsWith('.md') && name.toUpperCase() !== 'TEMPLATE.MD')
  if (files.length === 0) console.log('plan 目录里还没有实际计划（只有模板）')
  for (const file of files) {
    const text = readFileSync(join(planDir, file), 'utf8')
    const open = text.split(/\r?\n/).filter((line) => /^\s*[-*] \[ \]/.test(line))
    if (open.length > 0) {
      problems += open.length
      console.log(`未完成 ${open.length} 项：.multi-agent/plan/${file}`)
      for (const line of open) console.log(`  ${line.trim()}`)
    } else {
      console.log(`完成：.multi-agent/plan/${file}`)
    }
  }
} else {
  console.log('没有 .multi-agent/plan/ 目录')
}

const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
const lines = status === '' ? [] : status.split(/\r?\n/)
const tracked = lines.filter((line) => !line.startsWith('??'))
const untracked = lines.filter((line) => line.startsWith('??'))

if (tracked.length > 0) {
  problems += tracked.length
  console.log(`工作区有未提交改动 ${tracked.length} 个：`)
  for (const line of tracked) console.log(`  ${line}`)
}
if (untracked.length > 0) {
  console.log(`未跟踪文件 ${untracked.length} 个${strict ? '' : '（加 --strict 才算失败）'}：`)
  for (const line of untracked) console.log(`  ${line}`)
  if (strict) problems += untracked.length
}

if (problems === 0) {
  console.log('\n可以收工：计划项都有证据，工作区干净')
  process.exit(0)
}
console.log(`\n还不能收工：${problems} 项待处理`)
process.exit(1)

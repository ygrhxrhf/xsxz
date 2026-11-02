// 驱动 cf-runner.cjs，按变体逐个起 Electron（每次独立进程，避免状态互相污染）。
//
// 用法：
//   node .multi-agent/evidence/electron-45-cf-2026-11-02/cf-probe.mjs
//   CF_VARIANTS=A,B,C node ...   （默认 A,B,C）
//   CF_TARGET=https://... node ... （默认 uaa001）
//
// 结果：每个变体写 cf-report-<变体>.json，过程写 cf-probe.log。
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const require = createRequire(join(repoRoot, 'package.json'))
const electronPath = require('electron')

const TARGET = process.env.CF_TARGET || 'https://www.uaa001.com/'
const VARIANTS = (process.env.CF_VARIANTS || 'A,B,C').split(',').map((s) => s.trim()).filter(Boolean)
const RUNNER = join(here, 'cf-runner.cjs')

// 清掉上一轮结果，避免拿旧文件当本轮结论
const stale = readdirSync(here).filter((f) => /^cf-report-.*\.json$/.test(f))
for (const f of stale) rmSync(join(here, f))

function runVariant(variant) {
  return new Promise((resolve) => {
    const child = spawn(electronPath, [RUNNER], {
      stdio: 'ignore',
      env: { ...process.env, CF_TARGET: TARGET, CF_VARIANT: variant },
    })
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, 180_000)
    child.on('exit', (code) => { clearTimeout(timer); resolve(code ?? -1) })
    child.on('error', () => { clearTimeout(timer); resolve(-1) })
  })
}

const results = []
for (const variant of VARIANTS) {
  const exit = await runVariant(variant)
  const file = join(here, `cf-report-${variant}.json`)
  let report = null
  try { report = JSON.parse(readFileSync(file, 'utf-8')) } catch { report = { variant, missing: true } }
  results.push({ variant, exit, ...report })
  console.log(`[${variant}] exit=${exit} clearance=${report.clearanceAtMs ?? 'n/a'}ms ` +
    `reload.chapterish=${report.reload?.chapterish ?? 'n/a'} ` +
    `fallback.to.42=${process.env.CF_ELECTRON42 ? 'n/a' : ''}`.trim())
}

const summary = {
  at: new Date().toISOString(),
  electron: results[0]?.electron,
  chrome: results[0]?.chrome,
  target: TARGET,
  variants: results,
}
const { writeFileSync } = await import('node:fs')
writeFileSync(join(here, 'cf-summary.json'), JSON.stringify(summary, null, 2))
console.log('\n=== SUMMARY ===')
console.log(JSON.stringify(summary, null, 2))

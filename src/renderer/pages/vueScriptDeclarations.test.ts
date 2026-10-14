import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 渲染层守卫：`npm run typecheck` 的 tsc 不解析 .vue，脚本里的拼写错误
 * （例如漏声明 `readingRestoring` 却直接赋值）在运行期才会炸成
 * “Uncaught ReferenceError”。这里做一次低成本静态核对：
 * 每个形如 `  name = ` 的顶层赋值，都必须在同一文件里有 const/let/var 声明。
 */

const RENDERER_DIR = join(process.cwd(), 'src', 'renderer')

function vueFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...vueFiles(full))
    else if (entry.endsWith('.vue')) out.push(full)
  }
  return out
}

function scriptSetup(source: string): string | null {
  const match = /<script setup[^>]*>([\s\S]*?)<\/script>/.exec(source)
  return match ? match[1] : null
}

/** 顶层赋值：两空格缩进的 `name = `，排除属性写入（`a.b = `）、比较与类型标注。 */
function assignedNames(script: string): string[] {
  const names = new Set<string>()
  const pattern = /^ {2}([A-Za-z_$][\w$]*) = (?!=)/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(script))) names.add(match[1])
  return [...names]
}

function isDeclared(script: string, name: string): boolean {
  const declaration = new RegExp(`^\\s*(?:const|let|var)\\s+${name}\\b`, 'm')
  if (declaration.test(script)) return true
  // 解构声明或 `for (const x of ...)`
  const destructured = new RegExp(`(?:const|let|var)\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`, 'm')
  return destructured.test(script)
}

describe('renderer .vue 脚本声明完整性', () => {
  const files = vueFiles(RENDERER_DIR)

  it('至少扫描到主要页面', () => {
    expect(files.length).toBeGreaterThanOrEqual(5)
  })

  it('每个顶层赋值都有对应声明', () => {
    const problems: string[] = []
    for (const file of files) {
      const script = scriptSetup(readFileSync(file, 'utf-8'))
      if (!script) continue
      for (const name of assignedNames(script)) {
        if (!isDeclared(script, name)) {
          problems.push(`${file.replace(`${process.cwd()}/`, '')}: ${name} 赋值了但没有声明`)
        }
      }
    }
    expect(problems).toEqual([])
  })
})

import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

/**
 * AI 表面必须真的被阅读流程调用。
 * 这一条是「AI 不能成为摆设」的可执行版本：白名单里留一个界面从不按的按钮，
 * 比少一个功能更容易让人以为功能坏了。
 */

const AI_GROUP_OPEN = /^  ai: \{$/m
const GROUP_CLOSE = /^  \},$/m

function aiPreloadKeys(source: string): string[] {
  const opened = AI_GROUP_OPEN.exec(source)
  expect(opened, 'preload 里找不到 ai 分组').not.toBeNull()
  const body = source.slice(opened!.index + opened![0].length)
  const closed = GROUP_CLOSE.exec(body)
  expect(closed, 'preload ai 分组没有闭合').not.toBeNull()
  return [...body.slice(0, closed!.index).matchAll(/^    (\w+):/gm)].map((m) => m[1]!)
}

async function rendererSources(): Promise<Map<string, string>> {
  const dir = new URL('../', import.meta.url)
  const files = (await readdir(dir, { recursive: true }))
    .filter((name) => /\.(vue|ts)$/.test(name) && !name.includes('.test.'))
    .sort()
  const entries = await Promise.all(
    files.map(async (name) => [name, await readFile(new URL(name, dir), 'utf-8')] as const),
  )
  return new Map(entries)
}

describe('AI 频道表面必须接得住真实用途', () => {
  it('preload 的每个 ai 方法都在渲染层被调用', async () => {
    const [preload, files] = await Promise.all([
      readFile(new URL('../../preload/index.ts', import.meta.url), 'utf-8'),
      rendererSources(),
    ])
    const keys = aiPreloadKeys(preload)
    // 防止解析规则被悄悄改坏后这条用例空跑通过
    expect(keys.length).toBeGreaterThanOrEqual(25)
    const unused = keys.filter((key) =>
      [...files.values()].every((source) => !source.includes(`window.api.ai.${key}`)),
    )
    expect(unused, `这些 AI 频道没有任何渲染层入口：${unused.join(', ')}`).toEqual([])
  })

  it('已下线的 AI 频道不得回到白名单', async () => {
    const preload = await readFile(new URL('../../preload/index.ts', import.meta.url), 'utf-8')
    const keys = aiPreloadKeys(preload)
    // 收敛掉的表面：非流式摘要 / 翻译 / 拒答桩 / 人物卡生成，统一走流式与记忆通道。
    for (const removed of ['summarize', 'summarizeUpTo', 'translate', 'chat', 'characterCard', 'getCharacterCard']) {
      expect(keys, `${removed} 已经下线，不该再出现在 preload`).not.toContain(removed)
    }
  })

  it('渲染层不引用未登记的 ai 频道', async () => {
    const [preload, files] = await Promise.all([
      readFile(new URL('../../preload/index.ts', import.meta.url), 'utf-8'),
      rendererSources(),
    ])
    const allowed = new Set(aiPreloadKeys(preload))
    const referenced = new Set<string>()
    for (const source of files.values()) {
      for (const match of source.matchAll(/window\.api\.ai\.([A-Za-z0-9]+)/g)) referenced.add(match[1]!)
    }
    expect([...referenced].filter((key) => !allowed.has(key)).sort()).toEqual([])
  })
})

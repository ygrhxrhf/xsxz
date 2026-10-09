import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const settingsPage = () => readFile(new URL('./Settings.vue', import.meta.url), 'utf-8')
const settingsStore = () => readFile(new URL('../../main/settings.ts', import.meta.url), 'utf-8')

/**
 * 追剧的两个设置项是「花钱开关」，最容易出的事故是界面加了控件但保存时漏了键，
 * 或 normalizeAiPrefs 白名单没补齐——两种都会把用户的开启静默清成关闭。
 */
describe('自动追剧设置的往返', () => {
  it('设置页读取、保存并显示自动追剧总开关与单次章数上限', async () => {
    const source = await settingsPage()
    expect(source).toContain('autoReadingFollow.value = ai.autoReadingFollow')
    expect(source).toContain('followMaxChaptersPerRun.value = ai.followMaxChaptersPerRun')
    expect(source).toContain('autoReadingFollow: autoReadingFollow.value')
    expect(source).toContain('followMaxChaptersPerRun: followMaxChaptersPerRun.value')
    expect(source).toContain('v-model:value="autoReadingFollow"')
    expect(source).toContain('v-model:value="followMaxChaptersPerRun"')
  })

  it('主进程白名单接受这两个键，上限夹在 1..50', async () => {
    const source = await settingsStore()
    expect(source).toContain('autoReadingFollow: ai.autoReadingFollow === true')
    expect(source).toContain('followMaxChaptersPerRun')
    expect(source).toContain('Math.max(1, Math.min(50, ai.followMaxChaptersPerRun))')
  })
})

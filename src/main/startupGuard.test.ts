import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessageBoxOptions, OpenDialogOptions } from 'electron'
import { LIBRARY_PATH_UNAVAILABLE_DETAIL, ensureLibraryPathAtStartup, scriptedStartupDialogs } from './startupGuard'
import type { StartupGuardDeps } from './startupGuard'

const INITIAL = 'D:\\spbf\\library'

interface DepsInit {
  /** 依次返回的目录选择结果；`null` 表示用户取消。取完最后一个就一直用它。 */
  picks?: Array<string | null>
  /** 依次返回的弹窗按钮下标；默认 `[1]`（退出）。取完最后一个就一直用它。 */
  responses?: number[]
  getSettings?: StartupGuardDeps['getSettings']
  setLibraryPath?: StartupGuardDeps['setLibraryPath']
}

/** 依赖桩：记录每次弹窗 / 选目录 / 写设置，并按脚本给出用户的选择。 */
function makeDeps(init: DepsInit = {}) {
  const picks = init.picks ?? []
  const responses = init.responses ?? [1]
  const messageBoxes: MessageBoxOptions[] = []
  const openDialogs: OpenDialogOptions[] = []
  const updates: Array<{ libraryPath: string }> = []
  const switched: string[] = []
  const unavailable: unknown[] = []
  let pickIndex = 0
  let responseIndex = 0
  const deps: StartupGuardDeps = {
    getSettings: init.getSettings ?? (async () => ({ libraryPath: INITIAL })),
    setLibraryPath: init.setLibraryPath ?? (async () => {}),
    updateSettings: async (update) => {
      updates.push(update)
      return {}
    },
    showMessageBox: async (options) => {
      messageBoxes.push(options)
      const response = responses[Math.min(responseIndex++, responses.length - 1)] ?? 1
      return { response }
    },
    showOpenDialog: async (options) => {
      openDialogs.push(options)
      const pick = picks[Math.min(pickIndex++, picks.length - 1)]
      return { filePaths: pick ? [pick] : [] }
    },
    onPathSwitched: (path) => switched.push(path),
    onUnavailable: (error) => unavailable.push(error),
  }
  return { deps, messageBoxes, openDialogs, updates, switched, unavailable }
}

/** 只有列出的路径可用，其余一律当成盘不存在。 */
function setLibraryPathAllowingOnly(...allowed: string[]) {
  return async (path: string) => {
    if (!allowed.includes(path)) throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`)
  }
}

describe('ensureLibraryPathAtStartup', () => {
  it('书库目录可用时直接放行，不打扰用户', async () => {
    const { deps, messageBoxes, openDialogs } = makeDeps()
    const result = await ensureLibraryPathAtStartup(deps)
    expect(result).toEqual({ ok: true })
    expect(messageBoxes).toHaveLength(0)
    expect(openDialogs).toHaveLength(0)
  })

  it('盘不存在时弹窗说明原因，并让用户当场换成可用目录', async () => {
    const { deps, messageBoxes, openDialogs, updates, switched, unavailable } = makeDeps({
      picks: ['E:\\books'],
      responses: [0],
      setLibraryPath: setLibraryPathAllowingOnly('E:\\books'),
    })

    const result = await ensureLibraryPathAtStartup(deps)

    expect(result).toEqual({ ok: true, libraryPath: 'E:\\books' })
    expect(messageBoxes).toHaveLength(1)
    // 文案与弹窗选项锁定：改坏了这几条断言会红。
    expect(messageBoxes[0].type).toBe('error')
    expect(messageBoxes[0].title).toBe('小说浏览器无法启动')
    expect(messageBoxes[0].message).toBe('书库目录不可用，应用没能启动。')
    expect(messageBoxes[0].detail).toContain(`当前书库目录：${INITIAL}`)
    expect(messageBoxes[0].detail).toContain("mkdir 'D:\\spbf\\library'")
    expect(messageBoxes[0].detail).toContain('也可以先退出')
    expect(messageBoxes[0].buttons).toEqual(['选择新目录…', '退出'])
    expect(messageBoxes[0].defaultId).toBe(0)
    expect(messageBoxes[0].cancelId).toBe(1)
    expect(messageBoxes[0].noLink).toBe(true)
    expect(openDialogs[0]).toEqual({ title: '选择书库目录', properties: ['openDirectory', 'createDirectory'] })
    expect(updates).toEqual([{ libraryPath: 'E:\\books' }])
    expect(switched).toEqual(['E:\\books'])
    expect(String(unavailable[0])).toContain("mkdir 'D:\\spbf\\library'")
  })

  it('用户选择退出时返回失败，并给出自己能怎么修', async () => {
    const { deps, messageBoxes, updates } = makeDeps({ setLibraryPath: setLibraryPathAllowingOnly() })

    const result = await ensureLibraryPathAtStartup(deps)

    expect(result.ok).toBe(false)
    expect(result.failureDetail).toBe(LIBRARY_PATH_UNAVAILABLE_DETAIL)
    expect(result.failureDetail).toContain('%APPDATA%\\spbf\\settings.json')
    expect(messageBoxes).toHaveLength(1)
    expect(updates).toEqual([])
  })

  it('换到的目录也不可用时接着征求，直到换成一个能用的', async () => {
    const { deps, messageBoxes, updates } = makeDeps({
      picks: ['E:\\bad', 'F:\\ok'],
      responses: [0],
      setLibraryPath: setLibraryPathAllowingOnly('F:\\ok'),
    })

    const result = await ensureLibraryPathAtStartup(deps)

    expect(result).toEqual({ ok: true, libraryPath: 'F:\\ok' })
    expect(messageBoxes).toHaveLength(2)
    // 第二次弹窗要换上新路径与新原因，不能让用户对着上一次的错误发懵。
    expect(messageBoxes[1].detail).toContain('当前书库目录：E:\\bad')
    expect(messageBoxes[1].detail).toContain("mkdir 'E:\\bad'")
    expect(updates).toEqual([{ libraryPath: 'F:\\ok' }])
  })

  it('取消选择目录不算退出，继续征求', async () => {
    const { deps, messageBoxes, openDialogs } = makeDeps({
      picks: [null, 'E:\\books'],
      responses: [0],
      setLibraryPath: setLibraryPathAllowingOnly('E:\\books'),
    })

    const result = await ensureLibraryPathAtStartup(deps)

    expect(result).toEqual({ ok: true, libraryPath: 'E:\\books' })
    expect(messageBoxes).toHaveLength(2)
    expect(openDialogs).toHaveLength(2)
  })

  it('连设置都读不出来时仍弹窗说明，不静默失败', async () => {
    const { deps, messageBoxes } = makeDeps({
      getSettings: async () => {
        throw new Error('settings.json 读取失败')
      },
    })

    const result = await ensureLibraryPathAtStartup(deps)

    expect(result.ok).toBe(false)
    expect(messageBoxes).toHaveLength(1)
    expect(messageBoxes[0].detail).toContain('原因：settings.json 读取失败')
  })
})

describe('scriptedStartupDialogs（仅测试用）', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spbf-dialog-script-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('没设环境变量时返回 null，生产走真实原生弹窗', () => {
    expect(scriptedStartupDialogs({})).toBeNull()
    expect(scriptedStartupDialogs({ SPBF_STARTUP_DIALOG_SCRIPT: '   ' })).toBeNull()
  })

  it('脚本不是合法 JSON 时返回 null，不把启动流程带崩', () => {
    expect(scriptedStartupDialogs({ SPBF_STARTUP_DIALOG_SCRIPT: '{oops' })).toBeNull()
    expect(scriptedStartupDialogs({ SPBF_STARTUP_DIALOG_SCRIPT: '[]' })).not.toBeNull()
  })

  it('按次序给出按钮与目录，用尽后沿用最后一项，并把弹窗文案记进日志', async () => {
    const log = join(dir, 'dialog.jsonl')
    const dialogs = scriptedStartupDialogs({
      SPBF_STARTUP_DIALOG_SCRIPT: JSON.stringify({ messageBox: [0, 1], openDialog: [null, dir], log }),
    })
    expect(dialogs).not.toBeNull()

    const box = (title: string) => dialogs!.showMessageBox({ type: 'error', title, message: 'M', detail: 'D', buttons: ['选择新目录…', '退出'] })
    const openDialog = (title: string) => dialogs!.showOpenDialog({ title, properties: ['openDirectory', 'createDirectory'] })

    expect(await box('第一次')).toEqual({ response: 0 })
    expect(await openDialog('选目录')).toEqual({ filePaths: [] })   // 脚本里的 null = 用户取消
    expect(await box('第二次')).toEqual({ response: 1 })
    expect(await openDialog('再选')).toEqual({ filePaths: [dir] })
    expect(await box('第三次')).toEqual({ response: 1 })            // 用尽后沿用最后一项
    expect(await openDialog('又选')).toEqual({ filePaths: [dir] })

    const lines = (await readFile(log, 'utf-8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines.map((line) => line.kind)).toEqual([
      'messageBox', 'openDialog', 'messageBox', 'openDialog', 'messageBox', 'openDialog',
    ])
    expect(lines[0]).toMatchObject({ title: '第一次', detail: 'D', buttons: ['选择新目录…', '退出'], response: 0 })
    expect(lines[1]).toMatchObject({ title: '选目录', properties: ['openDirectory', 'createDirectory'], pick: null })
    expect(lines[3]).toMatchObject({ pick: dir })
  })
})

import type { MessageBoxOptions, OpenDialogOptions } from 'electron'

/**
 * 启动第一步：确认书库目录可用。盘不存在或不可写时不能静默失败——进程活着却没有窗口，
 * 用户只会以为软件坏了。这里说明原因并让用户当场换一个目录，换成就继续启动。
 *
 * 依赖全部注入，才能在不起 Electron 的前提下测这条路径；弹窗文案与选项与原实现逐字一致，
 * 由 startupGuard.test.ts 锁住。
 */
export interface StartupGuardDeps {
  getSettings: () => Promise<{ libraryPath: string }>
  setLibraryPath: (path: string) => Promise<void>
  updateSettings: (update: { libraryPath: string }) => Promise<unknown>
  showMessageBox: (options: MessageBoxOptions) => Promise<{ response: number }>
  showOpenDialog: (options: OpenDialogOptions) => Promise<{ filePaths: string[] }>
  /** 用户换成的目录可用时调用。 */
  onPathSwitched?: (path: string) => void
  /** 书库目录不可用时调用，带上原始错误以便记录堆栈。 */
  onUnavailable?: (error: unknown) => void
}

export interface StartupGuardResult {
  ok: boolean
  /** ok 为 false 时给用户看的收尾说明，由调用方 showErrorBox 弹出。 */
  failureDetail?: string
  /** 用户当场换成的目录；没换目录时为 undefined。 */
  libraryPath?: string
}

/** 没换来可用目录时的收尾文案：告诉用户还能自己怎么修。 */
export const LIBRARY_PATH_UNAVAILABLE_DETAIL =
  '书库目录不可用，应用已退出。\n\n请确认磁盘可用，或手动编辑 %APPDATA%\\spbf\\settings.json 里的 libraryPath 后重新打开。'

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 反复征求用户的目录选择，直到换来一个能用的，或用户选择退出。 */
async function recoverFromLibraryPathFailure(
  deps: StartupGuardDeps,
  initialPath: string,
  cause: unknown,
): Promise<string | null> {
  let currentPath = initialPath
  let reason = describeError(cause)
  for (;;) {
    const { response } = await deps.showMessageBox({
      type: 'error',
      title: '小说浏览器无法启动',
      message: '书库目录不可用，应用没能启动。',
      detail: `当前书库目录：${currentPath}\n\n原因：${reason}\n\n请选择一个可用的目录作为书库；也可以先退出，自己创建好该目录后重新打开。`,
      buttons: ['选择新目录…', '退出'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (response !== 0) return null
    const picked = await deps.showOpenDialog({
      title: '选择书库目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    const dest = picked.filePaths?.[0]
    if (!dest) continue
    try {
      // setLibraryPath 失败会回滚到原路径，所以这里重试是安全的。
      await deps.setLibraryPath(dest)
      await deps.updateSettings({ libraryPath: dest })
      deps.onPathSwitched?.(dest)
      return dest
    } catch (error) {
      currentPath = dest
      reason = describeError(error)
    }
  }
}

export async function ensureLibraryPathAtStartup(deps: StartupGuardDeps): Promise<StartupGuardResult> {
  try {
    const settings = await deps.getSettings()
    await deps.setLibraryPath(settings.libraryPath)
    return { ok: true }
  } catch (error) {
    // 书库盘不在或不可写：不能静默失败，让用户当场换目录。
    deps.onUnavailable?.(error)
    const fallback = await deps.getSettings().catch(() => null)
    const recovered = await recoverFromLibraryPathFailure(deps, fallback?.libraryPath ?? '', error).catch(() => null)
    if (!recovered) return { ok: false, failureDetail: LIBRARY_PATH_UNAVAILABLE_DETAIL }
    return { ok: true, libraryPath: recovered }
  }
}

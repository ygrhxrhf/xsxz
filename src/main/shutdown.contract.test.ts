import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const mainSource = () => readFile(new URL('./index.ts', import.meta.url), 'utf-8')
const librarySource = () => readFile(new URL('./ipc/libraryIpc.ts', import.meta.url), 'utf-8')
const readerSource = () => readFile(new URL('../renderer/pages/Reader.vue', import.meta.url), 'utf-8')

describe('退出与启动的状态收口', () => {
  it('before-quit 停掉下载、批量检查、AI 任务和全书概览队列', async () => {
    const source = await mainSource()
    const start = source.indexOf("app.on('before-quit'")
    expect(start, '主进程没有注册 before-quit').toBeGreaterThan(-1)
    const end = source.indexOf("app.on('window-all-closed'", start)
    const block = source.slice(start, end)
    for (const call of [
      'cancelDownload()', 'cancelCheckAll()', 'aiQueue.cancelAll()', 'bookOverview.stop()',
      'aiReadingFollow.stop()', 'stopEvidenceIndex()',
    ]) {
      expect(block).toContain(call)
    }
  })

  it('读章只唤醒索引补建，不等它建完才返回正文', async () => {
    // 书库域注册已抽到 src/main/ipc/libraryIpc.ts；断言内容不变，只跟随文件位置。
    const source = await librarySource()
    const start = source.indexOf("register('library.readChapter'")
    expect(start, '书库 core 模块缺少读章注册').toBeGreaterThan(-1)
    const block = source.slice(start, source.indexOf("register('library.delete'", start))
    expect(block).toContain('wakeEvidenceIndex(bookId)')
    expect(block).not.toContain('await wakeEvidenceIndex')
    expect(block.indexOf('wakeEvidenceIndex(bookId)')).toBeLessThan(block.indexOf('return { chapter }'))
  })

  it('启动时先修复上次退出留下的 downloading 状态，再开窗口', async () => {
    const source = await mainSource()
    const ready = source.indexOf('app.whenReady()')
    const sweep = source.indexOf('await recoverInterruptedStatus()', ready)
    expect(sweep).toBeGreaterThan(source.indexOf('await setLibraryPath(settings.libraryPath)', ready))
    expect(sweep).toBeLessThan(source.indexOf('createWindow()', ready))
  })

  it('关窗口前把还在节流的阅读进度和偏好写出去', async () => {
    const source = await readerSource()
    expect(source).toContain("window.addEventListener('beforeunload', flushPendingReaderWrites)")
    expect(source).toContain("window.removeEventListener('beforeunload', flushPendingReaderWrites)")
    const body = source.slice(
      source.indexOf('function flushPendingReaderWrites'),
      source.indexOf('function restoreDefaultReaderPrefs'),
    )
    expect(body).toContain('void flushReaderPrefsSave()')
    expect(body).toContain('void readerProgress.writeNow()')
  })
})

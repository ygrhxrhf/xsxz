import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Library comfortable card contract', () => {
  it('keeps the fixed grid, generated cover, and keyboard-open structure', async () => {
    const source = await readFile(new URL('./Library.vue', import.meta.url), 'utf-8')
    expect(source).toContain('grid-template-columns: repeat(auto-fill, minmax(230px, 1fr))')
    expect(source).toContain('width: 104px')
    expect(source).toContain('height: 142px')
    expect(source).toContain('width: 6px')
    expect(source).toContain('libraryCoverText(b.title)')
    expect(source).toContain(':style="coverStyle(b.id)"')
    expect(source).toContain('class="book-open-area"')
    expect(source).toContain(':aria-label="`打开《${b.title}》`"')
    expect(source).toContain('@click="emit(\'open-book\', b.id)"')
    expect(source).not.toMatch(/<n-card[^>]*@click=/s)
  })

  it('keeps six first-load skeletons and fixed empty-state actions', async () => {
    const source = await readFile(new URL('./Library.vue', import.meta.url), 'utf-8')
    expect(source).toContain('v-if="initialLoading"')
    expect(source).toContain('v-for="index in 6"')
    expect(source).toContain('aria-label="正在加载书库"')
    expect(source).toContain('书库还是空的')
    expect(source).toContain('从网页下载一本书，或导入本地 txt / epub。')
    expect(source).toContain('去浏览找书')
    expect(source).toContain('导入本地书')
    expect(source).toContain('没有找到符合条件的书。')
    expect(source).toContain('清除筛选')
  })

  it('keeps title, author, status, progress, and running result text visible', async () => {
    const source = await readFile(new URL('./Library.vue', import.meta.url), 'utf-8')
    expect(source).toContain('class="book-title" :title="b.title"')
    expect(source).toContain('v-if="b.author" class="book-author" :title="b.author"')
    expect(source).toContain('statusLabel(b.status)')
    expect(source).toContain('class="book-progress" :title="fmtProgress(b)"')
    expect(source).toContain("return '正在检查更新…'")
    expect(source).toContain("return '正在重试失败章…'")
    expect(source).toContain("return '正在导出…'")
    expect(source).toContain('checkMsg.value[book.id] || libraryFailureLabel(book)')
    expect(source).toContain('-webkit-line-clamp: 2')
    expect(source).toContain('text-overflow: ellipsis')
  })

  it('keeps overlapping refreshes visible and rejects stale list responses', async () => {
    const source = await readFile(new URL('./Library.vue', import.meta.url), 'utf-8')
    expect(source).toContain('const refreshTracker = createLibraryRefreshTracker()')
    expect(source).toContain('const requestId = refreshTracker.begin()')
    expect(source).toContain('if (refreshTracker.isLatest(requestId)) books.value = res.books')
    expect(source).toContain('refreshTracker.end()')
    expect(source).toContain('loading.value = refreshTracker.loading')
  })

  it('preserves the existing management operations for the dependent menu slice', async () => {
    const source = await readFile(new URL('./Library.vue', import.meta.url), 'utf-8')
    for (const text of ['检查更新', '重试失败章', '失败章', '前情提要', '导出 txt', '导出 epub', '删除']) {
      expect(source).toContain(text)
    }
    expect(source).toContain('handleDelete(b.id)')
    expect(source).toContain('handleExport(b.id')
    expect(source).toContain('openFailedList(b.id, b.title)')
  })
})

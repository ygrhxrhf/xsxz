import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

async function browseSource(): Promise<string> {
  return await readFile(new URL('./Browse.vue', import.meta.url), 'utf-8')
}

describe('Browse web reading mode contract', () => {
  it('hides the app toolbar and hosts reading mode as an immersive overlay', async () => {
    const source = await browseSource()
    expect(source).toContain('v-show="!toolbarCollapsed && !readingPage"')
    expect(source).toContain('<div v-if="!readingPage" class="web-reading-controls">')
    expect(source).toContain('class="web-reading-viewport"')
    expect(source).toContain('ref="readingViewport"')
    expect(source).toContain('class="web-reading-chrome top"')
    expect(source).toContain('class="web-reading-chrome bottom"')
    // 分页不再用位移模拟，页码来自真实滚动容器
    expect(source).not.toContain('translateY(-${readingPageIndex')
    expect(source).not.toContain('class="web-page-edge')
    expect(source).toContain('visualPageCount(el.scrollHeight, el.clientHeight)')
    expect(source).toContain('scrollTopForVisualPage(next, el.scrollHeight, el.clientHeight)')
  })

  it('ships catalog, auto scroll, TTS and shelf entries inside reading mode', async () => {
    const source = await browseSource()
    expect(source).toContain('class="web-reading-catalog"')
    expect(source).toContain('jumpToCatalogChapter(index)')
    expect(source).toContain("window.api.browse.chapterCatalog({ catalogUrl: '', url: readingPage.value?.url })")
    expect(source).toContain('catalogIsCurrent(index)')
    expect(source).toContain('const autoScroll = createAutoScroll(')
    expect(source).toContain('requestAnimationFrame(autoScrollStep)')
    expect(source).toContain('const tts = useTts({')
    expect(source).toContain('window.api.shelf.add(url)')
  })

  it('keeps reading mode alive across chapter changes and remembers the position', async () => {
    const source = await browseSource()
    // 换章不再先退出阅读模式
    const changeChapter = source.slice(source.indexOf('async function changeChapter'), source.indexOf('async function switchReadingChapter'))
    expect(changeChapter).not.toContain('exitReadingMode')
    expect(source).toContain('await window.api.browse.readingPage(url)')
    expect(source).toContain('window.api.browse.getReadingPos(url)')
    expect(source).toContain('window.api.browse.saveReadingPos({')
    expect(source).toContain('readingSaveTimer = setTimeout(write, 800)')
    expect(source).toContain('prefetchNeighborChapter')
    expect(source).toContain('window.api.browse.prefetchChapter(next.url)')
  })

  it('wires keyboard, auto continue and reading preference separation', async () => {
    const source = await browseSource()
    expect(source).toContain("if (key === 'a' || key === 'A') { event.preventDefault(); toggleAutoScroll(); return }")
    expect(source).toContain("if (key === 't' || key === 'T') { event.preventDefault(); void openCatalog(); return }")
    expect(source).toContain("if (key === 'm' || key === 'M') { event.preventDefault(); toggleReadingToolsLock(); return }")
    expect(source).toContain('setWebReading(\'autoSpeed\'')
    expect(source).toContain('setWebReading(\'autoPage\'')
    // 自动续章只在开着自动翻页时触发
    expect(source).toContain('if (!webReading.value.autoPage || !readingChapter.value?.next) return false')
    // 滚动偏好只写 reader，自动滚动偏好只写 webReading
    expect(source).toContain('void window.api.settings.set({ reader: { [key]: value } })')
    expect(source).toContain('void window.api.settings.set({ webReading: { [key]: value } })')
  })

  it('starts reading mode from a prefilled web-shelf url', async () => {
    const source = await browseSource()
    expect(source).toContain('prefillReading?: boolean')
    expect(source).toContain('void go({ reading: props.prefillReading })')
    expect(source).toContain('if (options.reading) await enterReadingMode(target)')
    expect(source).toContain('const res = url ? await window.api.browse.readingPage(url) : await window.api.browse.readingPage()')
  })

  it('takes its paper colours from the shared theme source, not a local copy', async () => {
    const source = await browseSource()
    expect(source).toContain("import { READER_THEME_COLORS } from '@shared/readerTheme'")
    expect(source).toContain('const colors = READER_THEME_COLORS[p.theme]')
    // 不再自带一份色表：否则同一个「纸白」会和书库阅读器渲出两种颜色
    expect(source).not.toMatch(/const themeColors\s*=\s*\{/)
  })

  it('exposes the full typographic set in the reading-mode panel', async () => {
    const source = await browseSource()
    const panel = source.slice(source.indexOf('v-if="readingPanel"'), source.indexOf('v-if="webAiPanelOpen"'))
    // 与书库阅读器同一份 ReaderPrefs：行距 / 段间距 / 首行缩进 / 行焦点都要能就地调
    expect(panel).toContain("setReaderPref('lineHeight'")
    expect(panel).toContain("setReaderPref('paragraphSpacing'")
    expect(panel).toContain("setReaderPref('paragraphIndent'")
    expect(panel).toContain("setReaderPref('focusMode'")
  })

  it('persists reading-mode marks by canonical chapter url', async () => {
    const source = await browseSource()
    expect(source).toContain("import { selectionRangeOffsets } from './selectionOffsets'")
    expect(source).toContain('import { decorateText } from \'@shared/paragraphSearch\'')
    expect(source).toContain('window.api.webAnnotations.add({')
    expect(source).toContain('window.api.webAnnotations.list(url)')
    expect(source).toContain('window.api.webAnnotations.update(')
    expect(source).toContain('window.api.webAnnotations.remove(')
    // 换章作废旧选区并重拉本章标注，避免把上一章的坐标当本章用
    const open = source.slice(source.indexOf('function openReadingPage'), source.indexOf('function prefetchNeighborChapter'))
    expect(open).toContain('closeSelectionTools(false)')
    expect(open).toContain('void reloadWebMarks()')
  })

  it('reports whole-book progress from the catalog, sharing the library formula', async () => {
    const source = await browseSource()
    // 目录后台侧取：不能挡住进阅读模式，拿不到就安静退回本章比例
    expect(source).toContain('async function ensureReadingCatalog()')
    const open = source.slice(source.indexOf('function openReadingPage'), source.indexOf('function prefetchNeighborChapter'))
    expect(open).toContain('void ensureReadingCatalog()')
    expect(open).toContain('void reloadWebMarks()')
    // 全书比例复用 readerHelpers 的同一公式，不再各写一份
    expect(source).toContain("import { approximateBookRatioFromIndex")
    expect(source).toContain('approximateBookRatioFromIndex(index, total, readingRatio.value)')
    // 目录没拿到时不猜百分比
    expect(source).toContain('if (index < 0 || !total) return null')
    expect(source).toContain('全书 ${Math.round(readingBookRatio.value * 100)}%')
  })

  it('routes cross-chapter AI to the existing download flow instead of half-implementing it', async () => {
    const source = await browseSource()
    expect(source).toContain('v-if="webAiPanelOpen"')
    // 已下载判定复用同一 id 空间：网页书架 id 与下载书 id 都由 canonicalBookId 派生
    expect(source).toContain('readingChapter.value?.shelfBookId')
    expect(source).toContain('res.books?.some((book) => book.id === shelfId)')
    expect(source).toContain('emit(\'open-book\', id)')
    // 就地只给不依赖书库的选区级 AI
    expect(source).toContain("askWebAi('translate')")
    expect(source).toContain("askWebAi('explain')")
    expect(source).toContain('window.api.ai.explainText(')
    // 不给网页阅读模式造第二套跨章 AI
    expect(source).not.toContain('window.api.ai.storySoFar(')
    expect(source).not.toContain('window.api.ai.updateMemory(')
  })
})

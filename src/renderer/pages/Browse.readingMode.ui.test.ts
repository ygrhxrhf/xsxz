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
})

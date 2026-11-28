// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { NMessageProvider } from 'naive-ui'
import Reader from './Reader.vue'

/**
 * 书中地图的入口有两个（顶部工具栏与标记抽屉），且两种阅读模式共用同一抽屉。
 * 这里只钉接线：入口打开抽屉、抽屉里是同一个地图页、无 Key 时的空态可见。
 * 地图页自身的加载状态由 `BookMapPage.ui.test.ts` 覆盖。
 */
class ResizeObserverStub { observe() {}; unobserve() {}; disconnect() {} }
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
Object.defineProperty(window, 'matchMedia', {
  value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  configurable: true,
})
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: () => {}, configurable: true })

afterEach(() => { document.body.innerHTML = '' })

function installReaderApi() {
  const chapters = [{ id: 'c1', index: 1, title: '第一章', file: '0001.json', status: 'ready' as const }]
  const book = {
    id: 'book-1', title: '地图书', author: '', tags: [] as string[], importType: 'txt' as const,
    createdAt: '', updatedAt: '', status: 'ready' as const, chapters, progress: null,
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      library: {
        get: async () => ({ book }),
        readChapter: async () => ({ chapter: { title: '第一章', body: '第一段。\n\n第二段。', status: 'ready' } }),
        setProgress: async () => ({ ok: true }),
      },
      settings: {
        get: async () => ({
          reader: {
            fontSize: 18, lineHeight: 1.8, theme: 'paper', fontFamily: 'serif', contentWidth: 'medium',
            paragraphSpacing: 'normal', paragraphIndent: true, focusMode: 'off', readingMode: 'scroll',
            bookView: 'classic',
          },
          tts: { rate: 1, autoNextChapter: true }, baseUrl: '', tencentMapKeyConfigured: false,
        }),
        set: async () => ({}),
      },
      annotations: {
        list: async () => ({ ok: true, items: [] }),
        add: async () => ({ ok: false, message: '测试桩：不新增' }),
        update: async () => ({ ok: false, message: '测试桩：不更新' }),
        remove: async () => ({ ok: true }),
      },
      download: { onProgress: () => () => {} },
      map: {
        getKey: async () => '',
        getImage: async () => ({ ok: true, url: null }),
        setImage: async () => ({ ok: false, message: '测试桩：不保存图片' }),
        getPlaces: async () => ({ ok: true, places: [] }),
        geocodePlaces: async () => ({ ok: false, message: '测试桩：不定位' }),
        confirmPlace: async () => ({ ok: false, message: '测试桩：不确认' }),
      },
      dialog: { openFile: async () => ({ filePaths: [] }) },
      ai: {
        onChunk: () => () => {}, onStage: () => () => {}, onExternalSources: () => () => {}, onBudget: () => () => {}, onDone: () => () => {},
        getMaterialCoverage: async () => ({ ok: true, coverage: null }),
        getUsage: async () => ({ ok: true, usage: { calls: 0 } }),
        chapterFinished: async () => ({ ok: false, message: '测试桩：不追剧' }),
      },
    },
  })
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

async function mountReader() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(Reader, { bookId: 'book-1' }) }) })
  app.mount(host)
  await nextTick(); await nextTick(); await flush()
  return app
}

function clickByAria(label: string): void {
  document.querySelector<HTMLElement>(`.tool-button[aria-label="${label}"]`)?.click()
}

describe('Reader 书中地图入口', () => {
  it('顶部工具栏打开地图抽屉；未配置 Key 时给去设置的空态', async () => {
    installReaderApi()
    const app = await mountReader()

    expect(document.querySelector('.book-map-page')).toBeNull()
    clickByAria('书中地图')
    await nextTick(); await flush(); await nextTick()

    expect(document.querySelector('.book-map-page')).not.toBeNull()
    expect(document.querySelector('.book-map-overlay')?.textContent).toContain('未配置腾讯地图 Key')
    expect(document.querySelector('.book-map-original')?.textContent).toContain('尚未选择书中地图图片')
    app.unmount()
  })

  it('标记抽屉里也有同一个地图入口', async () => {
    installReaderApi()
    const app = await mountReader()

    clickByAria('标记')
    await nextTick(); await flush()
    const entry = [...document.querySelectorAll<HTMLElement>('button')]
      .find((button) => button.textContent?.trim() === '书中地图')
    expect(entry).not.toBeUndefined()

    entry?.click()
    await nextTick(); await flush(); await nextTick()
    expect(document.querySelector('.book-map-page')).not.toBeNull()
    app.unmount()
  })
})

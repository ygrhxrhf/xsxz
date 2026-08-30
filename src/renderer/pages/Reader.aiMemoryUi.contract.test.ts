import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Reader recap and memory UI contract', () => {
  it('persists the three recap lengths and exposes their fixed labels', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    expect(source).toContain("const recapLength = ref<'short' | 'standard' | 'detailed'>('standard')")
    expect(source).toContain("recapLength.value = s.ai?.recapLength ?? 'standard'")
    expect(source).toContain('window.api.settings.set({ ai: { recapLength: value } })')
    expect(source).toContain('简短 · 约 200 字')
    expect(source).toContain('标准 · 约 500 字')
    expect(source).toContain('详细 · 约 1000 字')
  })

  it('loads, updates, rebuilds, marks, and applies structured memory locally', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    expect(source).toContain('window.api.ai.getMemory(book.value.id)')
    expect(source).toContain("kind === 'update' ? window.api.ai.updateMemory : window.api.ai.rebuildMemory")
    expect(source).toContain('window.api.ai.markMemoryInaccurate(book.value.id, kind, item.id)')
    expect(source).toContain('memoryData.value = event.memoryUpdate.memory')
    expect(source).toContain("startMemoryJob('update')")
    expect(source).toContain("startMemoryJob('rebuild')")
    expect(source).toContain('stopMemoryJob')
  })

  it('renders four kinds, review states, source coordinates, and fixed empty copy', async () => {
    const source = await readFile(new URL('./Reader.vue', import.meta.url), 'utf-8')
    for (const label of ['人物', '关系', '伏笔', '关键事件', '待复核', '存疑', '标记不准确']) {
      expect(source).toContain(label)
    }
    expect(source).toContain('source.paragraphIndex + 1')
    expect(source).toContain('source.excerpt')
    expect(source).toContain('还没有人物与剧情记忆。')
    expect(source).toContain('更新记忆后，可按人物、关系、伏笔和关键事件查看已读剧情。')
    expect(source).not.toContain('v-html')
  })
})

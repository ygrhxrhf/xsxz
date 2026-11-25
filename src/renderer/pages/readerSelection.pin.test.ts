// @vitest-environment jsdom
import { nextTick } from 'vue'
import { describe, expect, it, beforeEach } from 'vitest'
import { useReaderSelection } from './readerSelection'

/**
 * 划词工具栏的钉住行为：菜单里能钉住/取消，工具栏只展示钉住的项。
 * 这些是纯状态逻辑，不需要真实 DOM 选区，所以直接驱动 hook。
 */
function makeSelection() {
  return useReaderSelection({
    paragraphStarts: () => [0],
    normalizedBody: () => '第一段正文。',
    hasContent: () => true,
    message: { error: () => {}, success: () => {}, warning: () => {}, info: () => {} },
    marks: { addHighlight: async () => true, addNote: async () => true },
  })
}

beforeEach(() => { localStorage.clear() })

describe('划词工具栏的钉住', () => {
  it('默认钉住询问 AI、翻译、继续追问（第一个按钮就是 AI 入口）', () => {
    const selection = makeSelection()
    expect([...selection.pinnedActions.value]).toEqual(['ask', 'translate', 'chat'])
    expect(selection.isPinned('translate')).toBe(true)
    expect(selection.isPinned('copy')).toBe(false)
  })

  it('钉住与取消会改变工具栏集合', () => {
    const selection = makeSelection()
    selection.togglePinned('copy')
    expect(selection.isPinned('copy')).toBe(true)
    selection.togglePinned('chat')
    expect(selection.isPinned('chat')).toBe(false)
    expect([...selection.pinnedActions.value]).toEqual(['ask', 'translate', 'copy'])
  })

  it('拒绝取消最后一项：工具栏不能变成空条', () => {
    const selection = makeSelection()
    selection.togglePinned('translate')
    selection.togglePinned('chat')
    expect(selection.pinnedActions.value.length).toBe(1)
    // 只剩一项时再取消应当被拒绝，并返回 false 供调用方提示。
    expect(selection.togglePinned('ask')).toBe(false)
    expect([...selection.pinnedActions.value]).toEqual(['ask'])
  })

  it('钉住选择写进 localStorage 并能在下一次会话里读回', async () => {
    const first = makeSelection()
    first.togglePinned('note')
    // watch 默认在微任务后 flush，等一拍再读盘。
    await nextTick()
    const stored = JSON.parse(localStorage.getItem('spbf:selection-pinned') ?? '[]')
    expect(stored).toContain('note')
    // 新会话（新 hook 实例，读同一份 localStorage）应当读回同样的集合。
    const second = makeSelection()
    expect(second.isPinned('note')).toBe(true)
  })

  it('两个实例的钉住互不影响（不共享模块级状态）', () => {
    const a = makeSelection()
    const b = makeSelection()
    a.togglePinned('copy')
    expect(a.isPinned('copy')).toBe(true)
    expect([...b.pinnedActions.value]).toEqual(['ask', 'translate', 'chat'])
  })

  it('动作表覆盖工具栏与菜单需要的全部动作', () => {
    const selection = makeSelection()
    const ids = selection.SELECTION_ACTIONS.map((action) => action.id)
    // 第一个按钮必须是行内问答入口：工具栏最左侧就是「询问 AI」。
    expect(ids[0]).toBe('ask')
    expect(ids).toContain('explainWord')
    expect(ids).toContain('chat')
    expect(new Set(ids).size).toBe(ids.length)
  })
})

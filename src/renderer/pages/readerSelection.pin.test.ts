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

  it('拖动重排按新顺序改工具栏，且不会空掉', () => {
    const selection = makeSelection()
    selection.togglePinned('copy')
    selection.togglePinned('note')
    expect([...selection.pinnedActions.value]).toEqual(['ask', 'translate', 'chat', 'copy', 'note'])
    // 把最后一项拖到最前：后面的项依次后移一位。
    expect(selection.reorderPinned(4, 0)).toBe(true)
    expect([...selection.pinnedActions.value]).toEqual(['note', 'ask', 'translate', 'chat', 'copy'])
  })

  it('原地拖动、越界与只剩一项的拖动都被拒绝', () => {
    const selection = makeSelection()
    selection.togglePinned('copy')
    expect(selection.reorderPinned(2, 2)).toBe(false)
    expect(selection.reorderPinned(-1, 0)).toBe(false)
    expect(selection.reorderPinned(0, 9)).toBe(false)
    expect(selection.reorderPinned(0.5, 1)).toBe(false)
    expect(selection.reorderPinned(0, 3)).toBe(true)
    selection.togglePinned('translate')
    selection.togglePinned('chat')
    selection.togglePinned('copy')
    expect([...selection.pinnedActions.value]).toEqual(['ask'])
    // 唯一一项无处可去：顺序不变，工具栏仍有 1 个按钮。
    expect(selection.reorderPinned(0, 0)).toBe(false)
    expect([...selection.pinnedActions.value]).toEqual(['ask'])
  })

  it('重排结果写进 localStorage，下一会话读回同一顺序', async () => {
    const first = makeSelection()
    first.reorderPinned(2, 0)
    await nextTick()
    expect(JSON.parse(localStorage.getItem('spbf:selection-pinned') ?? '[]')).toEqual(['chat', 'ask', 'translate'])
    const second = makeSelection()
    expect([...second.pinnedActions.value]).toEqual(['chat', 'ask', 'translate'])
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

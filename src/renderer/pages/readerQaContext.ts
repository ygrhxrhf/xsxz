/**
 * 问答输入框上的「参考范围」开关（本章 / 记忆 / 批注）。
 *
 * 读者显式说清「先看什么」，模型就不用每轮猜要不要读原文。做法故意做得极轻：
 * 只在问题末尾附一行 `【参考：…】`，不新增 IPC、不额外调用模型——具体怎么用交给
 * 对话模式本来就有工具（read_chapter / get_memory / get_chapter_notes）自己判断，
 * 所以这里不写长句指印，免得聊天记录被提示词淹没。
 *
 * 纯函数放这里（不放进 readerAssistant.ts）是为了能在 node 环境下直接测：
 * 那份文件一 import 就依赖 window.api 与 naive-ui 的注入。
 */

export interface QaContextChips {
  chapter: boolean
  memory: boolean
  notes: boolean
}

/** 顺序固定成「本章原文 → 小说记忆 → 我的批注」：同一组开关在聊天记录里长得一样，读者才好回看。 */
const QA_CONTEXT_ITEMS: ReadonlyArray<{ key: keyof QaContextChips; label: string }> = [
  { key: 'chapter', label: '本章原文' },
  { key: 'memory', label: '小说记忆' },
  { key: 'notes', label: '我的批注' },
]

export const QA_CONTEXT_STORAGE_KEY = 'spbf.qaContextChips'

/** 指令的头尾只在这里定义一次：渲染与剥离共用，才不会两边对不上。 */
const DIRECTIVE_PREFIX = '【参考：'
const DIRECTIVE_SUFFIX = '】'

export function emptyQaContextChips(): QaContextChips {
  return { chapter: false, memory: false, notes: false }
}

/** 全关返回空串：读者没开开关时，问题保持他原本写的样子，一个字都不加。 */
export function qaContextDirective(chips: QaContextChips): string {
  const labels = QA_CONTEXT_ITEMS.filter((item) => chips[item.key] === true).map((item) => item.label)
  return labels.length ? `${DIRECTIVE_PREFIX}${labels.join(' · ')}${DIRECTIVE_SUFFIX}` : ''
}

/** 有没有开着的开关：界面上那行小字提示只在有时才显示。 */
export function hasQaContext(chips: QaContextChips): boolean {
  return QA_CONTEXT_ITEMS.some((item) => chips[item.key] === true)
}

/**
 * 把问题末尾那行参考范围剥掉。
 *
 * 重问和编辑重发都是拿聊天记录里的旧句子再走一遍 startChatFrom；不剥的话同一行标记
 * 会被叠成两行（旧的一行 + 当前开关的一行），编辑框里也不该出现这行机器标记。
 */
export function stripQaContextDirective(question: string): string {
  const text = question.replace(/\s+$/u, '')
  if (!text.endsWith(DIRECTIVE_SUFFIX)) return question
  const start = text.lastIndexOf(DIRECTIVE_PREFIX)
  if (start < 0) return question
  const head = text.slice(0, start)
  // 只剥「独占最后一行」的那份：正文里主动提到「【参考：…】」是读者自己的字，不动。
  if (head.trim() && !head.endsWith('\n')) return question
  return head.replace(/\s+$/u, '') || question
}

/** 隐私模式或没有 DOM 的环境里可能根本没有 localStorage：读不到就当没开过，不该拦住输入框。 */
function qaContextStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** 读盘只做字段白名单兜底：坏 JSON、类型不对、以后多出来的字段，一律回退全关。 */
export function readQaContextChips(storage: Storage | null = qaContextStorage()): QaContextChips {
  const chips = emptyQaContextChips()
  if (!storage) return chips
  try {
    const raw = storage.getItem(QA_CONTEXT_STORAGE_KEY)
    if (!raw) return chips
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return chips
    const record = parsed as Record<string, unknown>
    for (const item of QA_CONTEXT_ITEMS) chips[item.key] = record[item.key] === true
    return chips
  } catch {
    return chips
  }
}

/** 写盘失败不影响当前会话：只是下次打开面板时回到全关。 */
export function writeQaContextChips(chips: QaContextChips, storage: Storage | null = qaContextStorage()): void {
  if (!storage) return
  try {
    // 只写白名单字段：别把界面上的临时值一起存进去，下次读回来就没法按字段校验了。
    storage.setItem(QA_CONTEXT_STORAGE_KEY, JSON.stringify({
      chapter: chips.chapter === true,
      memory: chips.memory === true,
      notes: chips.notes === true,
    }))
  } catch {
    /* 配额或隐私模式 */
  }
}

import type { AiEvidenceChatMessage } from '../shared/types'

/**
 * `ai.replaceChat` 的入参校验。
 *
 * 为什么要有这个频道：重问、编辑重发、删除某一轮都会让「本地已有的历史」变短，
 * 而 `ai.chatStream` / `ai.agentChat` 只会往磁盘历史后面追加。没有一个整段覆盖的
 * 入口，读者删掉的一轮会被下一次问答原样带回来，历史里还会堆出重复轮次。
 *
 * 校验放在主进程而不是只靠渲染层：这里是唯一真正写盘的地方，参数从 IPC 进来就是
 * 不可信输入。上限是为了不让一次写盘把 chat.json 撑到读不回来。
 */
export const REPLACE_CHAT_MAX_MESSAGES = 200
export const REPLACE_CHAT_MAX_CONTENT = 20000
export const REPLACE_CHAT_MAX_CITATIONS = 50
export const REPLACE_CHAT_MAX_CLAIMS = 50
export const REPLACE_CHAT_MAX_CLAIM_TEXT = 1000

export interface ReplaceChatPayload {
  bookId: string
  messages: AiEvidenceChatMessage[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 只搬运持久化结构里的字段：界面上的 `steps`（思考链）是本地状态，
 * 不该顺手写进书库，所以这里逐字段重建对象而不是原样透传。
 */
function parseCitation(value: unknown, at: string) {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.chapterId !== 'string'
    || typeof value.chapterTitle !== 'string'
    || !Number.isSafeInteger(value.paragraphIndex)
    || (value.paragraphIndex as number) < 0
    || typeof value.excerpt !== 'string') {
    throw new Error(`${at}的引用格式无效`)
  }
  // excerpt 长度是证据流水线的约束，界面只负责搬运，不在这里重判。
  return {
    id: value.id,
    chapterId: value.chapterId,
    chapterTitle: value.chapterTitle,
    paragraphIndex: value.paragraphIndex as number,
    excerpt: value.excerpt,
  }
}

function parseClaims(value: unknown, at: string): Array<{ text: string; citationIds: string[] }> {
  if (!Array.isArray(value)) throw new Error(`${at}的结论列表格式无效`)
  if (value.length > REPLACE_CHAT_MAX_CLAIMS) throw new Error(`${at}的结论超过 ${REPLACE_CHAT_MAX_CLAIMS} 条`)
  return value.map((claim, index) => {
    const where = `${at}第 ${index + 1} 条结论`
    if (!isRecord(claim)) throw new Error(`${where}格式无效`)
    if (typeof claim.text !== 'string') throw new Error(`${where}缺少正文`)
    if (claim.text.length > REPLACE_CHAT_MAX_CLAIM_TEXT) {
      throw new Error(`${where}超过 ${REPLACE_CHAT_MAX_CLAIM_TEXT} 字`)
    }
    if (!Array.isArray(claim.citationIds) || claim.citationIds.some((id) => typeof id !== 'string')) {
      throw new Error(`${where}的引用 id 列表格式无效`)
    }
    return { text: claim.text, citationIds: [...(claim.citationIds as string[])] }
  })
}

function parseMessage(value: unknown, index: number): AiEvidenceChatMessage {
  const at = `第 ${index + 1} 条消息`
  if (!isRecord(value)) throw new Error(`${at}格式无效`)
  if (value.role !== 'user' && value.role !== 'assistant') {
    throw new Error(`${at}的角色只能是 user 或 assistant`)
  }
  if (typeof value.content !== 'string') throw new Error(`${at}的正文必须是文本`)
  if (value.content.length > REPLACE_CHAT_MAX_CONTENT) {
    throw new Error(`${at}的正文超过 ${REPLACE_CHAT_MAX_CONTENT} 字`)
  }
  const message: AiEvidenceChatMessage = { role: value.role, content: value.content }
  if (value.citations !== undefined) {
    if (!Array.isArray(value.citations)) throw new Error(`${at}的引用列表格式无效`)
    if (value.citations.length > REPLACE_CHAT_MAX_CITATIONS) {
      throw new Error(`${at}的引用超过 ${REPLACE_CHAT_MAX_CITATIONS} 条`)
    }
    message.citations = value.citations.map((citation) => parseCitation(citation, at))
  }
  if (value.claims !== undefined) message.claims = parseClaims(value.claims, at)
  // 已读截止与「已停止」也要跟着走，否则删一轮之后旧回答就会被当成完整回答。
  if (value.uptoChapterId !== undefined) {
    if (typeof value.uptoChapterId !== 'string') throw new Error(`${at}的已读截止格式无效`)
    message.uptoChapterId = value.uptoChapterId
  }
  if (value.stopped !== undefined) {
    if (typeof value.stopped !== 'boolean') throw new Error(`${at}的停止标记格式无效`)
    if (value.stopped) message.stopped = true
  }
  return message
}

/** 校验失败一律抛中文错误；handler 只负责把它摊成 `{ ok: false, message }`。 */
export function parseReplaceChatPayload(payload: unknown): ReplaceChatPayload {
  if (!isRecord(payload)) throw new Error('参数格式无效，无法覆盖问答历史')
  if (typeof payload.bookId !== 'string' || !payload.bookId.trim()) {
    throw new Error('缺少书籍 ID，无法覆盖问答历史')
  }
  if (!Array.isArray(payload.messages)) throw new Error('消息列表格式无效，无法覆盖问答历史')
  if (payload.messages.length > REPLACE_CHAT_MAX_MESSAGES) {
    throw new Error(`一次最多只能覆盖 ${REPLACE_CHAT_MAX_MESSAGES} 条消息，这次有 ${payload.messages.length} 条`)
  }
  return {
    bookId: payload.bookId.trim(),
    messages: payload.messages.map((message, index) => parseMessage(message, index)),
  }
}

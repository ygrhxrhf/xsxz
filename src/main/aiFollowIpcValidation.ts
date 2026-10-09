import type { AiFollowMode } from '../shared/types'

/**
 * 追剧三个频道的入参校验。这里的失败一律返回中文文案，不抛给界面堆栈，
 * 也绝不能因为参数不对就动用模型额度。
 */
export interface FollowBookPayload {
  bookId: string
}

export interface FollowSetPayload extends FollowBookPayload {
  mode: AiFollowMode
  confirmOverBudget: boolean
}

export interface ChapterFinishedPayload extends FollowBookPayload {
  chapterId: string
  ratio: number
}

const FOLLOW_MODES: readonly AiFollowMode[] = ['manual', 'ask', 'auto']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBookId(value: unknown): value is string {
  return typeof value === 'string' && /^[di]_[0-9a-f]{16}$/.test(value)
}

function isChapterId(value: unknown): value is string {
  return typeof value === 'string' && /^c\d{4,12}$/.test(value)
}

export function parseFollowBookPayload(payload: unknown): FollowBookPayload {
  if (!isRecord(payload) || !isBookId(payload.bookId)) throw new Error('书籍不存在')
  return { bookId: payload.bookId }
}

export function parseFollowSetPayload(payload: unknown): FollowSetPayload {
  const { bookId } = parseFollowBookPayload(payload)
  if (!isRecord(payload) || !FOLLOW_MODES.includes(payload.mode as AiFollowMode)) {
    throw new Error('追剧模式无效')
  }
  return {
    bookId,
    mode: payload.mode as AiFollowMode,
    confirmOverBudget: payload.confirmOverBudget === true,
  }
}

export function parseChapterFinishedPayload(payload: unknown): ChapterFinishedPayload {
  const { bookId } = parseFollowBookPayload(payload)
  if (!isRecord(payload) || !isChapterId(payload.chapterId)) throw new Error('章节不存在')
  const { ratio } = payload
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new Error('阅读进度无效')
  }
  return { bookId, chapterId: payload.chapterId, ratio }
}

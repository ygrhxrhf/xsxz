/**
 * 章节 AI 思维导图共享类型（移植自 infinite-reader/shared/mindmap.ts）。
 */

export interface AiMindmapNode {
  text: string
  children: AiMindmapNode[]
}

export interface AiMindmapResult {
  tree: AiMindmapNode
  title: string
  generatedAt: number
  model: string
}

export type AiMindmapGetResponse =
  | { ok: true; result: AiMindmapResult | null }
  | { ok: false; message: string }

export type AiMindmapGenerateResponse =
  | { ok: true; result: AiMindmapResult; cached: boolean }
  | { ok: false; message: string; code?: string }

import type { AiRequestStage } from '@shared/types'

export type AssistantJobKind = 'recap' | 'memory' | 'qa' | 'notes'

/**
 * AI 壳的 tab：四类任务各一个 pane，再加「输出」放清正文、翻译这类一次性结果。
 * 「输出」不是任务种类，它没有 jobId，也就不显示阶段状态。
 */
export type AssistantPanelTab = AssistantJobKind | 'output'

export interface AssistantJobIds {
  recap: string
  memory: string
  qa: string
  notes: string
}

export interface AssistantSaveTokenState {
  token: string
  kind: AssistantJobKind | ''
}

/** 阶段名说「在做什么」，主进程的 detail 说「做到哪了」，界面只渲染一条，两者不会各说各话。 */
export interface AssistantStageState {
  stage: AiRequestStage
  detail?: string
}

const STAGE_LABELS: Record<AiRequestStage, string> = {
  preparing: '正在准备已读材料…',
  queued: '已排队，等待前面的任务完成…',
  indexing: '正在检索本地已读内容…',
  rewriting: '正在改写检索问题…',
  searching: '正在检索本地已读内容…',
  requesting: '正在请求模型服务…',
  saving: '正在保存到本地书库…',
}

export function assistantKindForJob(jobId: string, jobs: AssistantJobIds): AssistantJobKind | null {
  if (!jobId) return null
  // 遍历而不是逐条 if：再加一种任务时不会再出现「类型里有、判定里漏」的哑火。
  const kind = (Object.keys(jobs) as AssistantJobKind[]).find((item) => jobId === jobs[item])
  return kind ?? null
}

/** detail 空串或全空白时退回阶段名，新增阶段不会因为漏了文案而显示空白。 */
export function describeAssistantStage(state: AssistantStageState | undefined): string {
  if (!state) return ''
  return state.detail?.trim() || STAGE_LABELS[state.stage]
}

export function currentAssistantStage(
  stages: Readonly<Record<string, AssistantStageState>>,
  tab: AssistantJobKind,
  jobs: AssistantJobIds,
): AssistantStageState | undefined {
  return stages[jobs[tab]]
}

export function removeAssistantStage<T>(
  stages: Readonly<Record<string, T>>,
  jobId: string,
): Record<string, T> {
  if (!(jobId in stages)) return { ...stages }
  const next = { ...stages }
  delete next[jobId]
  return next
}

export function updateAssistantSaveToken(
  current: AssistantSaveTokenState,
  kind: AssistantJobKind,
  event: { ok: boolean; saveToken?: string; stopped?: boolean },
): AssistantSaveTokenState {
  if (!event.ok) return current
  if (event.saveToken) return { token: event.saveToken, kind }
  if (event.stopped) return current
  return current.kind === kind ? { token: '', kind: '' } : current
}

export function clearRetriedAssistantSaveToken(
  current: AssistantSaveTokenState,
  retriedToken: string,
): AssistantSaveTokenState {
  return current.token === retriedToken ? { token: '', kind: '' } : current
}

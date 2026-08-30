import type { AiRequestStage } from '@shared/types'

export type AssistantJobKind = 'recap' | 'memory' | 'qa'

export interface AssistantJobIds {
  recap: string
  memory: string
  qa: string
}

export interface AssistantSaveTokenState {
  token: string
  kind: AssistantJobKind | ''
}

export function assistantKindForJob(jobId: string, jobs: AssistantJobIds): AssistantJobKind | null {
  if (jobId && jobId === jobs.recap) return 'recap'
  if (jobId && jobId === jobs.memory) return 'memory'
  if (jobId && jobId === jobs.qa) return 'qa'
  return null
}

export function currentAssistantStage(
  stages: Readonly<Record<string, AiRequestStage>>,
  tab: AssistantJobKind,
  jobs: AssistantJobIds,
): AiRequestStage | undefined {
  return stages[jobs[tab]]
}

export function removeAssistantStage(
  stages: Readonly<Record<string, AiRequestStage>>,
  jobId: string,
): Record<string, AiRequestStage> {
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

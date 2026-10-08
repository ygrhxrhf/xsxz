export interface OrganizeQueueState {
  chapters: string[]
  paused: boolean
}

export function normalizeOrganizeQueue(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const chapters: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !/^c\d{4,12}$/.test(item) || chapters.includes(item)) continue
    chapters.push(item)
  }
  return chapters
}

export function enqueueCompletedChapter(state: OrganizeQueueState, chapterId: string, organizingChapterId = ''): OrganizeQueueState {
  if (!/^c\d{4,12}$/.test(chapterId) || state.chapters.includes(chapterId) || organizingChapterId === chapterId) return state
  return { ...state, chapters: [...state.chapters, chapterId] }
}

export function pauseOrganizeQueue(state: OrganizeQueueState): OrganizeQueueState {
  return state.paused ? state : { ...state, paused: true }
}

export function resumeOrganizeQueue(state: OrganizeQueueState): OrganizeQueueState {
  return state.paused ? { ...state, paused: false } : state
}

export function finishOrganizedChapter(state: OrganizeQueueState, chapterId: string): OrganizeQueueState {
  if (state.chapters[0] !== chapterId) return state
  return { ...state, chapters: state.chapters.slice(1) }
}

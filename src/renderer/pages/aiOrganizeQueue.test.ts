import { describe, expect, it } from 'vitest'
import { enqueueCompletedChapter, finishOrganizedChapter, normalizeOrganizeQueue, pauseOrganizeQueue, resumeOrganizeQueue } from './aiOrganizeQueue'

describe('pausable chapter organize queue', () => {
  it('keeps only unique chapter ids from stored data', () => {
    expect(normalizeOrganizeQueue(['c0001', 'bad', 'c0001', 2, 'c0002'])).toEqual(['c0001', 'c0002'])
  })

  it('can pause without dropping pending chapters and resume the same queue', () => {
    const queued = enqueueCompletedChapter({ chapters: [], paused: false }, 'c0003')
    const paused = pauseOrganizeQueue(queued)
    expect(paused).toEqual({ chapters: ['c0003'], paused: true })
    expect(resumeOrganizeQueue(paused).paused).toBe(false)
    expect(finishOrganizedChapter(resumeOrganizeQueue(paused), 'c0003').chapters).toEqual([])
  })

  it('does not enqueue the chapter currently being organized', () => {
    const state = { chapters: ['c0001'], paused: false }
    expect(enqueueCompletedChapter(state, 'c0001', 'c0002')).toBe(state)
    expect(enqueueCompletedChapter(state, 'c0002', 'c0002')).toBe(state)
  })
})

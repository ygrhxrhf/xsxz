import { ref } from 'vue'

/** 与正文渲染一致的分段规则：空行切段。 */
export function splitIntoParagraphs(body: string): string[] {
  return body.split(/\n{2,}/).filter(Boolean)
}

export function clampTtsRate(n: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.min(2, Math.max(0.5, n))
}

export interface UseTtsOptions {
  /** 当前章节的可朗读段落 */
  paragraphs: () => string[]
  rate: () => number
  /** 一章读完后是否自动跳下一章 */
  autoNext: () => boolean
  onChapterEnd: () => void
}

/**
 * 基于 Web speechSynthesis 的逐段朗读。链式播放（读完一段再排下一段），
 * 以便高亮当前段落并在章末触发回调。纯 UI 层，不经过主进程。
 */
export function useTts(opts: UseTtsOptions) {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window
  const speaking = ref(false)
  const paused = ref(false)
  /** 正在朗读的段落下标；未在朗读时为 -1 */
  const spokenPara = ref(-1)

  let stopped = true

  function cancel(): void {
    if (!supported) return
    try {
      window.speechSynthesis.cancel()
    } catch {
      /* engine already gone */
    }
  }

  function finish(): void {
    speaking.value = false
    paused.value = false
    spokenPara.value = -1
  }

  function playFrom(index: number): void {
    if (!supported || stopped) return
    const paras = opts.paragraphs()
    if (index >= paras.length) {
      finish()
      if (opts.autoNext()) opts.onChapterEnd()
      return
    }
    spokenPara.value = index
    const u = new SpeechSynthesisUtterance(paras[index])
    u.rate = clampTtsRate(opts.rate())
    u.lang = 'zh-CN'
    u.onend = () => {
      if (!stopped) playFrom(index + 1)
    }
    u.onerror = () => {
      // 引擎报错时跳过这一段继续，避免卡死
      if (!stopped) playFrom(index + 1)
    }
    window.speechSynthesis.speak(u)
  }

  function start(from = 0): void {
    if (!supported) return
    cancel()
    stopped = false
    paused.value = false
    speaking.value = true
    playFrom(Math.max(0, from))
  }

  function pause(): void {
    if (!supported || !speaking.value) return
    window.speechSynthesis.pause()
    paused.value = true
  }

  function resume(): void {
    if (!supported || !paused.value) return
    window.speechSynthesis.resume()
    paused.value = false
  }

  function stop(): void {
    stopped = true
    cancel()
    finish()
  }

  return { supported, speaking, paused, spokenPara, start, pause, resume, stop }
}

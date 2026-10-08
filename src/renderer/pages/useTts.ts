import { ref } from 'vue'

/** 与正文渲染一致的分段规则：空行切段。 */
export function splitIntoParagraphs(body: string): string[] {
  return body.split(/\n{2,}/).filter(Boolean)
}

export function clampTtsRate(n: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.min(2, Math.max(0.5, n))
}

/** 语音接口每次最多接收 500 个 UTF-16 字符，优先在句末切开。 */
export function splitSpeechChunks(text: string, maxLength = 480): string[] {
  if (!text) return []
  const chunks: string[] = []
  let rest = text.trim()
  while (rest.length > maxLength) {
    const candidate = rest.slice(0, maxLength)
    const punctuation = Math.max(candidate.lastIndexOf('。'), candidate.lastIndexOf('！'), candidate.lastIndexOf('？'), candidate.lastIndexOf('；'), candidate.lastIndexOf('\n'))
    const split = punctuation >= Math.floor(maxLength / 3) ? punctuation + 1 : maxLength
    chunks.push(rest.slice(0, split))
    rest = rest.slice(split).trimStart()
  }
  if (rest) chunks.push(rest)
  return chunks
}

export interface UseTtsOptions {
  paragraphs: () => string[]
  rate: () => number
  autoNext: () => boolean
  onChapterEnd: () => void | Promise<void>
  source?: () => 'system' | 'online'
  voiceURI?: () => string
  synthesize?: (requestId: string, text: string) => Promise<Uint8Array>
  cancelSynthesis?: (requestId: string) => void
  onParagraphStart?: (index: number) => void
}

export function useTts(opts: UseTtsOptions) {
  const supported = typeof window !== 'undefined' && ('speechSynthesis' in window || typeof Audio !== 'undefined')
  const speaking = ref(false)
  const paused = ref(false)
  const spokenPara = ref(-1)
  const error = ref('')
  const sleepMinutes = ref(0)
  const sleepAfterParagraph = ref(false)

  let generation = 0
  let currentRequest = ''
  let audio: HTMLAudioElement | null = null
  let audioUrl = ''
  let sleepRemaining = 0
  let sleepStarted = 0
  let sleepTimer: ReturnType<typeof setTimeout> | null = null

  function releaseAudio(): void {
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio = null }
    if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = '' }
  }

  function cancelCurrent(): void {
    generation++
    if (currentRequest) opts.cancelSynthesis?.(currentRequest)
    currentRequest = ''
    if ('speechSynthesis' in window) {
      try { window.speechSynthesis.cancel() } catch { /* engine already gone */ }
    }
    releaseAudio()
  }

  function haltSleep(): void {
    if (sleepTimer) clearTimeout(sleepTimer)
    sleepTimer = null
    if (sleepStarted) sleepRemaining = Math.max(0, sleepRemaining - (Date.now() - sleepStarted))
    sleepStarted = 0
  }

  function armSleep(): void {
    if (!speaking.value || paused.value || sleepMinutes.value <= 0 || sleepAfterParagraph.value) return
    if (sleepRemaining <= 0) { sleepAfterParagraph.value = true; return }
    sleepStarted = Date.now()
    sleepTimer = setTimeout(() => {
      sleepTimer = null
      sleepStarted = 0
      sleepRemaining = 0
      sleepAfterParagraph.value = true
    }, sleepRemaining)
  }

  function setSleepMinutes(minutes: number): void {
    haltSleep()
    sleepMinutes.value = [0, 10, 20, 30, 60].includes(minutes) ? minutes : 0
    sleepRemaining = sleepMinutes.value * 60_000
    sleepAfterParagraph.value = false
    armSleep()
  }

  function stop(preserveTimer = false): void {
    haltSleep()
    cancelCurrent()
    speaking.value = false
    paused.value = false
    spokenPara.value = -1
    error.value = ''
    if (!preserveTimer) {
      sleepRemaining = sleepMinutes.value * 60_000
      sleepAfterParagraph.value = false
    }
  }

  function fail(message: string, token: number): void {
    if (token !== generation) return
    haltSleep()
    releaseAudio()
    error.value = message
    paused.value = true
  }

  function playSystem(text: string, token: number, next: () => void): void {
    if (!('speechSynthesis' in window)) { fail('当前环境没有系统语音', token); return }
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = clampTtsRate(opts.rate())
    utterance.lang = 'zh-CN'
    const uri = opts.voiceURI?.()
    if (uri) utterance.voice = window.speechSynthesis.getVoices?.().find((voice) => voice.voiceURI === uri) ?? null
    utterance.onend = () => { if (token === generation) next() }
    utterance.onerror = (event) => {
      if (token !== generation || event.error === 'canceled' || event.error === 'interrupted') return
      fail(`系统语音播放失败：${event.error || '未知错误'}`, token)
    }
    try { window.speechSynthesis.speak(utterance) }
    catch { fail('系统语音启动失败', token) }
  }

  async function playOnline(text: string, token: number, next: () => void): Promise<void> {
    if (!opts.synthesize) { fail('在线语音不可用', token); return }
    const requestId = `${Date.now()}_${token}_${Math.random().toString(36).slice(2)}`
    currentRequest = requestId
    try {
      const bytes = await opts.synthesize(requestId, text)
      if (token !== generation) return
      currentRequest = ''
      audioUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'audio/mpeg' }))
      audio = new Audio(audioUrl)
      audio.playbackRate = clampTtsRate(opts.rate())
      audio.onended = () => { if (token === generation) { releaseAudio(); next() } }
      audio.onerror = () => fail('在线语音音频无法播放', token)
      if (!paused.value) await audio.play()
      if (token !== generation) releaseAudio()
    } catch (cause) {
      if (token === generation) fail(cause instanceof Error ? cause.message : '在线语音请求失败', token)
    }
  }

  function playParagraph(index: number, token: number): void {
    if (token !== generation || paused.value) return
    const paras = opts.paragraphs()
    if (index >= paras.length) {
      const nextChapter = opts.autoNext() && !sleepAfterParagraph.value
      stop(true)
      if (nextChapter) void opts.onChapterEnd()
      return
    }
    spokenPara.value = index
    opts.onParagraphStart?.(index)
    const chunks = splitSpeechChunks(paras[index])
    let chunkIndex = 0
    const nextChunk = () => {
      if (token !== generation || paused.value) return
      if (chunkIndex >= chunks.length) {
        if (sleepAfterParagraph.value) { stop(); return }
        playParagraph(index + 1, token)
        return
      }
      const chunk = chunks[chunkIndex++]!
      if ((opts.source?.() ?? 'system') === 'online') void playOnline(chunk, token, nextChunk)
      else playSystem(chunk, token, nextChunk)
    }
    nextChunk()
  }

  function start(from = 0, preserveTimer = false): void {
    if (!supported || opts.paragraphs().length === 0) return
    stop(preserveTimer)
    if (!preserveTimer) sleepRemaining = sleepMinutes.value * 60_000
    speaking.value = true
    paused.value = false
    armSleep()
    playParagraph(Math.max(0, Math.min(from, opts.paragraphs().length - 1)), generation)
  }

  function pause(): void {
    if (!speaking.value || paused.value) return
    haltSleep()
    if ((opts.source?.() ?? 'system') === 'online') audio?.pause()
    else window.speechSynthesis.pause()
    paused.value = true
  }

  function resume(): void {
    if (!speaking.value || !paused.value || error.value) return
    paused.value = false
    armSleep()
    if ((opts.source?.() ?? 'system') === 'online') {
      if (audio) void audio.play().catch(() => fail('在线语音音频无法继续播放', generation))
    } else window.speechSynthesis.resume()
  }

  function retry(): void { if (spokenPara.value >= 0) start(spokenPara.value, true) }
  function next(): void {
    if (spokenPara.value < 0) return
    if (spokenPara.value + 1 >= opts.paragraphs().length) {
      const autoNext = opts.autoNext()
      stop(true)
      if (autoNext) void opts.onChapterEnd()
    } else start(spokenPara.value + 1, true)
  }
  function previous(): void { if (spokenPara.value >= 0) start(Math.max(0, spokenPara.value - 1), true) }
  function updateRate(): void { if (audio) audio.playbackRate = clampTtsRate(opts.rate()) }

  return { supported, speaking, paused, spokenPara, error, sleepMinutes, sleepAfterParagraph,
    start, pause, resume, stop, retry, next, previous, setSleepMinutes, updateRate }
}

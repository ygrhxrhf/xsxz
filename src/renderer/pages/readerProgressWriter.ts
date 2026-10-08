export type ProgressWriteOutcome = 'saved' | 'failed' | 'skipped'

/** 排期那一刻抓好的写入动作，落盘时机由状态机决定。 */
export type CapturedProgressWrite = () => Promise<unknown>

export interface ReaderProgressWriter {
  /** 滚动：抓一份位置，安静 delayMs 之后写一次；期间再滚就用新位置顶掉旧的。 */
  schedule(): void
  /** 换章 / 切书 / 关窗：撤掉待触发的排期，把刚抓的位置单独排队写出去。 */
  writeNow(): Promise<ProgressWriteOutcome>
}

/**
 * 阅读进度只有一个写入口。
 * 之前排期和落盘在 4 处各写一遍，换章时待触发的定时器会跑到新章的 DOM 上重抓位置，
 * 上一章的滚动比例就被写成「新章已读完」；两次写入还可能并发，谁先落盘没有保证。
 *
 * capture 必须同步返回已经锁好书本、章节、位置的闭包（抓不到返回 null），
 * 写盘一律串到上一条之后：schedule 只留最新一份，writeNow 每条都要落地（换书时两份属于不同的书）。
 */
export function createReaderProgressWriter(
  capture: () => CapturedProgressWrite | null,
  delayMs = 1000,
): ReaderProgressWriter {
  let timer: ReturnType<typeof setTimeout> | null = null
  let queued: CapturedProgressWrite | null = null
  let chain: Promise<unknown> = Promise.resolve()
  let inFlight: Promise<ProgressWriteOutcome> | null = null

  function enqueue(write: CapturedProgressWrite): Promise<ProgressWriteOutcome> {
    const run: Promise<ProgressWriteOutcome> = chain.then(async () => {
      try {
        await write()
        return 'saved'
      } catch {
        return 'failed'
      }
    })
    chain = run
    inFlight = run
    void run.then(() => {
      if (inFlight === run) inFlight = null
    })
    return run
  }

  function commit(): Promise<ProgressWriteOutcome> {
    const write = queued
    queued = null
    if (write) return enqueue(write)
    return inFlight ?? Promise.resolve<ProgressWriteOutcome>('skipped')
  }

  return {
    schedule() {
      const next = capture()
      if (next) queued = next
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void commit()
      }, delayMs)
    },
    writeNow() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      const next = capture()
      if (next) queued = next
      return commit()
    },
  }
}

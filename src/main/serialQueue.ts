/**
 * 串行执行队列：同一个隐藏视图上的页面加载必须排队。
 *
 * 为什么需要：一个 WebContents 只有一条导航。两次 `loadURL` 叠在一起时，后一次会把
 * 前一次 abort 掉，而 `loadAndGetHtml` 把 ERR_ABORTED 当正常结束吞掉，于是先发起的那次
 * 会拿到后一个页面的 DOM（或空白页）当成自己的结果——镜像预取读到错误的书目页就属于这种。
 *
 * 队列语义：任务按调用顺序一个一个跑；前一个失败不影响后一个；
 * 每次调用都拿到自己那次 task 的结果 / 异常。
 */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

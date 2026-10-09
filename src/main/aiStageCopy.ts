/**
 * 排队与检索进度要说人话：主进程把状态拼成一句话随 `ai.stage.detail` 推给界面，
 * 界面只显示、不再自己猜阶段含义。这里保持纯函数，方便把文案口径钉在测试里。
 */

/** 位次含自己，说给用户的是「前面还有几个」；第一位不谎报数字。 */
export function queueWaitingText(position: number): string {
  return position > 1 ? `已排队，前面还有 ${position - 1} 个任务` : '已排队，正在等待当前任务让路'
}

export interface StageReadPlan {
  indexed: number
  total: number
  read: number
}

/**
 * 剪枝靠按章索引。索引没覆盖到就要老实说「本次通读全部已读正文」——
 * 第一次提问慢是它在补读盘，说清来源才不会让人以为卡住。
 */
export function indexingText(reads: StageReadPlan): string {
  if (!reads.indexed) return `检索索引还没建好，本次通读 ${reads.total} 章已读正文`
  return `检索索引已覆盖 ${reads.indexed}/${reads.total} 章，本次只读 ${reads.read} 章`
}

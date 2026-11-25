import type { AiCitation, AiEvidenceChatMessage } from '@shared/types'

/**
 * 侧栏问答消息在界面里的样子：在持久化的 `AiEvidenceChatMessage` 之外多一条思考链。
 *
 * 为什么不做进 IPC 类型：思考链是「这一轮正在怎么干」的即时回放，重开侧栏后没有意义，
 * 写进 chat.json 只会让书库里堆一批过期的工具名。所以它只活在这个扩展类型里，
 * `ai.replaceChat` 的快照会把它剔掉。
 */
export interface ChatStep {
  label: string
  state: 'running' | 'done' | 'error'
}

export interface ReaderChatMessage extends AiEvidenceChatMessage {
  steps?: ChatStep[]
}

/**
 * 把一步工具进度并进思考链。
 *
 * - 同一个 label 连续来两次（检索→检索）合并成一步，免得链被刷成流水账；
 * - 新的一步进来时，上一步的 running 翻成终态；
 * - `label` 为空表示这一轮结束，只收尾不加步，链留着给读者回看。
 */
export function appendChatStep(
  steps: readonly ChatStep[] | undefined,
  label: string,
  settle: ChatStep['state'] = 'done',
): ChatStep[] | undefined {
  const current = steps ? [...steps] : []
  const text = label.trim()
  const last = current.at(-1)
  if (text && last && last.label === text && last.state === 'running') return current
  if (!text) {
    if (!current.some((step) => step.state === 'running')) return current.length ? current : undefined
    return current.map((step) => (step.state === 'running' ? { ...step, state: settle } : step))
  }
  return [
    ...current.map((step) => (step.state === 'running' ? { ...step, state: settle } : step)),
    { label: text, state: 'running' },
  ]
}

export interface ClaimCitationBadge {
  /** 角标文字里的序号：该引用在 `message.citations` 里的位置，从 1 开始。 */
  label: number
  citation: AiCitation
}

export interface ClaimCitationLine {
  text: string
  badges: ClaimCitationBadge[]
}

/**
 * 把「结论 + 引用 id」摊成界面要的行与角标。
 *
 * 编号取引用在 `message.citations` 里的位置而不是 claim 内部的顺序：
 * 下面「依据」列表也是这个顺序，读者从 [2] 数到第 2 条就能对上。
 * 找不到的 id 直接丢掉——它没有可跳转的段落，点了也没用。
 */
export function claimCitationLines(
  message: Pick<AiEvidenceChatMessage, 'claims' | 'citations'>,
): ClaimCitationLine[] {
  const citations = message.citations ?? []
  const positions = new Map(citations.map((citation, index) => [citation.id, index + 1]))
  return (message.claims ?? []).map((claim) => {
    const labels = new Set<number>()
    for (const id of claim.citationIds) {
      const label = positions.get(id)
      if (label !== undefined) labels.add(label)
    }
    return {
      text: claim.text,
      badges: [...labels].map((label) => ({ label, citation: citations[label - 1]! })),
    }
  })
}

/**
 * 「依据」折叠块上方的一行状态徽标。
 *
 * 为什么由后端给结论而不是界面自己推：界面只知道「还剩几条结论」，不知道 judge 跑没跑成、
 * 删了几条。自己推就会把「没校验」渲染成「已校验」——那正是这个功能要防的事。
 * 旧记录没有 verification，返回空串，界面不显示任何徽标（不默认说它被校验过）。
 */
export function evidenceVerificationLabel(
  message: Pick<AiEvidenceChatMessage, 'verification' | 'claims' | 'droppedClaims'>,
): string {
  if (message.verification === 'verified') {
    return `已核验：${message.claims?.length ?? 0} 条结论均有原文支持`
  }
  if (message.verification === 'partial') {
    const dropped = message.droppedClaims
    // 没这个字段的只能是旧记录：说清「已删」但别编一个数字出来。
    if (dropped === undefined) return '部分结论无原文支持，已删除'
    // dropped 为 0 也可能出现：judge 跑成了、一条没删，但有结论没给逐字引文，那几条没被核过。
    if (dropped === 0) return '已核验：部分结论未给出逐字原文，请自行核对'
    return `已核验：删除了 ${dropped} 条无原文支持的结论`
  }
  if (message.verification === 'not_run') {
    return '未运行校验：模型未给出引文或校验请求失败，请自行核对原文'
  }
  return ''
}

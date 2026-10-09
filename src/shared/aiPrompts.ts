import type { AiPrefs, AiPromptKind } from './types'

export const AI_PROMPT_LABELS: Record<AiPromptKind, string> = {
  clean: '清正文',
  translate: '翻译',
  chapterSummary: '本章摘要',
  chapterNote: '本章笔记',
  recap: '前情提要',
  memory: '小说记忆',
  evidenceQa: '证据问答',
}

/** Only the user-editable task requirement. Safety, read cutoff and structured-output rules stay in code. */
export const BUILTIN_AI_PROMPTS: Record<AiPromptKind, string> = {
  clean: '删除网页导航、广告、推荐阅读、网站水印和与小说正文无关的文字。保持原有段落顺序，不改写、不续写、不概括小说内容。',
  translate: '把选中文字转换成通顺的现代汉语。外文应翻译，文言文应释义；已经是现代汉语时只做简短解释。只返回译文或释义。',
  chapterSummary: '用简洁中文概括本章已经发生的事件、人物变化和关键信息，不补充章节之外的内容。',
  chapterNote: '替读者整理本章读书笔记：按情节顺序记下发生了什么、人物处境与关系的变化、新埋下的伏笔，以及值得回看的句子；每条一到两句，简短具体。',
  recap: '把已经保存的已读摘要和小说记忆整理成连贯的前情提要，突出继续阅读最需要回忆的人物、冲突、目标和未回收伏笔。',
  memory: '从新增已读章节更新人物、人物关系、伏笔和关键事件。合并重复信息；别名只有证据充分时合并；不确定信息保守表达。',
  evidenceQa: '只根据提供的已读正文证据回答。结论必须对应至少一条证据；证据不足时明确说明，不使用书外知识猜测剧情。',
}

export function resolveAiTaskInstruction(ai: AiPrefs, kind: AiPromptKind): string {
  const custom = ai.customPrompts[kind]?.trim()
  return ai.promptMode[kind] === 'custom' && custom ? custom : BUILTIN_AI_PROMPTS[kind]
}

/**
 * 页内批注卡与图片块的 DOM 排版。
 *
 * 纹理绘制把它们画成位图；静态页和顶层飞页改由 DOM 显示（飞页还要跟着纸卷），
 * 所以这里按**与画布完全相同的字号、缩进、行距**把卡片与图注拆成一行行文字，
 * 上层的 DOM 层只负责把每一行贴到页面上。纯函数，方便单测。
 */

import type { RealBookNote } from './realBookNotes'
import type { PageTextureImageBox, PageTextureNoteBox } from './realBookTexture'

export type PageRunRole = 'note-label' | 'note-body' | 'note-tags' | 'image-caption'

/** 一行页内文字：页面逻辑坐标 + alphabetic 基线（与画布同义）。 */
export interface PageTextRun {
  text: string
  role: PageRunRole
  x: number
  baseline: number
  fontSize: number
}

export interface PageNoteLayout {
  id: string
  note: RealBookNote
  x: number
  y: number
  width: number
  height: number
  runs: PageTextRun[]
}

export interface PageImageLayout {
  file: string
  caption: string
  x: number
  y: number
  width: number
  height: number
  captionRun: PageTextRun | null
}

export interface PageBlockStyle {
  fontSize: number
  lineHeight: number
}

export interface PageBlockTools {
  /** 与纹理同一套字体量宽（按字号）。 */
  measure: (text: string, fontSize: number) => number
  /** 与纹理同一套断行（`wrapTextureText`），返回至多三行。 */
  wrap: (text: string, fontSize: number, maxWidth: number) => string[]
}

/**
 * 批注卡：标签、最多三行正文、`#tag` 一行。
 *
 * 所有偏移照抄 `drawPageTexture`：标签基线 `y + 0.8em`，正文首行 `y + 1.55em`、
 * 行距 `0.95em`（这里的 em 是页面正文字号），正文左缩进 10px、右缩进 10px，
 * tag 行贴在卡片底边往上 8px。
 */
export function noteBlockLayout(
  box: PageTextureNoteBox,
  style: PageBlockStyle,
  tools: PageBlockTools,
): PageNoteLayout {
  const base = Math.max(8, style.fontSize)
  const labelSize = Math.max(8, base * 0.56)
  const bodySize = Math.max(9, base * 0.82)
  const tagSize = Math.max(8, base * 0.58)
  const runs: PageTextRun[] = [{
    role: 'note-label',
    text: box.note.source === 'ai' ? '笔记 · AI' : '笔记',
    x: box.x + 10,
    baseline: box.y + base * 0.8,
    fontSize: labelSize,
  }]
  tools.wrap(box.note.text, bodySize, box.width - 20).slice(0, 3).forEach((text, index) => {
    runs.push({
      role: 'note-body',
      text,
      x: box.x + 10,
      baseline: box.y + base * 1.55 + index * base * 0.95,
      fontSize: bodySize,
    })
  })
  if (box.note.tags?.length) {
    runs.push({
      role: 'note-tags',
      text: box.note.tags.map((tag) => `#${tag}`).join(' '),
      x: box.x + 10,
      baseline: box.y + box.height - 8,
      fontSize: tagSize,
    })
  }
  return {
    id: box.note.id,
    note: box.note,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    runs,
  }
}

/**
 * 图片块：图像本身按 contain 装进 box（DOM 里交给 `object-fit: contain`），
 * 图注居中排在块下方 `0.72 行` 处，与画布同一套基线。
 */
export function imageBlockLayout(
  box: PageTextureImageBox,
  style: PageBlockStyle,
  tools: PageBlockTools,
): PageImageLayout {
  const base = Math.max(8, style.fontSize)
  const captionSize = Math.max(9, base * 0.6)
  const caption = box.caption || ''
  const captionRun = caption
    ? {
        role: 'image-caption' as const,
        text: caption,
        x: box.x + (box.width - tools.measure(caption, captionSize)) / 2,
        baseline: box.y + box.height + style.lineHeight * 0.72,
        fontSize: captionSize,
      }
    : null
  return {
    file: box.file,
    caption,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    captionRun,
  }
}
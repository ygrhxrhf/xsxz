/**
 * 源自 Infinite Reader（https://github.com/dracohu2025-cloud/infinite-reader）的
 * web/src/engine/readerKeyboard.ts，Apache-2.0。已修改：文件改名，接入 spbf 的真实书籍场景。
 * 许可文本见 third_party/infinite-reader/LICENSE，署名见 third_party/infinite-reader/NOTICE。
 */

/** Controls that own navigation keys must keep them (editing, sliders, menus, etc.). */
export function canPageFrom(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof Element)) return true
  if (target instanceof HTMLElement && target.isContentEditable) return false
  if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), dialog, [role="dialog"], [role="textbox"], [role="slider"], [role="spinbutton"], [role="combobox"], [role="listbox"], [role="menu"], [role="tree"], [role="grid"], [role="tablist"]')) return false
  // Space still activates a focused button/link instead of also turning a page.
  if (key === ' ' && target.closest('button, a, [role="button"]')) return false
  // The non-modal miniature never owns horizontal arrows, even with its canvas focused.
  if ((key === 'ArrowLeft' || key === 'ArrowRight') && target.closest('[data-atlas-dock]')) return true
  if (!target.closest('[data-ui]')) return true
  // Closing a reader control often restores focus here. These buttons don't own
  // arrow keys; their retained focus must not disable reader navigation.
  return !!target.closest('.reader-dock:not([data-menu]) button, .footnote-hit, .inline-note-hit, .inline-note-tag-hit, .inline-note-link-hit')
}

export function pageKeyDirection(key: string, shift: boolean): 1 | -1 | null {
  if (key === 'ArrowRight' || key === 'PageDown') return 1
  if (key === 'ArrowLeft' || key === 'PageUp') return -1
  if (key === ' ') return shift ? -1 : 1
  return null
}
/** Runs only in the visible browsing webContents. No Node APIs or page-provided strings. */
export const READ_SCROLL = `(() => {
  const nodes = [document.scrollingElement, ...document.querySelectorAll('main, article, [class*=content], [class*=read]')].filter(Boolean);
  const scrollable = nodes.filter(el => el.scrollHeight > el.clientHeight + 40);
  const el = scrollable.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0] || document.scrollingElement;
  return el ? Math.max(0, Math.min(1, el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight))) : 0;
})()`

export function restoreScrollScript(ratio: number): string { return `(() => {
  const nodes = [document.scrollingElement, ...document.querySelectorAll('main, article, [class*=content], [class*=read]')].filter(Boolean);
  const scrollable = nodes.filter(el => el.scrollHeight > el.clientHeight + 40);
  const el = scrollable.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0] || document.scrollingElement;
  if (el) el.scrollTop = Math.max(0, Math.min(1, ${Math.max(0, Math.min(1, ratio))})) * Math.max(0, el.scrollHeight - el.clientHeight);
})()` }

export const START_HIDE = `(() => {
  if (window.__spbfPicker?.active) return window.__spbfPicker.stack.length;
  const state = window.__spbfPicker || { stack: [], active: false, hover: null, oldOutline: '' };
  window.__spbfPicker = state;
  const allowed = el => el && !['HTML', 'BODY', 'HEAD'].includes(el.tagName) && el !== document.documentElement;
  const move = event => {
    const el = event.target;
    if (!allowed(el) || el === state.hover) return;
    if (state.hover) state.hover.style.outline = state.oldOutline;
    state.hover = el;
    state.oldOutline = el.style.outline;
    el.style.outline = '2px solid #d65b35';
  };
  const click = event => {
    const el = event.target;
    if (!allowed(el)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (state.hover) { state.hover.style.outline = state.oldOutline; state.hover = null; }
    state.stack.push([el, el.style.display]);
    el.style.setProperty('display', 'none', 'important');
  };
  state.move = move; state.click = click; state.active = true;
  document.addEventListener('mouseover', move, true);
  document.addEventListener('click', click, true);
  return state.stack.length;
})()`

export const STOP_HIDE = `(() => {
  const state = window.__spbfPicker;
  if (!state) return 0;
  if (state.hover) { state.hover.style.outline = state.oldOutline; state.hover = null; }
  if (state.active) {
    document.removeEventListener('mouseover', state.move, true);
    document.removeEventListener('click', state.click, true);
    state.active = false;
  }
  return state.stack.length;
})()`

export const UNDO_HIDE = `(() => {
  const state = window.__spbfPicker;
  const last = state?.stack.pop();
  if (last) last[0].style.display = last[1];
  return state?.stack.length || 0;
})()`

export const CLEAR_HIDE = `(() => {
  const state = window.__spbfPicker;
  if (!state) return 0;
  if (state.hover) state.hover.style.outline = state.oldOutline;
  if (state.active) {
    document.removeEventListener('mouseover', state.move, true);
    document.removeEventListener('click', state.click, true);
  }
  for (const [el, display] of state.stack.reverse()) el.style.display = display;
  window.__spbfPicker = null;
  return 0;
})()`

export const COUNT_HIDE = `window.__spbfPicker?.stack.length || 0`

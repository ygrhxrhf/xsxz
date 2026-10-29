// 真实鼠标点击的公共封装：先确认 elementFromPoint 真的命中目标（被遮罩挡住就不点）。
export function centerExpr(sel, prefer = 'center') {
  return `(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
    const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0; }) || els[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.x + r.width / 2);
    const cy = ${prefer === 'top' ? 'Math.round(r.y + Math.min(18, r.height / 2))' : 'Math.round(r.y + r.height / 2)'};
    const hit = document.elementFromPoint(cx, cy);
    return { cx, cy, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
             text: (el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,60),
             label: el.getAttribute('aria-label'),
             hit: hit ? hit.tagName + '.' + (hit.className||'').toString().split(' ')[0] : null,
             hitOk: !!(hit && (hit === el || el.contains(hit))) };
  })()`
}

export async function clickVerified(c, sel, opts = {}) {
  const info = await c.evaluate(centerExpr(sel, opts.prefer))
  if (!info) return { ok: false, reason: 'not-found', sel }
  if (!info.hitOk) return { ok: false, reason: 'covered', sel, info }
  await c.click(info.cx, info.cy)
  return { ok: true, info }
}

// 关掉可能挡住的抽屉/弹层：优先点抽屉右上关闭按钮，其次 Escape。
export async function dismissOverlays(c, log) {
  for (let i = 0; i < 3; i++) {
    const mask = await c.evaluate(`document.querySelectorAll('.n-drawer-mask, .n-modal-mask').length`)
    if (!mask) return
    const close = await c.evaluate(centerExpr('.n-drawer-header__close, .n-base-close'))
    if (close && close.hitOk) {
      await c.click(close.cx, close.cy)
      log?.push({ dismissed: 'close-button', close })
    } else {
      await c.key('Escape', 'Escape', 27)
      log?.push({ dismissed: 'escape' })
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}

// OP-1R 定稿采集：展开工具 → 回书库 → 重入，逐步截图、state json、无障碍树。
// 只发 CDP 原生鼠标事件，只读读取样式与几何，不改产品、不写 DOM。
import { connect, READ_STATE } from './_cdp-lib.mjs'
import fs from 'node:fs'

const PAGE = 'ws://127.0.0.1:37482/devtools/page/D21CCF805C96AEC923114C7C61777D66'
const c = await connect(PAGE)

const read = (st) => {
  const t = st.readerElements.find((e) => e.class.includes('reader-toolbar'))
  const b = st.readerElements.find((e) => e.class.includes('reader-bottombar'))
  const sp = st.readerElements.find((e) => e.class === 'reader-spine')
  return {
    capturedAt: st.capturedAt, title: st.title, url: st.url, shell: st.shellClass, size: st.size,
    scroll: st.scroll, chapterTitle: st.chapterTitle,
    toolbar: { class: t.class, visibility: t.visibility, opacity: t.opacity, height: t.rect.height, rect: t.rect, ariaHidden: t.ariaHidden, inert: t.inert, text: t.text },
    bottombar: { class: b.class, visibility: b.visibility, opacity: b.opacity, rect: b.rect, ariaHidden: b.ariaHidden, inert: b.inert, text: b.text },
    buttons: st.readerElements.filter((e) => e.class === 'bottom-button').map((e) => ({ text: e.text, visibility: e.visibility, opacity: e.opacity, height: e.rect.height, rect: e.rect })),
    spine: { text: sp.text, rect: sp.rect, visibility: sp.visibility, opacity: sp.opacity },
    visibleParagraphs: st.visibleParagraphs,
    bodyText: st.bodyText,
    libraryCards: st.libraryCards,
  }
}

const save = async (tag) => {
  const st = await c.evaluate(READ_STATE)
  const rec = read(st)
  fs.writeFileSync(`${tag}-state.json`, JSON.stringify(rec, null, 2))
  await c.shot(`${tag}.png`)
  const nodes = await c.ax()
  fs.writeFileSync(`${tag}-ax.json`, JSON.stringify(nodes, null, 2))
  const names = nodes.filter((n) => n.role?.value === 'button' && n.name?.value).map((n) => n.name.value)
  fs.writeFileSync(`${tag}-ax-excerpt.txt`, names.slice(0, 40).join('\n'))
  return { rec, names }
}

const brief = (r) => ({
  toolbar: [r.toolbar.class, r.toolbar.visibility, r.toolbar.opacity, r.toolbar.height, r.toolbar.ariaHidden],
  bottombar: [r.bottombar.class, r.bottombar.visibility, r.bottombar.opacity, r.bottombar.ariaHidden],
  buttons: r.buttons.map((b) => [b.text, b.visibility, b.opacity, b.height]),
  spine: [r.spine.visibility, r.spine.rect],
  visibleParagraphs: r.visibleParagraphs.length,
})

const timeline = []
const push = (phase, r) => { timeline.push({ phase, at: r.capturedAt, ...brief(r) }) }

// 起点：应为重入后的隐藏态
const start = await c.evaluate(READ_STATE)
push('start', read(start))
console.log('START', JSON.stringify(brief(read(start)).toolbar))

// 步骤 1：点正文横向中间三分之一，让顶栏和右侧胶囊出现
const pane = await c.evaluate(`(() => { const r = document.querySelector('.reader-pane').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })()`)
const midX = Math.round(pane.x + pane.w / 2)
const midY = Math.round(pane.y + pane.h / 2)
await c.click(midX, midY)
await new Promise((r) => setTimeout(r, 900))
const before = await save('OP-1R-before')
push('before/工具已展开', before.rec)
console.log('PANE', JSON.stringify(pane), 'CLICK', midX, midY)
console.log('BEFORE', JSON.stringify(brief(before.rec)))

// 步骤 2：点左侧书脊回书库
const spine = before.rec.spine.rect
await c.click(Math.round(spine.x + spine.width / 2), Math.round(spine.y + spine.height / 2))
await new Promise((r) => setTimeout(r, 1100))
const library = await save('OP-1R-library')
push('library/已回书库', library.rec)
const card = library.rec.libraryCards.find((k) => (k.label || '').includes('打开《样例·长夜行舟》'))
console.log('LIBRARY', JSON.stringify({ shell: library.rec.shell, cards: library.rec.libraryCards }))

// 步骤 3：点同一本书书卡重入阅读页；按时间序列采样，等稳定终态后再截图
const cx = card.rect.x + Math.round(card.rect.width / 2)
const cy = card.rect.y + Math.round(card.rect.height / 2)
const t0 = Date.now()
await c.click(cx, cy)
for (const wait of [0, 300, 800, 1500, 2500, 4000]) {
  const target = t0 + wait
  const now = Date.now()
  if (target > now) await new Promise((r) => setTimeout(r, target - now))
  push(`after+${wait}ms`, read(await c.evaluate(READ_STATE)))
}
const after = await save('OP-1R-after')
push('after/重入后', after.rec)
console.log('CARD', JSON.stringify(card.label), 'CLICK', cx, cy)
console.log('AFTER', JSON.stringify(brief(after.rec)))
console.log('AFTER ax buttons(目录/进度/背景/字体/书架/搜索/标记/朗读/AI/设置/浏览):',
  JSON.stringify(['目录', '进度', '背景', '字体', '书架', '搜索', '标记', '朗读', 'AI', '设置', '浏览'].map((w) => [w, after.names.filter((n) => n === w).length])))
console.log('AFTER visPara', JSON.stringify(after.rec.visibleParagraphs.slice(0, 2)))
fs.writeFileSync('OP-1R-timeline.json', JSON.stringify({ page: PAGE, pane, clicks: { reveal: [midX, midY], spine: [Math.round(spine.x + spine.width / 2), Math.round(spine.y + spine.height / 2)], card: [cx, cy] }, cardLabel: card.label, timeline }, null, 2))
for (const row of timeline) console.log(row.phase.padEnd(18), JSON.stringify(row.toolbar), JSON.stringify(row.bottombar), JSON.stringify(row.buttons.map((b) => b[1])), 'para', row.visibleParagraphs)
c.close()

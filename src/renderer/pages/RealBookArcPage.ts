/**
 * 实验组件：用 SVG 二维分段把正文画在书脊弧面上。
 *
 * 与 `RealBookStage.vue` 完全解耦，确认效果后再谈合并。
 *
 * ## 为什么完全不用 SFC 模板
 *
 * Vue 的模板编译器在解析含 SVG 的模板时反复报「Invalid end tag」——即使模板本身
 * 是合法 XML。实测三次不同的写法都在 `</g>` / `</div>` 处失败。这里彻底绕开模板：
 * 用一个 render 函数 + `h()`，SVG 子节点交给 `createElementNS` 建树。
 * 好处不止绕开解析：每个 `<text>` 都是真实文本节点，能被选中、能挂 `data-p`、读屏可读。
 *
 * ## 为什么每段一个 <text> 加 textLength
 *
 * `textLength` + `lengthAdjust="spacingAndGlyphs"` 把这一截文字横向压/拉到指定宽度。
 * 弧面靠脊的纸被压短，字就跟着等比例变窄——这正是「字顺着纸弯下去」。
 */
import { computed, defineComponent, h, nextTick, onMounted, ref, watch } from 'vue'
import { measureLines } from './realBookMeasure'
import { arcHighlightFill, arcLineSegments, layoutArcRuns, type ArcRange } from './realBookArcText'

const SVG_NS = 'http://www.w3.org/2000/svg'

export default defineComponent({
  name: 'RealBookArcPage',
  props: {
    paragraphs: { type: Array as () => string[], required: true },
    paragraphIndexes: { type: Array as () => number[], required: true },
    /** 每段的搜索命中／划线区间（段内字符偏移），与经典模式同一套局部坐标 */
    paragraphRanges: { type: Array as () => ArcRange[][], default: () => [] },
    chapterTitle: { type: String, default: '' },
    pageNumber: { type: Number, default: 0 },
    contentWidth: { type: Number, default: 420 },
    pageHeight: { type: Number, default: 640 },
    fontSize: { type: Number, default: 18 },
    lineHeight: { type: Number, default: 32 },
    fontFamily: { type: String, default: 'serif' },
    paddingX: { type: Number, default: 36 },
    paddingY: { type: Number, default: 34 },
    /** 谷区宽度（px）：从书脊向外这一段纸是弯的 */
    valleyWidth: { type: Number, default: 190 },
    /** 谷底倾角（deg） */
    valleyDeg: { type: Number, default: 28 },
    /** 谷底基线最大下沉（px） */
    dipPx: { type: Number, default: 10 },
    /** 每行切成几段 */
    segments: { type: Number, default: 8 },
    /** 书脊在页面的哪一侧 */
    spineAt: { type: String as () => 'left' | 'right', default: 'left' },
  },
  setup(props) {
    const measureRef = ref<HTMLElement | null>(null)
    const svgRef = ref<SVGSVGElement | null>(null)

    function rebuild(): void {
      const svg = svgRef.value
      const measureEl = measureRef.value
      if (!svg || !measureEl) return
      while (svg.firstChild) svg.removeChild(svg.firstChild)

      const bands = arcLineSegments({
        pageWidth: props.contentWidth,
        valleyWidth: props.valleyWidth,
        valleyDeg: props.valleyDeg,
        dipPx: props.dipPx,
        segments: props.segments,
        spineAt: props.spineAt as 'left' | 'right',
      })

      let cursorY = props.paddingY + props.lineHeight
      props.paragraphs.forEach((text, index) => {
        const original = props.paragraphIndexes[index] ?? index
        const ranges = props.paragraphRanges[index] ?? []
        const group = document.createElementNS(SVG_NS, 'g')
        // 一个段落 = 一个 data-p 组：selectionOffsets 用 closest('[data-p]') 找段落，
        // 再在该元素内累加文本长度算偏移，所以同段的所有 <text> 必须都在这一组里且顺序正确。
        group.setAttribute('data-p', String(original))
        group.setAttribute('transform', `translate(${props.paddingX}, 0)`)

        for (const line of measureLines(text, measureEl)) {
          const slice = text.slice(line.start, line.end)
          // 高亮／命中的切点与弧面分段取并集：高亮能精确到字，宽度仍由弧面给定。
          for (const run of layoutArcRuns(slice, line.start, bands, ranges)) {
            const node = document.createElementNS(SVG_NS, 'text')
            node.setAttribute('x', run.x.toFixed(2))
            node.setAttribute('y', (cursorY + run.dip).toFixed(2))
            node.setAttribute('font-size', String(props.fontSize))
            node.setAttribute('font-family', props.fontFamily)
            node.setAttribute('textLength', run.width.toFixed(2))
            node.setAttribute('lengthAdjust', 'spacingAndGlyphs')
            node.textContent = run.text
            if (run.kind === 'hit') {
              node.setAttribute('class', 'arc-hit')
              node.setAttribute('fill', 'rgba(242, 176, 60, 0.55)')
            } else if (run.kind === 'hl') {
              node.setAttribute('class', 'arc-hl')
              node.setAttribute('fill', arcHighlightFill(run.color))
            }
            group.appendChild(node)
          }
          cursorY += props.lineHeight
        }
        svg.appendChild(group)
      })
    }

    onMounted(() => { void nextTick(rebuild) })
    watch(
      () => [props.paragraphs, props.paragraphIndexes, props.paragraphRanges, props.contentWidth, props.valleyWidth, props.valleyDeg, props.dipPx, props.segments, props.spineAt],
      () => { void nextTick(rebuild) },
      { deep: true },
    )

    const pageStyle = computed(() => ({
      position: 'relative' as const,
      background: 'var(--arc-paper, #f7f2e4)',
      color: 'var(--arc-ink, #2f2a24)',
      boxShadow: '0 8px 24px rgba(38, 24, 12, 0.28)',
      overflow: 'hidden' as const,
      width: `${props.contentWidth + props.paddingX * 2}px`,
      height: `${props.pageHeight}px`,
    }))

    return () => h('div', { class: 'arc-page', style: pageStyle.value }, [
      h('div', {
        ref: measureRef,
        class: 'arc-measure',
        'aria-hidden': 'true',
        style: {
          position: 'absolute',
          left: '-10000px',
          top: '0',
          visibility: 'hidden',
          width: `${props.contentWidth}px`,
          fontSize: `${props.fontSize}px`,
          lineHeight: `${props.lineHeight}px`,
          fontFamily: props.fontFamily,
          textIndent: '2em',
        },
      }),
      h('header', {
        class: 'arc-head',
        style: {
          position: 'absolute', left: '0', right: '0', textAlign: 'center',
          top: `${Math.round(props.paddingY * 0.35)}px`, fontSize: '12px',
          letterSpacing: '0.08em', opacity: '0.5', pointerEvents: 'none',
        },
      }, props.chapterTitle),
      h('svg', {
        ref: svgRef,
        class: 'arc-svg',
        width: props.contentWidth + props.paddingX * 2,
        height: props.pageHeight,
        viewBox: `0 0 ${props.contentWidth + props.paddingX * 2} ${props.pageHeight}`,
        role: 'group',
        'aria-label': props.chapterTitle || '书页',
        style: { position: 'absolute', inset: '0', display: 'block', fill: 'currentColor' },
      }),
      h('footer', {
        class: 'arc-foot',
        style: {
          position: 'absolute', left: '0', right: '0', textAlign: 'center',
          bottom: `${Math.round(props.paddingY * 0.35)}px`, fontSize: '12px',
          letterSpacing: '0.08em', opacity: '0.5', pointerEvents: 'none',
        },
      }, props.pageNumber ? String(props.pageNumber) : ''),
    ])
  },
})

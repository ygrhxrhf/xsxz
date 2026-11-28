// @vitest-environment jsdom
import { createApp, h } from 'vue'
import { describe, expect, it } from 'vitest'
import { escapeHtml, ReaderMarkdown, renderMarkdownHtml, safeLinkHref } from './readerMarkdown'
import { parseNoteMarkdown } from './referenceBook/noteMarkdown'

function mountMarkdown(source: string): HTMLElement {
  const host = document.createElement('div')
  const app = createApp({ render: () => h(ReaderMarkdown, { source }) })
  app.mount(host)
  return host
}

/**
 * 回答渲染的安全与格式：模型输出是不可信内容，
 * 这里既验证 Markdown 真的被渲染成格式，也验证内嵌 HTML 不会被执行。
 */
describe('AI 回答的 Markdown 渲染', () => {
  it('把 **加粗** 与 - 列表渲染成真正的标签，而不是露出星号', () => {
    const html = renderMarkdownHtml('**用法**\n\n- 属于拟声词\n- 可作定语')
    expect(html).toContain('<strong>用法</strong>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>属于拟声词</li>')
    expect(html).not.toContain('**')
  })

  it('有序列表保留真实编号结构', () => {
    const html = renderMarkdownHtml('1. 指人说话声音细碎\n2. 形容爱说话')
    expect(html).toContain('<ol>')
    expect(html.match(/<li>/g)).toHaveLength(2)
  })

  it('不执行内嵌 HTML，只按文本转义', () => {
    const html = renderMarkdownHtml('<img src=x onerror="alert(1)">')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('onerror="alert(1)"')
  })

  it('危险协议的链接被降级成纯文字', () => {
    expect(safeLinkHref('javascript:alert(1)')).toBeNull()
    expect(safeLinkHref('https://example.com')).toBe('https://example.com')
    const html = renderMarkdownHtml('[点我](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('点我')
  })

  it('流式生成中的不完整 Markdown 不抛错', () => {
    expect(() => renderMarkdownHtml('**用法')).not.toThrow()
    expect(renderMarkdownHtml('```js\nconst a = 1')).toContain('<pre')
  })

  it('空内容返回空串，不产出空标签', () => {
    expect(renderMarkdownHtml('')).toBe('')
    expect(renderMarkdownHtml('   ')).toBe('')
  })

  it('行内代码与代码块分别渲染', () => {
    const html = renderMarkdownHtml('用 `code` 表示\n\n```\nblock\n```')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('md-pre')
  })

  it('表格渲染成 table', () => {
    const html = renderMarkdownHtml('| 词 | 义 |\n| --- | --- |\n| 唧唧 | 细语 |')
    expect(html).toContain('<table>')
    expect(html).toContain('<th>词</th>')
  })

  it('escapeHtml 覆盖五个危险字符', () => {
    expect(escapeHtml('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&#39;')
  })

  it('保留 h1 到 h6 原生多级标题层级（HTML 与 VNode 一致）', () => {
    const md = '# 一级\n\n## 二级\n\n### 三级\n\n###### 六级'
    const html = renderMarkdownHtml(md)
    expect(html).toContain('<h1>一级</h1>')
    expect(html).toContain('<h2>二级</h2>')
    expect(html).toContain('<h3>三级</h3>')
    expect(html).toContain('<h6>六级</h6>')

    const host = mountMarkdown(md)
    expect(host.querySelector('h1')?.textContent).toBe('一级')
    expect(host.querySelector('h2')?.textContent).toBe('二级')
    expect(host.querySelector('h3')?.textContent).toBe('三级')
    expect(host.querySelector('h6')?.textContent).toBe('六级')
  })

  it('支持引用式链接、引用式图片与链接 title 属性，并拦截危险协议引用', () => {
    const md = [
      '参见 [官方文档][doc] 与 [危险引用][evil]，配图 ![架构图][arch]。',
      '',
      '[doc]: https://example.com/docs "官方手册"',
      '[evil]: javascript:alert(1)',
      '[arch]: https://example.com/arch.png',
    ].join('\n')
    const html = renderMarkdownHtml(md)
    expect(html).toContain('<a href="https://example.com/docs" title="官方手册" target="_blank" rel="noreferrer noopener">官方文档</a>')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('危险引用')
    expect(html).toContain('<span class="md-image-alt">架构图</span>')

    const host = mountMarkdown(md)
    const link = host.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://example.com/docs')
    expect(link?.getAttribute('title')).toBe('官方手册')
    expect(host.querySelector('.md-image-alt')?.textContent).toBe('架构图')
  })

  it('支持 GFM 脚注引用与脚注定义（HTML、VNode 与书页批注）', () => {
    const md = '此词见于卷三[^note1]。\n\n[^note1]: 清代刻本注作「细语声」。'
    const html = renderMarkdownHtml(md)
    expect(html).toContain('<sup class="md-footnote-ref">[note1]</sup>')
    expect(html).toContain('class="md-footnote-def"')
    expect(html).toContain('清代刻本注作「细语声」。')

    const host = mountMarkdown(md)
    expect(host.querySelector('sup.md-footnote-ref')?.textContent).toBe('[note1]')
    expect(host.querySelector('.md-footnote-def .md-footnote-label')?.textContent).toBe('[note1]')
    expect(host.querySelector('.md-footnote-def .md-footnote-body')?.textContent).toBe('清代刻本注作「细语声」。')

    const noteBlocks = parseNoteMarkdown(md)
    expect(noteBlocks[0]?.runs.some((run) => run.sup && run.text === '[note1]')).toBe(true)
    expect(noteBlocks[1]?.runs.map((run) => run.text).join('')).toBe('[note1] 清代刻本注作「细语声」。')
  })

  it('支持表格列对齐、代码块语言标识、多段列表项与段落内软换行', () => {
    const md = [
      '| 左对齐 | 居中 | 右对齐 |',
      '| :--- | :---: | ---: |',
      '| 甲 | 乙 | 丙 |',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      '- 第一段',
      '',
      '  第二段',
      '',
      '首行文字',
      '次行文字',
    ].join('\n')
    const html = renderMarkdownHtml(md)
    expect(html).toContain('<th style="text-align: left">左对齐</th>')
    expect(html).toContain('<th style="text-align: center">居中</th>')
    expect(html).toContain('<td style="text-align: right">丙</td>')
    expect(html).toContain('<pre class="md-pre" data-lang="ts"><code class="language-ts"><span class="hljs-keyword">const</span> x = <span class="hljs-number">1</span></code></pre>')
    expect(html).toContain('<li>第一段<p>第二段</p></li>')
    expect(html).toContain('<p>首行文字<br>次行文字</p>')

    const host = mountMarkdown(md)
    expect(host.querySelectorAll('th')[1]?.style.textAlign).toBe('center')
    expect(host.querySelectorAll('td')[2]?.style.textAlign).toBe('right')
    expect(host.querySelector('pre.md-pre')?.getAttribute('data-lang')).toBe('ts')
    expect(host.querySelector('pre.md-pre code')?.className).toBe('language-ts')
    expect(host.querySelector('li p')?.textContent).toBe('第二段')
    expect(host.querySelectorAll('p br').length).toBeGreaterThanOrEqual(1)
  })
})

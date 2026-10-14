import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Browse toolbar and drawer contract', () => {
  it('uses two compact toolbar rows with inline navigation icons', async () => {
    const source = await readFile(new URL('./Browse.vue', import.meta.url), 'utf-8')
    expect(source).toContain('class="browser-nav-row"')
    expect(source).toContain('class="browser-action-row"')
    expect(source).toContain(':aria-label="state.loading ? \'停止加载\' : \'刷新\'"')
    expect(source).toContain('aria-label="网页地址"')
    expect(source).toContain('<span>{{ siteLabel }}</span>')
    expect(source).toContain("return host ? `当前站点：${host}` : '尚未打开网页'")
    expect(source.match(/class="browser-icon-button"/g)).toHaveLength(3)
    expect(source).toContain('type="primary"')
    expect(source).toContain('size="small" secondary')
    expect(source).toContain('class="browser-more"')
    expect(source).toContain('tertiary')
    expect(source).toContain('下载本书')
    expect(source).toContain('配置本站规则')
    expect(source).toContain('下载进度')
    expect(source).not.toContain('class="chrome')
  })

  it('routes one-shot errors through Naive UI messages instead of alerts', async () => {
    const source = await readFile(new URL('./Browse.vue', import.meta.url), 'utf-8')
    expect(source).toContain('const message = useMessage()')
    expect(source).toContain("message.warning('请先打开一个有效网址')")
    expect(source).toContain('message.error(res.message)')
    expect(source).toContain("message.error(res.message || '下载失败，请重新预览')")
    expect(source).not.toContain('window.alert')
  })

  it('keeps the 240px drawer and BrowserView pointer inset semantics', async () => {
    const source = await readFile(new URL('./Browse.vue', import.meta.url), 'utf-8')
    expect(source).toContain(':height="240"')
    expect(source).toContain('showPreview.value ? 430 : showProgress.value ? 240 : 0')
    expect(source).toContain('watch(showProgress, reportBounds)')
    expect(source).toContain('if (r.width < 8 || r.height < 8) return')
    expect(source).toContain('window.api.browse.setBounds({')
    expect(source).toContain('v-if="downloading"')
    expect(source).toContain('取消下载')
    expect(source).toContain('打开这本书')
  })
})

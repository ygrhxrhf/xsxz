// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import RealBookWebGLStage from './RealBookWebGLStage.vue'

afterEach(() => { document.body.innerHTML = '' })

describe('RealBookWebGLStage', () => {
  it('没有 WebGL 时明确回退，而不是留下空白舞台', async () => {
    const events: string[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({
      render: () => h(RealBookWebGLStage, {
        leftPage: null,
        rightPage: null,
        flipFrontPage: null,
        flipBackPage: null,
        onUnsupported: () => events.push('unsupported'),
      }),
    })
    app.mount(host)
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
    expect(events).toContain('unsupported')
    expect(document.querySelector('.real-book-webgl-fallback')?.textContent).toContain('WebGL 不可用')
    app.unmount()
  })

  it('暴露 paperEl 给父组件的三分区翻页', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    let stageRef: unknown = null
    const app = createApp({
      render: () => h(RealBookWebGLStage, {
        ref: (value: unknown) => { stageRef = value },
        leftPage: null,
        rightPage: null,
        flipFrontPage: null,
        flipBackPage: null,
      }),
    })
    app.mount(host)
    await nextTick()
    expect((stageRef as { paperEl?: HTMLElement | null } | null)?.paperEl).toBeInstanceOf(HTMLElement)
    app.unmount()
  })

  it('开合与俯仰操作分别向上报告，父组件底栏才能切换图标', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const opens: boolean[] = []
    const pitches: number[] = []
    let stageRef: unknown = null
    const app = createApp({
      render: () => h(RealBookWebGLStage, {
        ref: (value: unknown) => { stageRef = value },
        leftPage: null,
        rightPage: null,
        flipFrontPage: null,
        flipBackPage: null,
        'onUpdate:open': (value: boolean) => opens.push(value),
        'onUpdate:pitch': (value: number) => pitches.push(value),
      }),
    })
    app.mount(host)
    await nextTick()
    const stage = stageRef as { setOpen: (open: boolean) => void; setPitch: (value: number) => void }
    stage.setOpen(false)
    stage.setOpen(true)
    stage.setPitch(-10)
    expect(opens).toEqual([false, true])
    expect(pitches).toEqual([0])
    app.unmount()
  })
})

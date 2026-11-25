// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  QA_CONTEXT_STORAGE_KEY,
  emptyQaContextChips,
  hasQaContext,
  qaContextDirective,
  readQaContextChips,
  stripQaContextDirective,
  writeQaContextChips,
} from './readerQaContext'

/**
 * 参考范围指令是「读者告诉模型看什么」的全部实现，所以格式要钉死：
 * 一行、只列开着的项、顺序固定，全关时一个字都不加（说了会变成聊天记录里的噪声）。
 */

const OFF = { chapter: false, memory: false, notes: false }

afterEach(() => { localStorage.clear() })

describe('qaContextDirective', () => {
  it('全关返回空串，不装作附了东西', () => {
    expect(qaContextDirective(OFF)).toBe('')
  })

  it('三项全开按 本章原文 → 小说记忆 → 我的批注 排列', () => {
    expect(qaContextDirective({ chapter: true, memory: true, notes: true }))
      .toBe('【参考：本章原文 · 小说记忆 · 我的批注】')
  })

  it('单项与双项组合只列开着的项', () => {
    expect(qaContextDirective({ chapter: true, memory: false, notes: false })).toBe('【参考：本章原文】')
    expect(qaContextDirective({ chapter: false, memory: true, notes: false })).toBe('【参考：小说记忆】')
    expect(qaContextDirective({ chapter: false, memory: false, notes: true })).toBe('【参考：我的批注】')
    expect(qaContextDirective({ chapter: true, memory: false, notes: true })).toBe('【参考：本章原文 · 我的批注】')
    expect(qaContextDirective({ chapter: false, memory: true, notes: true })).toBe('【参考：小说记忆 · 我的批注】')
  })

  it('只有一行，且重复调用结果一致、不改入参', () => {
    const chips = { chapter: true, memory: true, notes: false }
    const first = qaContextDirective(chips)
    const second = qaContextDirective(chips)
    expect(first).toBe(second)
    expect(first.includes('\n'), '多行会把聊天记录撑成噪声').toBe(false)
    expect(chips).toEqual({ chapter: true, memory: true, notes: false })
  })

  it('hasQaContext 与拼接结果同进同退', () => {
    expect(hasQaContext(OFF)).toBe(false)
    expect(hasQaContext({ chapter: false, memory: false, notes: true })).toBe(true)
    expect(hasQaContext({ chapter: true, memory: false, notes: false })).toBe(true)
  })
})

describe('stripQaContextDirective', () => {
  it('剥掉末尾那一行，重问时不会叠成两行', () => {
    expect(stripQaContextDirective('玉印去了哪里？\n\n【参考：本章原文】')).toBe('玉印去了哪里？')
  })

  it('没有这行标记时原样返回', () => {
    expect(stripQaContextDirective('玉印去了哪里？')).toBe('玉印去了哪里？')
  })

  it('正文中间提到「【参考：…】」不动，那是读者自己的字', () => {
    const question = '书里的【参考：目录】是什么意思？'
    expect(stripQaContextDirective(question)).toBe(question)
  })

  it('整句就是那行标记时保留原句，不把问题抹成空串', () => {
    expect(stripQaContextDirective('【参考：本章原文】')).toBe('【参考：本章原文】')
  })
})

describe('参考范围的本地存储', () => {
  it('写进去再读回来是同一份', () => {
    writeQaContextChips({ chapter: true, memory: false, notes: true })
    expect(readQaContextChips()).toEqual({ chapter: true, memory: false, notes: true })
  })

  it('坏 JSON 回退全关', () => {
    localStorage.setItem(QA_CONTEXT_STORAGE_KEY, '{')
    expect(readQaContextChips()).toEqual(emptyQaContextChips())
  })

  it('字段类型不对回退全关：字符串 "yes" 不算打开', () => {
    localStorage.setItem(QA_CONTEXT_STORAGE_KEY, '{"chapter":"yes"}')
    expect(readQaContextChips()).toEqual(emptyQaContextChips())
  })

  it('数组、null 与多余字段都不会读成打开', () => {
    localStorage.setItem(QA_CONTEXT_STORAGE_KEY, '[true,true,true]')
    expect(readQaContextChips()).toEqual(emptyQaContextChips())
    localStorage.setItem(QA_CONTEXT_STORAGE_KEY, 'null')
    expect(readQaContextChips()).toEqual(emptyQaContextChips())
    localStorage.setItem(QA_CONTEXT_STORAGE_KEY, '{"chapter":true,"notes":true,"extra":true}')
    expect(readQaContextChips()).toEqual({ chapter: true, memory: false, notes: true })
  })

  it('没有存储时安静返回全关，不抛错拦住输入框', () => {
    expect(readQaContextChips(null)).toEqual(emptyQaContextChips())
    expect(() => writeQaContextChips({ chapter: true, memory: true, notes: true }, null)).not.toThrow()
  })
})

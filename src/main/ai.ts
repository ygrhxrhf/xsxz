import { safeStorage } from 'electron'
import type { AiChatMessage, AiCleanResult } from '../shared/types'

// ---------------------------------------------------------------------------
// OpenAI-compatible client
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatResponse {
  choices: { message: { content: string } }[]
}

async function chatCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, temperature: 0.3 }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`AI 请求失败 (${res.status}): ${text.slice(0, 200)}`)
  }
  const data: ChatResponse = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export interface AiConfig {
  baseUrl: string
  model: string
  apiKey: string
}

export function encryptApiKey(key: string): string {
  if (!key) return ''
  return safeStorage.encryptString(key).toString('base64')
}

export function decryptApiKey(enc: string): string {
  if (!enc) return ''
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return ''
  }
}

export async function cleanChapterBody(
  config: AiConfig,
  chapterTitle: string,
  body: string,
): Promise<AiCleanResult> {
  const prompt = `你是一个小说正文清理助手。请清理以下小说章节正文，去掉残留的导航文字（如"上一章"、"下一章"、"返回目录"）、广告推荐、网站水印、推荐阅读等内容，只保留小说正文本身。不要修改正文内容，不要添加内容，只删除非正文内容。

章节标题：${chapterTitle}

原文：
${body}

请直接返回清理后的正文，不要加任何解释。`

  const cleaned = await chatCompletion(config.baseUrl, config.apiKey, config.model, [
    { role: 'user', content: prompt },
  ])

  return { original: body, cleaned: cleaned.trim() }
}

export async function summarizeUpTo(
  config: AiConfig,
  bookTitle: string,
  chapterSummaries: { title: string; body: string }[],
): Promise<string> {
  const context = chapterSummaries
    .map((c) => `【${c.title}】\n${c.body.slice(0, 500)}`)
    .join('\n\n')

  const prompt = `你是一个小说追剧摘要助手。请根据以下已读章节内容，生成一份简洁的前情提要，帮助读者回忆剧情。不要剧透后续内容。控制在300字以内。

书名：《${bookTitle}》

已读章节：
${context}

请生成前情提要：`

  return chatCompletion(config.baseUrl, config.apiKey, config.model, [
    { role: 'user', content: prompt },
  ])
}

export async function translateText(
  config: AiConfig,
  text: string,
): Promise<string> {
  const prompt = `请将以下文本翻译成现代白话文。如果已经是白话文，则翻译成英文。只返回译文，不要解释。

原文：
${text}`

  return chatCompletion(config.baseUrl, config.apiKey, config.model, [
    { role: 'user', content: prompt },
  ])
}

export async function chatAboutBook(
  config: AiConfig,
  bookTitle: string,
  currentChapterTitle: string,
  currentChapterBody: string,
  catalogSummary: string,
  readSummary: string,
  messages: AiChatMessage[],
): Promise<string> {
  const systemPrompt = `你是一个小说阅读助手。你正在帮读者阅读《${bookTitle}》。

当前章节：${currentChapterTitle}

目录概览：
${catalogSummary}

${readSummary ? `已读摘要：\n${readSummary}` : '这是读者刚开始阅读。'}

当前章节内容（前2000字）：
${currentChapterBody.slice(0, 2000)}

请基于以上内容回答读者的问题。如果问题涉及未读内容，请说明你只知道到当前章节为止的内容。`

  const apiMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ]

  return chatCompletion(config.baseUrl, config.apiKey, config.model, apiMessages)
}

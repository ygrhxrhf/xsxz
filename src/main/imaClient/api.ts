/**
 * ima（腾讯 ima.copilot）OpenAPI 客户端。
 *
 * 与 mcpClient/ 平行、互不相干：ima 没有 MCP 端点，走官方 OpenAPI：
 *   POST https://ima.qq.com/<apiPath>，header 带 ima-openapi-clientid / ima-openapi-apikey。
 * 凭据只在本进程解密、只发往 ima.qq.com，绝不经 IPC 下发渲染层或写日志。
 */

const IMA_BASE_URL = 'https://ima.qq.com'

/** ima 的 apiPath：知识库走 openapi/wiki/v1/*，笔记走 openapi/note/v1/*。 */
export type ImaApiPath =
  | 'openapi/wiki/v1/search_knowledge'
  | 'openapi/wiki/v1/search_knowledge_base'
  | 'openapi/wiki/v1/get_knowledge_base'
  | 'openapi/wiki/v1/get_knowledge_list'
  | 'openapi/wiki/v1/get_addable_knowledge_base_list'
  | 'openapi/note/v1/search_note'
  | 'openapi/note/v1/list_note'
  | 'openapi/note/v1/list_notebook'
  | 'openapi/note/v1/get_doc_content'

export interface ImaCredentials {
  clientId: string
  apiKey: string
}

/** ima 统一响应：code=0 成功，其余把 msg 直接给用户看。 */
interface ImaEnvelope<T> {
  code: number
  msg: string
  data?: T
}

export class ImaApiError extends Error {
  constructor(
    readonly code: number | string,
    message: string,
  ) {
    super(message)
    this.name = 'ImaApiError'
  }
}

/**
 * 发一次 ima OpenAPI 请求。
 * 失败分两层：网络/非 JSON（抛 ImaApiError('network')）与业务 code≠0（抛 ImaApiError(code)）。
 */
export async function imaRequest<T = unknown>(
  path: ImaApiPath,
  body: Record<string, unknown>,
  credentials: ImaCredentials,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${IMA_BASE_URL}/${path}`, {
      method: 'POST',
      headers: {
        'ima-openapi-clientid': credentials.clientId,
        'ima-openapi-apikey': credentials.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    // 不回显 URL 以外的任何凭据；错误文案里只留原因，留给界面显示。
    throw new ImaApiError('network', `无法连接 ima 服务：${error instanceof Error ? error.message : String(error)}`)
  }

  const text = await response.text()
  let envelope: ImaEnvelope<T>
  try {
    envelope = JSON.parse(text) as ImaEnvelope<T>
  } catch {
    throw new ImaApiError('network', `ima 返回了无法解析的响应（HTTP ${response.status}）`)
  }
  if (typeof envelope?.code !== 'number') {
    throw new ImaApiError('network', `ima 响应格式异常（HTTP ${response.status}）`)
  }
  if (envelope.code !== 0) {
    // msg 是给人看的，原样抛出即可；不要自己翻译错误码。
    throw new ImaApiError(envelope.code, envelope.msg || `ima 返回错误码 ${envelope.code}`)
  }
  return (envelope.data ?? {}) as T
}

// ------------------------------ 知识库 ------------------------------

export interface ImaKnowledgeBaseInfo {
  id: string
  name: string
  cover_url?: string
  description?: string
}

export interface ImaSearchHit {
  media_id: string
  title: string
  parent_folder_id?: string
  /** 命中片段（仅内容匹配时返回），可直接做外部来源的摘要。 */
  highlight_content?: string
}

export async function imaSearchKnowledgeBases(
  query: string,
  credentials: ImaCredentials,
  signal?: AbortSignal,
): Promise<ImaKnowledgeBaseInfo[]> {
  const data = await imaRequest<{ info_list?: ImaKnowledgeBaseInfo[] }>(
    'openapi/wiki/v1/search_knowledge_base',
    { query, cursor: '', limit: 20 },
    credentials,
    signal,
  )
  return data.info_list ?? []
}

export async function imaListAddableKnowledgeBases(
  credentials: ImaCredentials,
  signal?: AbortSignal,
): Promise<ImaKnowledgeBaseInfo[]> {
  const data = await imaRequest<{ addable_knowledge_base_list?: ImaKnowledgeBaseInfo[] }>(
    'openapi/wiki/v1/get_addable_knowledge_base_list',
    { cursor: '', limit: 50 },
    credentials,
    signal,
  )
  return data.addable_knowledge_base_list ?? []
}

export async function imaSearchKnowledge(
  query: string,
  knowledgeBaseId: string,
  credentials: ImaCredentials,
  signal?: AbortSignal,
): Promise<ImaSearchHit[]> {
  const data = await imaRequest<{ info_list?: ImaSearchHit[]; is_end?: boolean }>(
    'openapi/wiki/v1/search_knowledge',
    { query, cursor: '', knowledge_base_id: knowledgeBaseId },
    credentials,
    signal,
  )
  return data.info_list ?? []
}

export async function imaListKnowledge(
  knowledgeBaseId: string,
  credentials: ImaCredentials,
  signal?: AbortSignal,
): Promise<Array<{ media_id?: string; title?: string; folder_id?: string; name?: string }>> {
  const data = await imaRequest<{ knowledge_list?: Array<Record<string, unknown>> }>(
    'openapi/wiki/v1/get_knowledge_list',
    { cursor: '', limit: 50, knowledge_base_id: knowledgeBaseId },
    credentials,
    signal,
  )
  const raw = data.knowledge_list ?? []
  return raw.map((item) => ({
    media_id: typeof item.media_id === 'string' ? item.media_id : undefined,
    title: typeof item.title === 'string' ? item.title : undefined,
    folder_id: typeof item.folder_id === 'string' ? item.folder_id : undefined,
    name: typeof item.name === 'string' ? item.name : undefined,
  }))
}

// ------------------------------ 笔记 ------------------------------

export interface ImaNoteHit {
  noteId: string
  title: string
  modifyTime?: number
}

/** 搜索笔记：从嵌套结构里取 note_book_info.note_id。 */
export async function imaSearchNotes(
  query: string,
  credentials: ImaCredentials,
  signal?: AbortSignal,
): Promise<ImaNoteHit[]> {
  const data = await imaRequest<{ search_note_infos?: Array<Record<string, unknown>> }>(
    'openapi/note/v1/search_note',
    { search_type: 0, query_info: { title: query }, start: 0, end: 20 },
    credentials,
    signal,
  )
  return normalizeNoteHits(data.search_note_infos)
}

export async function imaListNotes(
  credentials: ImaCredentials,
  signal?: AbortSignal,
): Promise<ImaNoteHit[]> {
  const data = await imaRequest<{ note_book_infos?: Array<Record<string, unknown>> }>(
    'openapi/note/v1/list_note',
    { folder_id: '', sort_type: 0, cursor: '', limit: 20 },
    credentials,
    signal,
  )
  return normalizeNoteHits(data.note_book_infos)
}

function normalizeNoteHits(items: Array<Record<string, unknown>> | undefined): ImaNoteHit[] {
  if (!Array.isArray(items)) return []
  const hits: ImaNoteHit[] = []
  for (const item of items) {
    const info = (item.note_book_info ?? item) as Record<string, unknown>
    const noteId = typeof info.note_id === 'string' ? info.note_id : ''
    const title = typeof info.title === 'string' ? info.title : ''
    if (!noteId) continue
    hits.push({
      noteId,
      title: title || noteId,
      ...(typeof info.modify_time === 'number' ? { modifyTime: info.modify_time } : {}),
    })
  }
  return hits
}

/** 读笔记正文（纯文本格式，ima 目前只支持 0 纯文本）。 */
export async function imaGetNoteContent(
  noteId: string,
  credentials: ImaCredentials,
  signal?: AbortSignal,
): Promise<string> {
  const data = await imaRequest<{ content?: string }>(
    'openapi/note/v1/get_doc_content',
    { note_id: noteId, target_content_format: 0 },
    credentials,
    signal,
  )
  return typeof data.content === 'string' ? data.content : ''
}
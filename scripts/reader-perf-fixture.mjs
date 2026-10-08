import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'spbf-reader-perf-'))
const library = join(root, 'library')
const bookDir = join(library, 'd_perf')
const chaptersDir = join(bookDir, 'chapters')
const configRoot = join(root, process.platform === 'win32' ? 'appdata' : 'config')
await mkdir(chaptersDir, { recursive: true })
await mkdir(join(configRoot, 'spbf'), { recursive: true })

const now = new Date().toISOString()
const body = Array.from({ length: 10_000 }, (_, i) =>
  `第 ${i + 1} 段 这是一段用于真实页面性能测量的中文正文。`.repeat(3),
).join('\n\n')
const progress = { chapterId: 'c0001', scrollRatio: 0, updatedAt: now }
const chapters = [
  { id: 'c0001', index: 1, title: '第一章', file: 'chapters/0001.json', status: 'ready' },
  { id: 'c0002', index: 2, title: '第二章', file: 'chapters/0002.json', status: 'ready' },
]
const book = {
  id: 'd_perf', title: '一万段性能样本', author: '本机测试', tags: [], importType: 'txt',
  createdAt: now, updatedAt: now, status: 'ready', chapters, progress,
}
const index = { version: 1, books: [{
  id: book.id, title: book.title, author: book.author, tags: [], importType: 'txt',
  status: 'ready', chapterCount: 2, readyCount: 2, progress, updatedAt: now,
}] }
const saveJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2))
await Promise.all([
  saveJson(join(bookDir, 'book.json'), book),
  saveJson(join(chaptersDir, '0001.json'), { title: '第一章', body, status: 'ready' }),
  saveJson(join(chaptersDir, '0002.json'), { title: '第二章', body: '第二章正常正文。\n\n后续段落。'.repeat(20), status: 'ready' }),
  saveJson(join(library, 'index.json'), index),
  saveJson(join(configRoot, 'spbf', 'settings.json'), { libraryPath: library }),
])
console.log(JSON.stringify({ root, library, configRoot, envName: process.platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME' }))

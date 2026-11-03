import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateAgentPaths } from './agentPaths'

let dir = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spbf-agent-paths-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('agent 路径参数预检', () => {
  it('拒绝相对路径：会被解析到应用的工作目录上', async () => {
    const issues = await validateAgentPaths({ filePath: 'books/a.txt' })
    expect(issues).toEqual([{ field: 'filePath', message: 'filePath 必须是绝对路径' }])
  })

  it('拒绝设备路径与 UNC 网络路径', async () => {
    const device = await validateAgentPaths({ zipPath: '\\\\?\\C:\\backup.zip' })
    expect(device[0]?.message).toContain('设备路径')
    const unc = await validateAgentPaths({ sourcePath: '\\\\nas\\share\\cover.png' })
    expect(unc[0]?.message).toContain('UNC')
  })

  it('接受绝对路径，不要求文件已存在（存在性由 handler 判定）', async () => {
    expect(await validateAgentPaths({ filePath: join(dir, 'not-there.txt') })).toEqual([])
  })

  it('destDir 允许叶子不存在（导出与备份会递归创建），但最近祖先必须可写', async () => {
    expect(await validateAgentPaths({ destDir: join(dir, 'backups', '2026') })).toEqual([])
    await writeFile(join(dir, 'file.txt'), 'x', 'utf-8')
    const issues = await validateAgentPaths({ destDir: join(dir, 'file.txt', 'nested') })
    expect(issues[0]?.message).toContain('文件而不是目录')
  })

  it('缺省与空字符串分别处理：缺省跳过，空串报错', async () => {
    expect(await validateAgentPaths({})).toEqual([])
    const issues = await validateAgentPaths({ targetPath: '   ' })
    expect(issues[0]?.message).toContain('空字符串')
  })
})

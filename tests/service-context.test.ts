import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { ContextDelegationService } from '../src/index.ts'
import { RecordingFileSystem } from './support/recording-file-system.ts'

describe('S2-5 Host ContextDelegationService.prepareContext', () => {
  function createTestEnvironment(workspaceRoot = '/workspace') {
    const ctx = new Context()
    const fs = new RecordingFileSystem(ctx)
    ctx.fs = fs
    fs.setDirectory(workspaceRoot)
    fs.setDirectory(`${workspaceRoot}/harness`)
    fs.setDirectory(`${workspaceRoot}/harness/context`)
    fs.setFile(`${workspaceRoot}/AGENTS.md`, '# Agents Rule')
    fs.setFile(`${workspaceRoot}/harness/context/CURRENT_STATE.md`, '# Current State')

    const service = new ContextDelegationService(ctx, {
      maxContextChars: 10_000,
    })

    return { ctx, fs, service }
  }

  it('throws WORKSPACE_NOT_FOUND when calling agent has no session cwd', async () => {
    const { service } = createTestEnvironment()
    const controller = new AbortController()

    const execution: any = {
      parent: undefined,
      signal: controller.signal,
    }

    await expect(service.prepareContext({ task: 'Do work' }, execution)).rejects.toThrow(
      '[WORKSPACE_NOT_FOUND]',
    )

    const executionNoCwd: any = {
      parent: { session: { header: {} } },
      signal: controller.signal,
    }

    await expect(service.prepareContext({ task: 'Do work' }, executionNoCwd)).rejects.toThrow(
      '[WORKSPACE_NOT_FOUND]',
    )
  })

  it('throws WORKSPACE_NOT_FOUND when session cwd is stale or not a directory', async () => {
    const { service } = createTestEnvironment()
    const signal = new AbortController().signal

    await expect(service.prepareContext(
      { task: 'Do work' },
      { parent: { session: { header: { cwd: '/missing' } } } as any, signal },
    )).rejects.toThrow('[WORKSPACE_NOT_FOUND]')
  })

  it('resolves workspace exactly matching Parent Session cwd and returns ContextLoadResult', async () => {
    const { service, fs } = createTestEnvironment('/my/custom/repo')
    fs.setFile('/my/custom/repo/src/code.ts', 'export const a = 1;')

    const controller = new AbortController()
    const execution: any = {
      parent: {
        session: {
          header: {
            cwd: '/my/custom/repo',
          },
        },
      },
      signal: controller.signal,
    }

    const result = await service.prepareContext(
      {
        task: 'Implement feature',
        relevant_files: ['src/code.ts'],
      },
      execution,
    )

    expect(result.relevantFiles).toEqual(['src/code.ts'])
    expect(result.context.workspaceRoot).toBe('/my/custom/repo')
    expect(result.context.files.some(f => f.id === 'agents')).toBe(true)
  })

  it('fails with CONTEXT_PATH_ESCAPE before context loading or Codex execution', async () => {
    const { service } = createTestEnvironment('/workspace')
    const controller = new AbortController()
    const execution: any = {
      parent: {
        session: {
          header: {
            cwd: '/workspace',
          },
        },
      },
      signal: controller.signal,
    }

    await expect(
      service.prepareContext(
        {
          task: 'Read outside',
          relevant_files: ['/etc/shadow'],
        },
        execution,
      ),
    ).rejects.toThrow('[CONTEXT_PATH_ESCAPE]')
  })

  it('propagates cancellation signal and throws CODEX_CANCELLED', async () => {
    const { service } = createTestEnvironment('/workspace')
    const controller = new AbortController()
    controller.abort()

    const execution: any = {
      parent: {
        session: {
          header: {
            cwd: '/workspace',
          },
        },
      },
      signal: controller.signal,
    }

    await expect(service.prepareContext({ task: 'Cancelled task' }, execution)).rejects.toThrow(
      '[CODEX_CANCELLED]',
    )
  })

  it('reports lifecycle readiness after the Block 3 gate passes', () => {
    const { service } = createTestEnvironment()
    expect(service.describe().readyForDelegation).toBe(true)
  })
})

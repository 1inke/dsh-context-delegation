import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { ContextDelegationError } from '../src/errors.ts'
import { apply } from '../src/tool.ts'
import type { DelegationResult } from '../src/types.ts'

const SUCCESS: DelegationResult = {
  success: true,
  provider: 'codex',
  workspaceRoot: '/workspace',
  contextFilesLoaded: ['AGENTS.md'],
  contextFilesMissing: [],
  contextFilesTruncated: [],
  contextChars: 10,
  runId: 'run-1',
  codexFinal: 'Implemented.',
  parentVerificationRequired: true,
}

function createEnvironment() {
  const ctx = new Context()
  const registeredTools: ToolDefinition[] = []
  const register = vi.fn((tool: ToolDefinition) => {
    registeredTools.push(tool)
    return () => undefined
  })
  const delegate = vi.fn(async () => SUCCESS)
  ctx.tools = { register } as any
  ctx.codexContextDelegation = {
    config: { toolName: 'codex_expert' },
    delegate,
  } as any

  apply(ctx)
  const tool = registeredTools.find(candidate => candidate.name === 'codex_expert')!
  return { tool, delegate, register, registeredTools }
}

function execution(agent: unknown = { session: { header: { cwd: '/workspace' } } }) {
  return {
    agent,
    signal: new AbortController().signal,
  } as any
}

describe('Block 4 scoped tool core', () => {
  it('registers exactly one configured codex_expert tool with the narrow V0.1 schema', () => {
    const { tool, registeredTools } = createEnvironment()
    const properties = (tool.parameters as any).properties as Record<string, unknown>

    expect(registeredTools.map(candidate => candidate.name).sort()).toEqual(['codex_expert', 'delegation_debug'])
    expect(tool.name).toBe('codex_expert')
    expect(Object.keys(properties).sort()).toEqual([
      'acceptance_criteria',
      'delegation_key',
      'mode',
      'notes',
      'relevant_files',
      'task',
      'verification_commands',
    ])
    expect(properties).not.toHaveProperty('provider')
    expect(properties).not.toHaveProperty('model')
    expect(properties).not.toHaveProperty('permissionMode')
    expect(properties).not.toHaveProperty('contextRoot')
    expect(properties).not.toHaveProperty('maxContextChars')
    expect(tool.isConcurrencySafe).toBeUndefined()
  })

  it('forwards the validated input plus exact parent and signal to the Host service', async () => {
    const { tool, delegate } = createEnvironment()
    const args = {
      task: 'Implement the feature',
      relevant_files: ['src/index.ts'],
      acceptance_criteria: ['Tests pass'],
      verification_commands: ['pnpm test'],
      notes: 'Stay scoped',
    }
    const exec = execution()

    const value = await tool.execute(args, exec)

    expect(value).toEqual(SUCCESS)
    expect(delegate).toHaveBeenCalledTimes(1)
    expect(delegate).toHaveBeenCalledWith(args, {
      parent: exec.agent,
      signal: exec.signal,
    })
  })

  it('rejects undeclared configuration-like fields before delegation', async () => {
    const { tool, delegate } = createEnvironment()

    await expect(tool.execute({ task: 'Work', provider: 'other', model: 'other' }, execution()))
      .rejects.toThrow('does not accept input field(s): model, provider')
    expect(delegate).not.toHaveBeenCalled()
  })

  it('rejects a blank task before delegation', async () => {
    const { tool, delegate } = createEnvironment()

    await expect(tool.execute({ task: '  \n ' }, execution()))
      .rejects.toThrow('requires a non-empty task')
    expect(delegate).not.toHaveBeenCalled()
  })

  it('requires an Agent-backed execution and renders the canonical success result', async () => {
    const { tool, delegate } = createEnvironment()
    let error: unknown
    try {
      await tool.execute(
        { task: 'Work' },
        { signal: new AbortController().signal } as any,
      )
    } catch (caught: unknown) {
      error = caught
    }

    expect(error).toBeInstanceOf(ContextDelegationError)
    expect((error as ContextDelegationError).code).toBe('WORKSPACE_NOT_FOUND')
    expect(delegate).not.toHaveBeenCalled()

    const rendered = tool.output.render({}, SUCCESS as any)
    expect(rendered).toHaveLength(1)
    expect(rendered[0]).toMatchObject({ type: 'text' })
    expect((rendered[0] as { type: 'text'; text: string }).text).toContain('Implemented.')
    expect((rendered[0] as { type: 'text'; text: string }).text)
      .toContain('parent agent must independently verify')
  })
})

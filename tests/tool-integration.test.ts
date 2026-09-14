import { Context } from '@deepseek-ai/cordis'
import {
  validateArgs,
  validateJsonSchemaValue,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { apply, CODEX_EXPERT_PARAMETERS } from '../src/tool.ts'
import type { DelegationResult } from '../src/types.ts'

const CANONICAL_SUCCESS: DelegationResult = {
  success: true,
  provider: 'codex',
  workspaceRoot: '/workspace/project',
  contextFilesLoaded: ['AGENTS.md', 'harness/context/CURRENT_STATE.md'],
  contextFilesMissing: ['harness/context/EXPERIMENTS.md'],
  contextFilesTruncated: ['harness/context/CURRENT_STATE.md'],
  contextChars: 2450,
  runId: 'run-integration-123',
  codexFinal: 'Successfully updated the target component.',
  parentVerificationRequired: true,
  contextWarning: 'Some context files were truncated due to budget constraints.',
  diagnostic: 'Provider latency: 1250ms',
}

function createTestHarness(customToolName?: string) {
  const ctx = new Context()
  const registeredTools: ToolDefinition[] = []
  const register = vi.fn((tool: ToolDefinition) => {
    registeredTools.push(tool)
    return () => undefined
  })
  const delegate = vi.fn(async () => CANONICAL_SUCCESS)

  ctx.tools = { register } as any
  ctx.codexContextDelegation = {
    config: {
      toolName: customToolName ?? 'codex_expert',
    },
    delegate,
  } as any

  apply(ctx)
  const tool = registeredTools.find(candidate => candidate.name === (customToolName ?? 'codex_expert'))!
  return { tool, delegate, register, ctx, registeredTools }
}

function mockExecution() {
  return {
    agent: { session: { header: { cwd: '/workspace/project' } } },
    signal: new AbortController().signal,
  } as any
}

describe('G4-1 Mechanical tool-contract expansion', () => {
  it('respects non-default validated config.toolName in registration and error messages', async () => {
    const customName = 'repo_specialist'
    const { tool, register } = createTestHarness(customName)

    expect(register).toHaveBeenCalledTimes(2)
    expect(tool.name).toBe(customName)

    // Blank task error uses the custom toolName
    await expect(tool.execute({ task: '   ' }, mockExecution())).rejects.toThrow(
      `${customName} requires a non-empty task`,
    )

    // Unknown fields error uses the custom toolName
    await expect(
      tool.execute({ task: 'Valid task', custom_field: 'illegal' }, mockExecution()),
    ).rejects.toThrow(`${customName} does not accept input field(s): custom_field`)

    // Missing Agent error uses the custom toolName
    await expect(
      tool.execute({ task: 'Valid task' }, { signal: new AbortController().signal } as any),
    ).rejects.toThrow(`${customName} requires an Agent-backed calling session`)
  })

  it('schema validation rejects wrong types for every declared parameter field', () => {
    // task: must be string
    expect(validateArgs(CODEX_EXPERT_PARAMETERS, { task: 12345 })).toContain(
      '"task" must be a string',
    )
    expect(validateArgs(CODEX_EXPERT_PARAMETERS, { task: null })).toContain(
      '"task" must be a string',
    )

    // relevant_files: must be array of strings
    expect(
      validateArgs(CODEX_EXPERT_PARAMETERS, {
        task: 'Do task',
        relevant_files: 'src/file.ts',
      }),
    ).toContain('"relevant_files" must be an array')
    expect(
      validateArgs(CODEX_EXPERT_PARAMETERS, {
        task: 'Do task',
        relevant_files: [123],
      }),
    ).toContain('"relevant_files[0]" must be a string')

    // acceptance_criteria: must be array of strings
    expect(
      validateArgs(CODEX_EXPERT_PARAMETERS, {
        task: 'Do task',
        acceptance_criteria: true,
      }),
    ).toContain('"acceptance_criteria" must be an array')
    expect(
      validateArgs(CODEX_EXPERT_PARAMETERS, {
        task: 'Do task',
        acceptance_criteria: [false],
      }),
    ).toContain('"acceptance_criteria[0]" must be a string')

    // verification_commands: must be array of strings
    expect(
      validateArgs(CODEX_EXPERT_PARAMETERS, {
        task: 'Do task',
        verification_commands: 42,
      }),
    ).toContain('"verification_commands" must be an array')
    expect(
      validateArgs(CODEX_EXPERT_PARAMETERS, {
        task: 'Do task',
        verification_commands: [{}],
      }),
    ).toContain('"verification_commands[0]" must be a string')

    // notes: must be string
    expect(
      validateArgs(CODEX_EXPERT_PARAMETERS, {
        task: 'Do task',
        notes: ['note'],
      }),
    ).toContain('"notes" must be a string')

    // Valid argument payload produces zero violations
    expect(
      validateArgs(CODEX_EXPERT_PARAMETERS, {
        task: 'Do task',
        relevant_files: ['src/index.ts', 'src/util.ts'],
        acceptance_criteria: ['Coverage > 90%'],
        verification_commands: ['pnpm test'],
        notes: 'Follow existing conventions',
      }),
    ).toEqual([])
  })

  it('preserves array ordering for all optional arrays and passes them directly to delegate()', async () => {
    const { tool, delegate } = createTestHarness()
    const exec = mockExecution()

    const orderedInput = {
      task: 'Sequential execution test',
      relevant_files: ['z.ts', 'a.ts', 'm.ts', 'b.ts'],
      acceptance_criteria: ['Criterion 3', 'Criterion 1', 'Criterion 2'],
      verification_commands: ['cmd-c', 'cmd-a', 'cmd-b'],
      notes: 'Ensure ordering is untouched',
    }

    const result = await tool.execute(orderedInput, exec)

    expect(result).toEqual(CANONICAL_SUCCESS)
    expect(delegate).toHaveBeenCalledTimes(1)
    const callArgs = delegate.mock.calls as unknown as Array<[any, any]>
    const forwardedArgs = callArgs[0]![0]

    expect(forwardedArgs.relevant_files).toEqual(['z.ts', 'a.ts', 'm.ts', 'b.ts'])
    expect(forwardedArgs.acceptance_criteria).toEqual([
      'Criterion 3',
      'Criterion 1',
      'Criterion 2',
    ])
    expect(forwardedArgs.verification_commands).toEqual(['cmd-c', 'cmd-a', 'cmd-b'])
  })

  it('validates canonical success output and renders optional warning and diagnostic', () => {
    const { tool } = createTestHarness()

    expect(validateJsonSchemaValue(tool.output.schema, CANONICAL_SUCCESS)).toEqual([])
    expect(
      validateJsonSchemaValue(tool.output.schema, {
        ...CANONICAL_SUCCESS,
        unexpected: true,
      }),
    ).toContain('"value.unexpected" is not a declared property (additionalProperties: false)')
    const { codexFinal: _omitted, ...missingRequiredOutput } = CANONICAL_SUCCESS
    expect(validateJsonSchemaValue(tool.output.schema, missingRequiredOutput)).toContain(
      'missing required property "value.codexFinal"',
    )

    const renderedBlocks = tool.output.render({}, CANONICAL_SUCCESS as any)
    expect(renderedBlocks).toHaveLength(1)
    const block = renderedBlocks[0] as { type: 'text'; text: string }
    expect(block.type).toBe('text')

    // Renders final text
    expect(block.text).toContain('Successfully updated the target component.')
    // Renders verification warning
    expect(block.text).toContain('parent agent must independently verify')
    // Renders context warning when present
    expect(block.text).toContain('Some context files were truncated due to budget constraints.')
    // Renders the bounded provider diagnostic when present
    expect(block.text).toContain('Provider latency: 1250ms')
  })

  it('registers exactly one tool from source and contains no codex_context_spike', () => {
    const { register, tool } = createTestHarness()
    expect(register).toHaveBeenCalledTimes(2)
    expect(tool.name).toBe('codex_expert')
    expect(tool.name).not.toBe('codex_context_spike')
    expect(tool.description).not.toContain('spike')
    expect(tool.description).not.toContain('probe')
  })
})

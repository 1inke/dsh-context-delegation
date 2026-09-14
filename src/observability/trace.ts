import { randomUUID } from 'node:crypto'
import type { DelegationTrace, DelegationTraceEvent, TraceStage } from '../types.ts'

/**
 * Process-local delegation tracing (roadmap V0.7). Traces carry ONLY
 * plugin-generated metadata — never executor final text, verification
 * output, evidence file names, review reasons, error payloads, or reasoning.
 * Retention is a bounded ring buffer; nothing is persisted to disk.
 */

const TRACE_RETENTION = 20
const MAX_TASK_PREFIX_CHARS = 200

const ring: DelegationTrace[] = []

/** Internal mutable view over the readonly public trace surface. */
type MutableTrace = { -readonly [K in keyof DelegationTrace]: DelegationTrace[K] }

export interface DelegationTraceRecorder {
  readonly traceId: string
  record(stage: TraceStage, detail?: DelegationTraceEvent['detail']): void
  setSelectedContextChars(chars: number): void
  finish(outcome: NonNullable<DelegationTrace['outcome']>, fields?: {
    contextRevision?: string
    contextMode?: DelegationTrace['contextMode']
  }): void
}

export function startDelegationTrace(options: {
  task: string
  executor: string
  reviewer?: string
}): DelegationTraceRecorder {
  const startedAt = Date.now()
  const trace: MutableTrace = {
    traceId: randomUUID(),
    taskId: options.task.slice(0, MAX_TASK_PREFIX_CHARS),
    executor: options.executor,
    ...(options.reviewer === undefined ? {} : { reviewer: options.reviewer }),
    contextMode: 'single',
    selectedContextChars: 0,
    startedAt,
    events: [],
  }
  const mutableEvents = trace.events as DelegationTraceEvent[]
  const push = (event: DelegationTraceEvent) => {
    mutableEvents.push(event)
  }
  const recorder: DelegationTraceRecorder = {
    traceId: trace.traceId,
    record(stage, detail) {
      push({ stage, atMs: Date.now() - startedAt, ...(detail === undefined ? {} : { detail }) })
    },
    setSelectedContextChars(chars) {
      trace.selectedContextChars = chars
    },
    finish(outcome, fields) {
      trace.outcome = outcome
      trace.finishedAt = Date.now()
      if (fields?.contextRevision !== undefined) trace.contextRevision = fields.contextRevision
      if (fields?.contextMode !== undefined) trace.contextMode = fields.contextMode
      ring.push(trace)
      while (ring.length > TRACE_RETENTION) ring.shift()
    },
  }
  return recorder
}

/** The most recent traces (bounded); the newest is last. */
export function recentDelegationTraces(): readonly DelegationTrace[] {
  return ring
}

export { TRACE_RETENTION }

# Migration Guide: Upgrading to V1.0

This guide outlines the changes, architectural enhancements, and migration paths for users and contributors upgrading to `dsh-context-delegation` V1.0.

---

## 1. Public API Stability (Zero Breaking Changes)

For consumers using the plugin through DeepSeek Harness, `dsh-context-delegation` V1.0 is a drop-in replacement with zero breaking changes to public interfaces:

- **Package Exports**:
  - `dsh-context-delegation` (`lib/index.js`): Host Cordis service (`ContextDelegationService`) and core types.
  - `dsh-context-delegation/tool` (`lib/tool.js`): Scoped tool definitions (`codex_expert`, `delegation_debug`).
  - `dsh-context-delegation/preview` (`lib/preview.js`): Read-only preview tool (`context_preview`).
- **Cordis Service Boundary**:
  - Registered as `ctx.codexContextDelegation`.
  - Injected dependencies: `fs`, `subagents`.
- **Handoff Delimiters & Schemas**:
  - Full compatibility with V1, V2, and V3 continuation protocols.

---

## 2. Internal Modular Reorganization (For Contributors)

To support long-term maintainability, the internal monolithic `src/` directory has been restructured into domain-driven subdirectories:

| Previous Path (V0.1–V0.9) | V1.0 Modular Path | Description |
|---|---|---|
| `src/context-loader.ts` | `src/context/loader.ts` | Persistent context candidate discovery and loading |
| `src/context-chunker.ts` | `src/context/chunker.ts` | Deterministic Markdown section chunking |
| `src/context-query.ts` | `src/context/query.ts` | Stopword-filtered query tokenization |
| `src/context-retrieval.ts` | `src/context/retrieval.ts` | Lexical scoring and ranking |
| `src/context-selection.ts` | `src/context/selection.ts` | Budget-aware section selection |
| `src/context-budget.ts` | `src/context/budget.ts` | Category budgeting and text normalization |
| `src/context-cache.ts` | `src/context/cache.ts` | Process-local LRU chunk cache |
| `src/context-fingerprint.ts` | `src/context/fingerprint.ts` | Snapshot hashing and policy revisions |
| `src/context-delta.ts` | `src/context/delta.ts` | Differential snapshot calculation |
| `src/context-preview.ts` | `src/context/preview.ts` | Context preview payload builder |
| `src/context-writeback.ts` | `src/context/writeback.ts` | Reviewed patch application and writeback |
| `src/path-confinement.ts` | `src/context/path-confinement.ts` | Workspace and junction confinement checks |
| `src/handoff-builder.ts` | `src/handoff/builder.ts` | V1/V2 handoff prompt assembly |
| `src/continuation-handoff.ts` | `src/handoff/protocol.ts` | V3 delta/full handoff and ACK protocol |
| `src/continuation-transport.ts` | `src/delegation/transport.ts` | Cordis subagent continuation transport |
| `src/delegation-session.ts` | `src/delegation/session.ts` | Session registry, TTL and invalidation |
| `src/delegation-lifecycle.ts` | `src/delegation/lifecycle.ts` | Settlement classification and diagnostics |
| `src/executor-routing.ts` | `src/delegation/routing.ts` | Multi-executor routing document resolution |
| `src/result.ts` | `src/delegation/result.ts` | Result formatting and schemas |
| `src/executor-adapter.ts` | `src/executors/subagent.ts` | Subagent execution adapter |
| `src/workspace-evidence.ts` | `src/verification/workspace-evidence.ts` | Read-only git workspace evidence |
| `src/verification-runner.ts` | `src/verification/verification-runner.ts` | Subprocess command execution with tree-kill |
| `src/reviewer.ts` | `src/verification/reviewer.ts` | Independent review prompt and parser |
| `src/review-loop.ts` | `src/verification/review-loop.ts` | Bounded rework loop orchestration |
| `src/executor-report.ts` | `src/verification/executor-report.ts` | Structured executor claim parser |
| `src/trace.ts` | `src/observability/trace.ts` | Process-local telemetry recorder |

*Note: Root re-export shims are maintained in `src/` to ensure full backward compatibility with any internal or fixture imports.*

---

## 3. Configuration Reference

```yaml
# cordis.yml example for V1.0
codexContextDelegation:
  # Context Engine
  contextRoot: harness/context        # default: harness/context
  contextMode: lexical                # lexical (default) | legacy
  maxContextChars: 40000              # default: 40000 (hard limit: 1000000)
  cacheEnabled: true                  # default: true
  contextMinRelativeScore: 0.3        # default: 0.3
  contextBudgets:
    mandatory: 14000
    project: 8000
    decisions: 8000
    experiments: 8000

  # Delegation & Continuation
  continuationEnabled: false          # default: false
  continuationProviderName: spawn     # default: spawn
  requireContextAck: true             # default: true
  maxSessions: 8                      # default: 8 (max: 64)
  idleTtlMs: 900000                   # default: 900000 (15 minutes)

  # Routing
  providerName: codex                 # default: codex
  toolName: codex_expert              # default: codex_expert
  executorRouting:
    implementation:
      provider: codex
    reviewer:
      provider: codex

  # Verification & Write-Back
  maxReviewRounds: 1                  # default: 1 (max: 5)
  verificationTimeoutMs: 120000       # default: 120000 (2 minutes)
  verificationMaxOutputChars: 16000   # default: 16000
  contextWriteback: proposal          # proposal (default) | apply | disabled
```

---

## 4. Key New Features in V1.0

1. **Deterministic Context Engine**: Sub-20ms cached Markdown chunking and tokenized retrieval.
2. **Stateful Delta Handoff (V3)**: Saves up to 80% tokens on multi-turn continuations.
3. **Multi-Backend Seam & Independent Reviewer Routing**: Disconnects execution from verification.
4. **Independent Evidence & Process-Tree Kill**: Real git diffs and hardened command isolation.
5. **Reviewed Context Memory**: Executor updates are verified by reviewer before atomic write-back.
6. **Built-in Observability**: `delegation_debug` tool for transparent latency, token, and routing inspection.

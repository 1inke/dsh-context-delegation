# Changelog

## [1.0.0] - 2026-09-14

### Summary
The initial production release of **`dsh-context-delegation`**: a context-aware delegation layer for DeepSeek Harness that selects task-relevant persistent project context, supports full and incremental handoffs, delegates work to interchangeable execution backends, independently verifies results, and optionally produces reviewed project-context updates.

### Features
- **Context Intelligence & Retrieval Engine**: Deterministic Markdown chunking with heading hierarchy preservation, task-aware lexical scoring, strict character budgeting (`maxContextChars: 40000`), and a 64-entry process-local LRU cache for sub-20ms warm retrieval.
- **Stateful Delta Protocol (V3)**: Deterministic SHA-256 context fingerprinting and incremental deltas (`added`, `changed`, `removed`), reducing continuation payload size by up to 80%.
- **Execution Backend Neutrality**: Operator-configured provider routing separating implementation and review roles across Codex, local spawn, or CPA proxies.
- **Independent Verification**: Host-driven physical workspace delta collection via Git, process tree-killed execution of caller-authorized verification commands, and structured review verdicts (`pass`, `rework`, `blocked`).
- **Anti-False-Positive Loop**: Enforces review outcome honesty; parent models are strictly prohibited from reporting verified status when reviewer verdicts require rework or are blocked.
- **Auditable Context Write-Back**: Reviewer-gated proposals and atomic file application with context fingerprint evolution.
- **Observability**: Process-local `DelegationTrace` ring buffer (last 20 calls) and model-facing `delegation_debug` inspection tool.
- **Packaging & Modularity**: Domain-driven modularization (`src/context/`, `src/handoff/`, `src/delegation/`, `src/executors/`, `src/verification/`, `src/observability/`) with root re-export shims.

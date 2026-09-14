# Compatibility Matrix

This document tracks verified and supported environments for `dsh-context-delegation`.

## 1. Operating Systems & Node Versions

| OS | Platform Key | Node Version | Status | Evidence |
| --- | --- | --- | --- | --- |
| Windows 11 (build 26200+) | `win32` | v24.15.0 | **VERIFIED** | Local gates (260+ tests), package verification, real runtime smokes (continuation, review, routing, write-back, trace, perf, failure) |
| Windows 10 | `win32` | v22.19.0+ | **READY** | Same win32 APIs; tree-kill (`taskkill /T /F`) and NTFS junction confinement tested |
| Linux (Ubuntu 22.04+) | `linux` | v22.19.0+ / v24.x | **READY** | Standard POSIX path normalization, process-group kill (`process.kill(-pid)`), no native addons |
| macOS | `darwin` | v22.19.0+ / v24.x | **READY** | Standard POSIX path normalization, process-group kill |

## 2. DeepSeek Harness Runtime Compatibility

| Harness Version | Status | Notes |
| --- | --- | --- |
| `0.1.5-rc.2` | **VERIFIED** | Official local harness runtime checkout at `Desktop/DSH/deepseek-harness` |
| Future RC / 0.2.x | **READY** | Depends strictly on published `@deepseek-ai/*` interfaces and Cordis 4.x service container |

## 3. Subagent Provider Matrix

| Provider | Fresh Delegation | Continuable Mode | Reviewer Role |
| --- | --- | --- | --- |
| `codex` (`@deepseek-ai/dsh-subagent-codex`) | Supported | Fresh-only (in DSH 0.1.5-rc.2, lacks `prepareContinuable`) | Supported |
| `spawn` (`@deepseek-ai/dsh-subagent-spawn-in-process`) | Supported | Supported (`prepareContinuable`, `sendMessage`, `drainContinuableChildren`) | Supported |
| Custom / ACP / Claude-code | Supported via `SubagentExecutor` | Requires provider `prepareContinuable` | Supported |

## 4. Platform-Specific Path & Process Handling

- **Path Confinement**: All paths are resolved with real canonicalization (`fs.realpath`). Windows path separators (`\`) are normalized to POSIX (`/`) in handoff payloads, traces, and evidence.
- **Symlinks & Junctions**: Directory traversal checks ensure NTFS directory junctions cannot point outside `workspaceRoot`.
- **Subprocess Tree Termination**:
  - Windows (`win32`): Uses `taskkill /pid <PID> /T /F` to terminate the full process tree (avoiding orphaned cmd.exe / node child processes).
  - POSIX (`linux`, `darwin`): Uses process group detachment (`detached: true`) and signals `-child.pid`.

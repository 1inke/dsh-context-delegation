# dsh-context-delegation (V1.0)

[![Engine](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-blue.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-281%20passed-brightgreen.svg)](docs/verification/v1.0.md)
[![Release](https://img.shields.io/badge/release-v1.0.0-blue.svg)](https://github.com/1inke/dsh-context-delegation/releases/tag/v1.0.0)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**An out-of-tree plugin for DeepSeek Harness (DSH) providing context selection, delegation, and verification.**  
It assists in selecting task-relevant project context, managing session continuation handoffs, routing tasks to configured subagent backends, checking physical file changes via Git, and generating proposed updates for repository notes.

> **面向 DeepSeek Harness (DSH) 的上下文选择、委派与结果核验辅助插件。**  
> 旨在协助主智能体按任务筛选相关的项目规范与上下文、支持会话增量续接、将任务分发至指定的子智能体后端、通过 Git 和验证命令核验实际变更，并支持对长期上下文文档生成受审查的更新建议。

---

## 1. Project Overview / 项目概述

### English

When delegating coding tasks to subagents in an agent runtime, several practical engineering challenges often arise:
- **Context Sizing**: Feeding entire documentation trees can quickly exhaust model token windows and increase latency, while providing no context can cause subagents to disregard existing architectural conventions.
- **Verification of Outcomes**: Language models may occasionally report that a task or test succeeded even when errors occurred, commands were omitted, or unexpected files were altered.
- **Multi-Turn Continuation Overhead**: Sending full context snapshots repeatedly across multiple turns introduces unnecessary token usage.
- **Context Maintenance**: Allowing subagents to write directly to shared repository notes without review risks polluting project documentation.

**How this plugin approaches these areas:**
- **Heuristic Context Selection**: Scans markdown documents under `harness/context/` and `AGENTS.md`, chunks them by heading structure, scores relevance based on task keywords, and fits selected excerpts within a configured character budget (`maxContextChars`).
- **Incremental Continuation (V3 Protocol)**: Computes SHA-256 fingerprints of context snapshots. In multi-turn sessions using continuation-capable providers, subsequent turns can transmit diffs (`added`, `changed`, `removed`) rather than resending full content.
- **Independent Workspace Checks**: Directly invokes Git (`git status`, `git diff`) from the host to inspect actual modified files, rather than relying solely on the executor's textual summary.
- **Decoupled Review Flow**: Allows configuring different providers or models for implementation and review. An optional independent reviewer evaluates the work against acceptance criteria. If criteria are unmet, the tool output explicitly reflects the rework/blocked status to prevent unintended false-positive completions.
- **Proposed Context Updates**: Context write-back operates in `proposal` mode by default, producing structured patches for human or caller inspection before any file modification.

---

### 中文

### 中文

在智能体开发流程中，将复杂的编码任务分发给子智能体时，通常会遇到以下常见问题：
- **上下文难以兼顾**：全量灌入项目文档容易迅速消耗上下文窗口并增加时延；若完全不提供上下文，子智能体又容易偏离既有的架构约定与规范。
- **执行结果需要核验**：模型生成的回执偶尔存在偏差（例如声称测试已通过但实际命令报错，或修改了非预期的无关文件）。
- **多轮续接开销累积**：在连续多轮交互中，反复传递完整的项目背景和说明文档会带来不必要的 Token 消耗。
- **长期文档维护风险**：若允许子智能体随意更新项目的公共记忆文档（如技术决策、状态记录），可能导致文档结构或内容失真。

**本插件的设计思路与应对方式：**
- **启发式上下文检索**：读取 `harness/context/` 和 `AGENTS.md` 中的 Markdown 文档，按标题层级切分小块，结合任务关键词进行分词匹配与预算裁剪（`maxContextChars`），尽量在预算内提供相关信息。
- **增量续接支持（V3 协议）**：基于 SHA-256 计算上下文快照指纹。在支持会话续接的运行环境下，多轮调用可只传递增量差异（`added` / `changed` / `removed`），减少重复传输。
- **独立工作区核验**：任务结束后由宿主直接调用 Git（`git status`、`git diff`）检查物理磁盘上的实际变更，辅以调用方授权的测试命令，不单纯依赖子智能体的自述总结。
- **双模型审查与结果提示**：支持将实现与审查配置为不同的模型或 Provider。审查未通过时，工具输出会显式标注 `REWORK` 或 `BLOCKED` 状态，降低将未完成任务误判为已通过的风险。
- **建议式上下文写回**：长期上下文更新默认采用建议模式（`proposal`），生成结构化补丁供人工或调用方确认，默认不直接修改知识库文件。

---

## 2. Processing Flow / 数据与处理流程

Delegation follows a standard step-by-step pipeline:

```text
 Caller / Parent Agent (调用方 / 父智能体)
       │
       ▼
 1. Context Selection (上下文检索与预算裁剪: Loader -> Chunker -> Scoring -> Selection)
       │
       ▼
 2. Subagent Execution (子智能体分发: SubagentExecutor / Configured Provider Routing)
       │
       ▼
 3. Workspace Inspection (工作区物理检查: Git Porcelain Status + Authorized Verification Commands)
       │
       ▼
 4. Optional Review (可选审查环节: Independent Reviewer assessing Evidence vs. Criteria)
       │
       ▼
 5. Context Proposal (上下文更新建议: Patch Proposals / Optional Atomic Apply)
       │
       ▼
 6. Result Assembly (结果结构化呈现: Formatted Summary + Status Banners + In-Memory Trace)
```

---

## 3. Deployment Requirements / 部署环境要求

### Runtime & System Prerequisites / 运行时与系统依赖

| Item / 依赖项 | Requirement / 规格要求 | Notes / 说明 |
|---|---|---|
| **Node.js** | `^22.19.0` 或 `>=24.0.0` | 推荐 Node 24 LTS |
| **DeepSeek Harness (DSH)** | `>= 0.1.5-rc.2` | 基于 Cordis 架构的官方 DSH 运行时 |
| **Operating System** | Windows 10/11, macOS, Linux | 当前实测验证以 Windows 11 + Node 24 为主；其他平台已做结构性适配 |
| **Git** | `>= 2.30.0` | 用于收集工作区文件变更证据（内部已配置 `safe.directory=*` 兼容跨属主目录） |
| **Package Manager** | `pnpm >= 9.0.0` | DSH 标准依赖管理工具 |

### Backend & Model Compatibility / 支持的执行后端

- **Implementation (实现端)**:
  - 官方 Codex Provider (`@deepseek-ai/dsh-subagent-codex`，如 `gpt-5.6-luna`)
  - 本地子进程 Provider (`@deepseek-ai/dsh-subagent-spawn-in-process`)
  - 兼容 DSH `ctx.subagents` 规范的第三方 Provider 或本地代理
- **Reviewer (审查端)**:
  - 默认可复用主实现 Provider，亦可独立配置为其他可用模型以实现互补交叉审查。

---

## 4. Installation & Setup Guide / 安装与配置指引

### Step 1: Add Dependency / 添加插件依赖

在你的 DSH Profile（例如 `~/.dsh/profiles/web/package.json`）中添加本地或发布包引用：

```json
{
  "dependencies": {
    "dsh-context-delegation": "link:C://Users//linke//Desktop//DSH//dsh-context-delegation-v1.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-subagent-codex",
        "dsh-context-delegation"
      ]
    }
  }
}
```

运行安装：
```bash
pnpm install
```

---

### Step 2: Configure Host in `cordis.patch.yml` / 在 Profile 中配置挂载

在 Profile 目录下的 `cordis.patch.yml` 中添加基础配置：

```yaml
- id: dsh-context-delegation-host
  config:
    contextRoot: harness/context
    contextMode: lexical
    maxContextChars: 40000
    cacheEnabled: true
    continuationEnabled: false
    executorRouting:
      implementation:
        provider: codex
      reviewer:
        provider: codex
    contextWriteback: proposal
```

---

### Step 3: Scope Tools in Agent Preset / 在 Preset 中暴露工具

为保持环境清晰，建议仅对专属编程预设（如 `My Coding`）暴露委派工具，编辑预设配置文件：

```yaml
- id: tool-codex-expert
  name: dsh-context-delegation/tool
```

---

### Step 4: Validate Configuration / 验证配置有效性

利用 DSH 提供的配置诊断功能，在不启动服务的情况下检查合成配置树是否正常：

```bash
pnpm dsh --profile web --dump-config
```
> 确认输出中存在 `dsh-context-delegation-host` 且无字段解析错误。

---

### Step 5: Start Service / 启动服务

```bash
# 启动 Web 服务
pnpm dsh web --port 3080
```

---

## 5. Configuration Reference / 配置说明

```yaml
codexContextDelegation:
  # ================= 上下文检索引擎 (Context Engine) =================
  contextRoot: harness/context        # 存放上下文文档的相对目录 (默认: harness/context)
  contextMode: lexical                # 模式: lexical (基于关键词与标题启发式检索) | legacy (全量拼接)
  maxContextChars: 40000              # 单次任务最大注入字符预算 (上限: 1,000,000)
  cacheEnabled: true                  # 开启 Markdown 分块的进程内 LRU 缓存以减少重复解析
  contextMinRelativeScore: 0.3        # 检索分块的最低相对得分阈值 (0.0 ~ 1.0)
  contextBudgets:                     # 各类目保留预算分配 (总和不超过 maxContextChars)
    mandatory: 14000                  # 规范文件保留预算 (AGENTS.md, CURRENT_STATE 等)
    project: 8000                     # 项目背景类目
    decisions: 8000                   # 架构决策类目
    experiments: 8000                 # 实验日志类目

  # ================= 会话续接配置 (Continuation & Session) =================
  continuationEnabled: false          # 是否开启会话续接 (默认关闭，使用无状态的 fresh 模式)
  continuationProviderName: spawn     # 支持可续接特性的 Provider (如 spawn)
  requireContextAck: true             # 续接时要求子智能体回传版本 ACK
  maxSessions: 8                      # 活跃会话上限 (最大: 64)
  idleTtlMs: 900000                   # 会话空闲淘汰时间 (毫秒，默认 15 分钟)

  # ================= 执行后端路由 (Routing) =================
  providerName: codex                 # 默认实现后端 Provider
  toolName: codex_expert              # 暴露给模型的工具名称
  executorRouting:
    implementation:
      provider: codex                 # 编码实现任务执行方
    reviewer:
      provider: codex                 # 审查评估执行方 (可配置为不同模型)

  # ================= 验证与写回 (Verification & Write-Back) =================
  maxReviewRounds: 1                  # 审查未通过时的自动重做上限轮次 (0 ~ 5)
  verificationTimeoutMs: 120000       # 独立验证命令执行超时时间 (毫秒)
  verificationMaxOutputChars: 16000   # 验证输出捕获上限字符数
  contextWriteback: proposal          # 写回模式: proposal (仅生成建议补丁) | apply (直接应用) | disabled
```

---

## 6. Operational Recommendations & Rollback / 运维建议与回滚

- **升级前备份**：在切换到正式 Profile 前，建议备份 Profile 目录下的 `package.json`、`pnpm-lock.yaml`、`cordis.patch.yml` 以及 Agent Preset，并记录文件哈希。
- **Canary 试验**：建议在独立端口（例如 3081）建立测试 Profile 先行验证，确认核心流程符合预期后再部署到日常环境。
- **回滚步骤**：若新配置或版本出现兼容性问题，还原已备份的配置文件，重新运行 `pnpm install` 并重启 DSH 即可恢复到此前状态。

---

## 7. Model Tools Reference / 模型端工具说明

| Tool Name | Caller Scope | Description / 说明 |
|---|---|---|
| `codex_expert` | Model-facing | **核心委派工具**：自动加载相关的项目规范并向后端子智能体发起委派。若配置了验收条件，任务完成后会收集 Git 变更并执行测试命令。若审查未通过，结果会附带明确警告。 |
| `context_preview` | Model-facing | **只读预览工具**：测试分块检索结果和预算占用情况，不调用外部执行模型。 |
| `delegation_debug` | Model / Operator | **可观测性工具**：返回内存环形缓冲区中近 20 次调用的耗时、状态与路由信息，不输出敏感文件或提示词原文。 |

---

## 8. Current Limitations / 当前局限性

为了保持透明与客观，在此列出当前版本的已知边界与适用场景：
1. **启发式文本检索**：上下文检索基于分词统计与标题结构，并非基于语义向量嵌入（Dense Embeddings）。对于语义跳跃较大但缺乏关键词重合的场景，检索效果可能不如全文阅读。
2. **续接特性依赖 Provider**：增量续接协议依赖底层 Provider 对持久化会话（`prepareContinuable`）的支持（如 `spawn`），在仅支持一次性 Fresh 调用的 Provider 上需使用 `mode: fresh`。
3. **命令安全性**：独立验证命令虽然内置了基础的高危指令过滤与超时杀进程树保护，但仍建议操作者仅授权明确、可控的测试脚本。

---

## 9. Verification & Tests / 验证与测试

本项目采用红绿测试与测试驱动开发方法：

- **自动化测试**：42 个测试套件，**281** 个单元与集成测试通过（`pnpm test`）。
- **类型检查**：TypeScript 严格模式检查无报错（`pnpm run typecheck`）。
- **打包清单验证**：经 `scripts/verify-package.mjs` 检查，104 个打包文件与相对 ESM 导入解析正常。
- **真实运行时冒烟脚本**：
  - `scripts/live-failure-smoke.mjs`：故障注入与取消流程测试。
  - `scripts/live-trace-smoke.mjs`：调用轨迹记录测试。
  - `scripts/live-continuation-smoke.mjs`：多轮续接增量协议测试。
  - `scripts/live-routing-smoke.mjs`：多后端路由测试。
  - `scripts/live-writeback-smoke.mjs`：上下文补丁生成测试。
  - `scripts/live-review-smoke.mjs`：独立 Git 变更收集与审查流程测试。
  - `scripts/live-codex-smoke.mjs`：官方 Codex 模型上下文注入端到端测试。

---

## 10. Documentation Links / 详细文档指引

- [Architecture Contract (架构契约)](docs/architecture/v1.0-contract.md)
- [Migration Guide (迁移指南)](docs/migration-v1.0.md)
- [Verification Report (验证报告)](docs/verification/v1.0.md)
- [Compatibility Matrix (兼容性矩阵)](docs/compatibility.md)
- [Security Boundaries (安全边界说明)](docs/security-boundaries.md)
- [Changelog (变更日志)](CHANGELOG.md)
- [GitHub Release v1.0.0](https://github.com/1inke/dsh-context-delegation/releases/tag/v1.0.0)

---

## 11. License / 开源协议

This project is licensed under the [MIT License](LICENSE).  
本项目基于 [MIT 许可证](LICENSE) 开源。

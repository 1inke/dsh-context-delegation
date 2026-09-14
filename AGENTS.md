# AGENTS.md — `dsh-context-delegation` Plugin Engineering Protocol

> 适用于 `dsh-context-delegation` 插件仓库及各工作树的智能体任务执行规范。
> 继承自工作区总纲，针对本插件的上下文检索、续接协议、独立评审与写回流程进行专项约束。

---

## 1. 运行环境事实与固定路径（Environment Facts & Paths）

- **包管理器执行命令**：使用 `pnpm <args>` 或绝对路径调用 Node 托管的 `pnpm.cjs`。
- **真实 LLM 与 CPA 代理**：
  - 本地 CPA 服务地址：`127.0.0.1:8317/v1`
  - 核心模型：`gemini-3.8-flash-high`
  - 凭据位于 `~/.dsh/.credentials.yaml` 或环境变量 `DSH_CREDENTIALS_PATH`，只注入进程环境，**严禁打印或写入文件**。

---

## 2. Windows 沙箱与子进程提权准则（Sandbox & Permissions Protocol）

- **管道约束认知**：Windows 文件沙箱（workspace-write）模式下，Node.js `child_process` 默认标准管道（`stdio: 'pipe'`）受系统命名管道策略限制，会产生 `EPERM` 拒绝。这是平台和沙箱的安全边界，不是代码 Bug。
- **提权与执行准则**：
  - 运行编译构建（`tsc`、`tsdown`）、全量测试套件（`vitest`）以及驱动子进程的真实 live 冒烟测试脚本时，直接在调用工具时指定 `sandbox_permissions: 'danger-full-access'` 并附带明确理由。
  - **严禁**盲目尝试修改 pipe 模式或反复重试相同受限命令。

---

## 3. 进程树杀灭纪律（Process Tree Termination Discipline）

- **Windows 孤儿进程防御**：验证命令执行器（`verification-runner.ts`）在 Windows 平台上执行不受信命令时，严禁仅通过 `child.kill()` 或单一 PID 终止，必须执行进程树杀灭：
  ```cmd
  taskkill /F /T /PID <pid>
  ```
- **POSIX 进程组杀灭**：POSIX 环境下启动外部验证进程必须配置 `detached: true`，并在超时或取消时使用负 PID 组杀灭（`process.kill(-pid)`），确保无任何脱壳僵尸进程残留。

---

## 4. 异步测试确定性准则（Deterministic Async Testing Protocol）

- **严禁固定延时等待**：测试代码中严禁出现任意预估毫秒数的 `await new Promise(resolve => setTimeout(resolve, N))` 作为异步状态完成依据。
- **强制使用谓词条件轮询**：涉及事件派发、子 Agent 启动、状态机切换的测试，必须使用 Vitest 的条件等待：
  ```ts
  await vi.waitFor(() => expect(subagents.startContinuable).toHaveBeenCalled())
  ```
  或基于严格的 Promise / Event 监听机制，确保测试仅随真实状态达成而推进。

---

## 5. 质量门禁防吞码规则（Pure Exit-Code Preservation）

- **禁止管道尾随过滤**：运行 `tsc`、`pnpm test`、`pnpm run build` 等核心质量门禁时，严禁使用 `| tail`、`| Select-Object -Last N` 等命令行管道过滤。
- **退出码神圣不可侵犯**：PowerShell 中的管道过滤容易掩盖编译器的非零退出码，造成“门禁看似通过实则报错”的假阳性。必须保留真实退出码，调查任何非零退出。

---

## 6. 渐进式重构与包产物纯洁性（Refactoring & Package Hygiene）

- **渐进式重构（垫片层优先）**：对源码进行领域子目录解耦重组（如将 `src/` 扁平文件移入 `src/context/`、`src/delegation/`）时，应优先在新位置创建实现，并在原路径保留无副作用的 Re-export Shims（垫片）。这能确保上百个既有测试与外部消费无感过渡，杜绝产生跨文件大爆炸式冲突。
- **打包必须做真体验证**：涉及目录调整、`package.json` 文件列表变更、构建工具配置调整时，严禁仅凭 `build succeeded` 下结论，必须通过真实的 `npm pack --dry-run`（如运行 `node scripts/verify-package.mjs`）检查打包清单，并逐一核对各模块的相对引用是否存在悬空。

---

## 7. 持久化证据链维护（Durable Memory Discipline）

- **事实记录规范**：每完成一个子阶段或重大版本（如 V0.8, V0.9, V1.0），必须在 `.memory` 与 `PROJECT_GUIDE.md` 中以客观事实记录操作命令、关键结果与决策原因，确保后序轮次或全新子 Agent 能够无缝继承历史资产。

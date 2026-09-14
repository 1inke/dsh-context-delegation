# Context contract

The default context plan is deterministic and does not scan the repository:

| Order | Relative path | Purpose |
| --- | --- | --- |
| 1 | `AGENTS.md` | Project rules |
| 2 | `harness/context/CURRENT_STATE.md` | Current state |
| 3 | `harness/context/PROJECT_CONTEXT.md` | Project context |
| 4 | `harness/context/CODEX_HANDOFF.md` | Delegation rules |
| 5 | `harness/context/DECISIONS.md` | Decisions |
| 6 | `harness/context/EXPERIMENTS.md` | Experiment evidence |

Each file can be disabled independently. In lexical mode, `AGENTS.md`,
`CURRENT_STATE.md`, and `CODEX_HANDOFF.md` are mandatory when enabled and must
fit their mandatory budget in full or loading fails with `CONTEXT_TOO_LARGE`.
The other three categories are retrieved as chunks. Missing files are
reported in the structured result; when no enabled file is available, the
warning is exactly `No persistent context files found in workspace`.

Text is normalized before budgeting. The default total budget is 40,000
UTF-16 code units, with a hard maximum of 1,000,000. Default category budgets
are 14,000 mandatory, 8,000 project, 8,000 decisions, and 8,000 experiments;
the remaining 2,000 is intentionally unused. Defaults scale with the total.
Explicit category budgets must sum to no more than the total. Each file read is
capped at `maxContextChars + 1`; a bounded prefix can be reported as
source-limited and may miss a tail match. Surrogate pairs are not split.

Lexical chunks use ATX headings with full ancestry, preserve preambles, and
ignore headings in backtick or tilde fenced code. `minChunkChars` is a hint
only and does not merge chunks across headings. Lexical matching uses terms and
path mentions only; it has no embeddings and no negation semantics.
The default relative score floor is 30% of the best score (at least 1),
configurable through `contextMinRelativeScore`. Preview reports that floor.
Shared storage directory terms do not add path-score bonuses.
`contextRoot` can relocate the five non-AGENTS paths; the table shows defaults.

`relevant_files` must be workspace-relative. Paths are normalized, duplicate
entries are removed while preserving first appearance, and existing targets
must be regular files. A path may be absent if its resolved target remains
inside the workspace; the plugin does not read candidate contents.

Successful output includes the provider, workspace root, loaded/missing/
truncated context paths, context character count, run ID, final Codex text,
and `parentVerificationRequired: true`.

`contextMode: legacy` retains the serial V1 contract for migration. The V2
lexical handoff and optional read-only preview are development features in the
unreleased `0.2.0-dev.0` package.

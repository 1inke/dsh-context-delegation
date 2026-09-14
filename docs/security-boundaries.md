# Security boundaries

The plugin treats the parent session workspace as authoritative. Absolute
context roots, drive-letter paths, UNC paths, parent traversal, and targets
outside that workspace are rejected before delegation.

Context files are resolved and contained before they are streamed. Reads are
bounded to `maxContextChars + 1` UTF-16 code units per file, and category and
total budgets are enforced before handoff construction. Mandatory context is
never silently truncated. Directories and special non-regular files fail
closed. Lexical ranking operates only on bounded loaded text, so a
source-limited prefix can miss matches in a file tail.

Model-controlled task text, notes, criteria, and paths are data inside a
versioned JSON payload. They cannot create structural handoff delimiters.
This is structural isolation, not a guarantee against semantic prompt injection.
The handoff instructs the child to stay within the
workspace and not maintain project `.memory` files.

Provider output is limited at the publication seam: only text content blocks
cross the boundary, failure partial output is bounded, and provider
diagnostics are capped at 4,096 UTF-8 bytes.

The plugin does not read `relevant_files` contents, modify persistent context
files, commit, push, or invoke Codex outside the configured DSH subagent
provider. Provider permission mode still governs delegated file changes.

Execution-time exact-key validation rejects undeclared input such as provider,
model, permission, context-root or budget overrides. These are operator-owned
configuration, not model-controlled tool inputs. Canonical target checks reject
symlink/junction escapes, including relevant-file targets. They are not an
atomic operating-system sandbox against a concurrent hostile filesystem writer.

Cancellation after provider invocation reports that the workspace may have
changed. Execution and disposal failures are retained separately, including
double failures. Executor completion is not independent verification.

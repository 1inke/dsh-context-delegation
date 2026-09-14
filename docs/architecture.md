# Architecture

The bundle has two DSH entries:

- The Host entry registers the context service and exposes `prepareContext()`
  using the parent session's authoritative workspace directory.
- The `./tool` entry registers the model-facing `codex_expert` tool when the
  profile and preset enable it.

A request resolves configuration and the authoritative workspace, validates
`relevant_files` without reading them, then follows one of two context paths.
The default `lexical` path loads bounded candidates, preserves mandatory files,
chunks project, decision, and experiment files by ATX headings (excluding
fenced-code headings), ranks chunks lexically, and builds a V2 handoff. The
optional `legacy` path preserves the serial V1 loading and handoff.

`preview()` uses the same preparation path as `delegate()` and returns
metadata and retrieved headings without starting a child run. A separate
optional scoped preview entry may expose that read-only operation; the normal
`./tool` entry registers `codex_expert`.

The selected handoff runs one foreground provider with the parent execution
identity and signal, and awaits disposal even when execution fails. This is
the current `0.2.0-dev.0` implementation; it is unreleased and undeployed.

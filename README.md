# pi-checkpoint-compaction

Zero-LLM compaction for [pi](https://pi.dev) coding agent.

Instead of re-summarizing your whole history with an LLM every time the
context window fills up, this extension keeps a **model-maintained checkpoint
file** (`~/.pi/agent/checkpoints/<session>.md`) and
folds it into context at compaction time — no LLM call. If the checkpoint is
stale or missing, it degrades to a **mechanical span digest** (still no LLM),
and only as a dead-last fallback does it hand off to pi's built-in LLM
summarization.

This is a port of the `dsh-checkpoint` engine (v0.2.4) used by
[deepseek-harness](https://github.com/managementstocks-bit/dsh-plugins).

## Install

```bash
pi install npm:pi-checkpoint-compaction
```

or try it for one run without installing:

```bash
pi -e npm:pi-checkpoint-compaction
```

## How it works

The extension registers one tool and one command:

| Resource | Purpose |
|----------|---------|
| `checkpoint_update` tool | Overwrites this session's checkpoint file with the model's current state (goal / done / next). |
| `/checkpoint` command | Prints the current checkpoint. |

At compaction (automatic or manual `/compact`), the `session_before_compact`
hook applies a 3-tier policy:

| Tier | Condition | What happens | LLM? |
|------|-----------|--------------|------|
| 1 | checkpoint newer than the span (60 s epsilon) | checkpoint text folded in as the new summary | no |
| 2 | checkpoint exists but older than the span (max 12 h) | mechanical digest of the span (user asks, assistant decisions, tool calls, `[TOOL-ERROR]` lines) with the checkpoint as goal anchor | no |
| 3 | no usable checkpoint, empty span, custom compaction instructions, or split turn | defer to pi's default LLM compaction | yes |

Split turns are deliberately deferred to pi's built-in summarizer because
pi preserves the partial-turn prefix in that path, which an extension summary
cannot.

The checkpoint file is per-session (`<sessionId>.md`); a shared `active.md`
is only read as a fallback anchor and is never overwritten when a session ID
is known. Checkpoints older than 12 h are ignored.

## Typical usage

Tell the agent once:

> After every meaningful milestone, call `checkpoint_update` with the current
> goal, what is done, and what is next.

The agent maintains the file as it works; compaction then costs zero LLM
tokens as long as the checkpoint is fresh. If the agent forgets, compaction
still produces a faithful skeleton of the span (tier 2) rather than guessing.

## Development

The extension is a single file (`extensions/checkpoint-compaction.ts`) with no
runtime dependencies beyond what pi bundles (`typebox`, the pi core). Unit
tests live in the repository root (`test-checkpoint.mjs`).

## License

MIT

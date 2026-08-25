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
| 3 | no usable checkpoint and nothing digestible in the span, or custom compaction instructions | defer to pi's default LLM compaction | yes |

Split turns (pi cutting mid-turn, keeping a turn prefix) are handled
mechanically too: the span digest/checkpoint fold is merged with a mechanical
digest of the turn prefix, in pi's own `**Turn Context (split turn):**` format.
That path is where pi's default summarizer spends two LLM calls — here it
spends zero.

The checkpoint file is per-session (`<sessionId>.md`); a shared `active.md`
is only read as a fallback anchor and is never overwritten when a session ID
is known. Checkpoints older than 12 h are ignored.

## Typical usage

Tell the agent once:

> After every meaningful milestone, call `checkpoint_update` with the current
> goal, what is done, and what is next.

### You don't even need to trust the agent

A `turn_end` hook rewrites the checkpoint file after **every turn**: it
preserves the model's last semantic checkpoint verbatim and appends a fresh
"Recent activity" section (last user prompt, assistant text, tool calls, tool
errors of the turn that just ended). If the model called `checkpoint_update`
during the turn, the harness skips — the model's word wins.

So the file is fresh at every compaction boundary even if the model never
calls the tool at all; the tool then exists to add *semantic* state (goals,
decisions, plans), not to keep the file fresh. Compaction costs zero LLM
tokens in either case.

Per-tool-call updates are deliberately not done: pi's compaction always keeps
the recent turns, and mid-turn compaction digests the turn prefix
mechanically, so turn granularity is exactly as fresh as compaction ever
needs — at a fraction of the file churn.

Finally, the extension appends a one-paragraph standing instruction to the
system prompt each run (via `before_agent_start`) reminding the model to call
`checkpoint_update` at milestones — so the *semantic* quality of the file
tracks what the model is actually thinking, even though freshness no longer
depends on it.

## Development

The extension is a single file (`extensions/checkpoint-compaction.ts`) with no
runtime dependencies beyond what pi bundles (`typebox`, the pi core). Unit
tests live in the repository root (`test-checkpoint.mjs`).

## License

MIT

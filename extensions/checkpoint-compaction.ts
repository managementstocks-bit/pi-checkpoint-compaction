/**
 * checkpoint-compaction.ts — port of dsh-checkpoint (v0.2.4) to pi.
 *
 * Three-tier compaction on pi's `session_before_compact` hook:
 *   TIER 1 — FRESH CHECKPOINT: model called `checkpoint_update` at/after the
 *   newest model/tool work in the span about to be shadowed → fold the file.
 *   TIER 2 — MECHANICAL DIGEST: no fresh checkpoint → skeleton of the span
 *   (user asks / assistant decisions / tool errors) + latest checkpoint as
 *   GOAL anchor. No LLM call.
 *   TIER 3 — FALLBACK: nothing digestible → return nothing → pi's default
 *   LLM summarization.
 *
 * Checkpoints: ~/.pi/agent/checkpoints/<sessionId>.md (tool writes per-session
 * file only) and active.md (fallback when no session id).
 *
 * Ported semantics (identical to dsh-checkpoint): MAX_AGE_MS 12h,
 * FRESH_EPSILON_MS 60s (write→event-append latency; genuine un-checkpointed
 * work is minutes later, never seconds), MAX_CHECKPOINT_CHARS 6000, adaptive
 * digest budget, keep-most-recent elision, [STATE-CARRIED] folding of the
 * previous summary (pi re-injects prior summaries as role "compactionSummary";
 * carrying verbatim would snowball), tool errors captured via role
 * "toolResult" + isError (pi has the clean model dsh lacks — the dsh-side
 * role-matching bug is fixed there too).
 *
 * Deliberate deviations: customInstructions (user asked /compact for a focused
 * LLM summary) and split-turn cuts defer to pi's default summarizer; read/
 * modified file lists are included in summary text + details so pi's
 * cumulative file tracking keeps working.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_CHECKPOINT_CHARS = 6000;
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const FRESH_EPSILON_MS = 60 * 1000;

function checkpointDir(): string {
  return join(homedir(), ".pi", "agent", "checkpoints");
}

export interface CheckpointRef {
  file: string;
  text: string;
  mtimeMs: number;
}

/**
 * Best candidate checkpoint: per-session file first, then active.md. 12h age
 * cap always. With boundaryMs set (fresh check), the file must also postdate
 * boundary minus FRESH_EPSILON_MS.
 */
export async function readCheckpoint(
  sessionId: string | null | undefined,
  boundaryMs: number | null,
  dir: string = checkpointDir(),
): Promise<CheckpointRef | null> {
  const candidates: string[] = [];
  if (sessionId && sessionId.length > 0) candidates.push(join(dir, sessionId + ".md"));
  candidates.push(join(dir, "active.md"));
  const seen = new Set<string>();
  for (const file of candidates) {
    if (seen.has(file)) continue;
    seen.add(file);
    try {
      const st = await stat(file);
      if (Date.now() - st.mtimeMs > MAX_AGE_MS) continue;
      if (boundaryMs !== null && st.mtimeMs < boundaryMs - FRESH_EPSILON_MS) continue;
      const text = await readFile(file, "utf8");
      if (text && text.trim().length > 0) {
        return { file, text: text.trim().slice(0, MAX_CHECKPOINT_CHARS), mtimeMs: st.mtimeMs };
      }
    } catch {
      // missing or unreadable: try next candidate
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mechanical span digest (port of dsh-checkpoint.mechanicalDigest)
// ---------------------------------------------------------------------------

export interface AnyMessage {
  role?: string;
  content?: unknown;
  timestamp?: number;
  isError?: boolean;
  summary?: string;
  [key: string]: unknown;
}

const clip = (s: unknown, n: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

/** pi user content is string | (Text|Image)[]; extract text blocks. */
const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
      const t = (b as { text?: string }).text;
      if (typeof t === "string" && t.trim().length > 0) out.push(t);
    }
  }
  return out.join(" ");
};

/**
 * No LLM calls. pi's message model is clean: tool results are role
 * "toolResult" with isError; previous summaries are role "compactionSummary"
 * — both handled explicitly (no role-matching gaps).
 */
export function mechanicalDigest(messages: AnyMessage[], anchor: CheckpointRef | null): string | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const lines: string[] = [];
  let users = 0;
  let steps = 0;
  let tools = 0;
  let inputChars = 0;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const role = m.role;
    if (role === "user") {
      const text = textOf(m.content);
      inputChars += text.length;
      if (!text) continue;
      if (text.trim().startsWith("<system-reminder>")) continue;
      if (text.startsWith("Current runtime context")) continue;
      users += 1;
      lines.push(`[USER] ${clip(text, 240)}`);
      continue;
    }
    if (role === "assistant") {
      const text = textOf(m.content);
      inputChars += text.length;
      if (text) {
        steps += 1;
        lines.push(`[ASSISTANT] ${clip(text, 320)}`);
      }
      const blocks = Array.isArray(m.content) ? m.content : [];
      for (const b of blocks) {
        if (b && typeof b === "object" && (b as { type?: string }).type === "toolCall") {
          tools += 1;
          lines.push(`[TOOL] ${String((b as { name?: string }).name || "?")}`);
        }
      }
      continue;
    }
    if (role === "toolResult") {
      const text = textOf(m.content);
      inputChars += text.length;
      if (!text) continue;
      if (m.isError === true || /^Error:/i.test(text)) {
        lines.push(`[TOOL-ERROR] ${clip(text, 160)}`);
      }
      continue;
    }
    if (role === "compactionSummary") {
      const body = textOf((m as { summary?: unknown }).summary ?? m.content);
      inputChars += body.length;
      if (body) lines.push(`[STATE-CARRIED] ${clip(body, 900)}`);
      continue;
    }
  }
  if (lines.length === 0 && !anchor) return null;
  const anchorText = anchor ? `## Goal / state carried from checkpoint\n${clip(anchor.text, 1200)}` : "";
  const anchorCost = anchorText ? anchorText.length + 2 : 0;
  const budget = Math.min(MAX_CHECKPOINT_CHARS, Math.max(150, Math.floor(inputChars / 2) - 300));
  const tailBudget = Math.max(0, budget - anchorCost);
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const cost = lines[i].length + 1;
    if (used + cost > tailBudget) break;
    kept.unshift(lines[i]);
    used += cost;
  }
  const header = `# Span digest (harness-recorded, no LLM)\n${users} user request(s), ${steps} assistant step(s), ${tools} tool call(s) in the folded span:\n`;
  const elided = kept.length < lines.length ? "(earlier activity elided — full detail stays in the durable log)\n" : "";
  return header + elided + (anchorText ? anchorText + "\n\n" : "") + kept.join("\n");
}

// ---------------------------------------------------------------------------
// File-operation lists (pi's CompactionDetails shape)
// ---------------------------------------------------------------------------

interface FileOpsLike {
  read?: Set<string> | string[];
  written?: Set<string> | string[];
  edited?: Set<string> | string[];
}

export function fileLists(ops: FileOpsLike | undefined): { readFiles: string[]; modifiedFiles: string[] } {
  const asArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : v instanceof Set ? [...v].map(String) : [];
  const read = asArr(ops?.read);
  const written = asArr(ops?.written);
  const edited = asArr(ops?.edited);
  const modified = new Set([...edited, ...written]);
  const readFiles = read.filter((f) => !modified.has(f)).sort();
  return { readFiles, modifiedFiles: [...modified].sort() };
}

function fileBlocks(files: { readFiles: string[]; modifiedFiles: string[] }): string {
  const sections: string[] = [];
  if (files.readFiles.length > 0) sections.push(`<read-files>\n${files.readFiles.join("\n")}\n</read-files>`);
  if (files.modifiedFiles.length > 0) sections.push(`<modified-files>\n${files.modifiedFiles.join("\n")}\n</modified-files>`);
  return sections.length ? `\n\n${sections.join("\n\n")}` : "";
}

function foldSummary(cp: CheckpointRef, files: { readFiles: string[]; modifiedFiles: string[] }): string {
  const head = `# State restored from model checkpoint (harness-recorded, no LLM)\nCheckpoint written ${new Date(cp.mtimeMs).toISOString()}; the span before it was folded away.\n\n${cp.text}`;
  return head + fileBlocks(files);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // ---- checkpoint_update: the model keeps its own state on disk ----
  pi.registerTool({
    name: "checkpoint_update",
    label: "Checkpoint Update",
    description:
      "Overwrite this session's checkpoint file with your current state. The checkpoint is the single source of truth folded into context at compaction — if it is stale or missing, compaction degrades to a mechanical skeleton of the span. " +
      "Call it at milestones: when starting a task (record the goal), after completing a significant step, after an important decision, after resolving an error, and before long or risky work. " +
      `Write FULL replacement content (keep under ~2000 chars; hard cap ${MAX_CHECKPOINT_CHARS}) as markdown with sections: GOAL (the user's actual intent), DONE (finished steps), DECISIONS (choices made and why), NEXT (what happens next), STATE (key variables, paths, test status — anything that must survive).`,
    parameters: Type.Object({
      text: Type.String({ description: "The full checkpoint content to write (markdown)." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = String(params.text ?? "").trim().slice(0, MAX_CHECKPOINT_CHARS);
      if (!text) {
        return { content: [{ type: "text", text: "checkpoint_update ignored: empty text." }], details: {} };
      }
      const dir = checkpointDir();
      await mkdir(dir, { recursive: true });
      let sessionId: string | null = null;
      try {
        sessionId = ctx.sessionManager.getSessionId();
      } catch {
        // ephemeral: fall back to the shared file
      }
      const file = sessionId ? join(dir, sessionId + ".md") : join(dir, "active.md");
      await writeFile(file, text + "\n", "utf8");
      return {
        content: [
          {
            type: "text",
            text: `Checkpoint saved (${text.length} chars → ${file}). While it stays fresh, compaction folds it in place of an LLM summary.`,
          },
        ],
        details: { file, chars: text.length },
      };
    },
  });

  // ---- compaction hook: the heart of the port ----
  pi.on("session_before_compact", async (event, ctx) => {
    try {
      const { preparation } = event;
      const messages = preparation.messagesToSummarize as unknown as AnyMessage[];
      if (!Array.isArray(messages) || messages.length === 0) return; // nothing to fold → default
      if (preparation.isSplitTurn) return; // rare mid-turn cut → default LLM
      if (event.customInstructions) return; // user asked for a focused LLM summary → default

      let sessionId: string | null = null;
      try {
        sessionId = ctx.sessionManager.getSessionId();
      } catch {
        // ok
      }

      // boundary = newest model/tool work in the shadowed span (port of
      // dsh-checkpoint shadowBoundaryMs). User prompts alone never invalidate
      // a checkpoint: the model's last word is the checkpoint.
      let boundary = -Infinity;
      for (const m of messages) {
        const t = m?.timestamp;
        if (typeof t !== "number") continue;
        const role = m?.role;
        if (role === "assistant" || role === "toolResult") boundary = Math.max(boundary, t);
      }
      const boundaryMs = boundary === -Infinity ? null : boundary;

      const files = fileLists(preparation.fileOps as FileOpsLike);

      // TIER 1: fresh checkpoint → fold it, no LLM call.
      const fresh = await readCheckpoint(sessionId, boundaryMs);
      if (fresh) {
        return {
          compaction: {
            summary: foldSummary(fresh, files),
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
            details: files,
          },
        };
      }

      // TIER 2: mechanical digest, latest checkpoint (even stale) as anchor.
      const anchor = await readCheckpoint(sessionId, null);
      const digest = mechanicalDigest(messages, anchor);
      if (digest) {
        return {
          compaction: {
            summary: digest + fileBlocks(files),
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
            details: files,
          },
        };
      }

      // TIER 3: nothing digestible → pi's default LLM summarization.
      return;
    } catch (err) {
      console.error(`[checkpoint-compaction] handler error, defaulting to LLM summarizer: ${String((err as Error)?.message || err)}`);
      return;
    }
  });

  // ---- /checkpoint: inspect the current state file ----
  pi.registerCommand("checkpoint", {
    description: "Show this session's current checkpoint (the state file compaction folds)",
    handler: async (_args, ctx) => {
      let sessionId: string | null = null;
      try {
        sessionId = ctx.sessionManager.getSessionId();
      } catch {
        // ok
      }
      const cp = await readCheckpoint(sessionId, null);
      if (!cp) {
        ctx.ui.notify("No checkpoint yet (checkpoint_update not called within the last 12h).", "info");
        return;
      }
      ctx.ui.notify(
        `Checkpoint (${cp.file}, ${new Date(cp.mtimeMs).toISOString()}, ${cp.text.length} chars):\n${cp.text.slice(0, 2000)}`,
        "info",
      );
    },
  });
}

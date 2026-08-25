// Unit test for extensions/checkpoint-compaction.ts
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
const nodeRequire = createRequire(import.meta.url);
// pi loads extensions with jiti/static based on its own dist loader.js, so
// bare specifiers (typebox, @earendil-works/pi-coding-agent) resolve from pi's
// node_modules. Mirror that exactly by reusing pi's own jiti build.
const piRoot = `${execSync("npm prefix -g").toString().trim()}/lib/node_modules/@earendil-works/pi-coding-agent`;
const { createJiti } = nodeRequire(piRoot + "/node_modules/jiti/lib/jiti.cjs");
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const EXT = join(here, "extensions", "checkpoint-compaction.ts");

const PI_ROOT = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent";
// Mirror pi's production loader.js alias map (getAliases) for the bare
// specifiers this extension imports.
const alias = {
  typebox: nodeRequire.resolve("typebox", { paths: [PI_ROOT] }),
  "typebox/compile": nodeRequire.resolve("typebox/compile", { paths: [PI_ROOT] }),
  "typebox/value": nodeRequire.resolve("typebox/value", { paths: [PI_ROOT] }),
  "@earendil-works/pi-coding-agent": PI_ROOT + "/index.js",
};
const jiti = createJiti(PI_ROOT + "/dist/core/extensions/loader.js", { interopDefault: true, moduleCache: false, alias });
const mod = jiti(EXT);
const { mechanicalDigest, readCheckpoint, fileLists } = mod;

let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failed += 1;
};

// --- synthetic span: mirrors pi's real message shapes ---
const now = Date.now();
const noise = "build log line ".repeat(200);
const messages = [
  { role: "user", content: "Fix the login page and add rate limiting", timestamp: now - 300000 },
  {
    role: "assistant",
    content: [
      { type: "text", text: `Investigating. ${noise}` },
      { type: "toolCall", name: "read", arguments: { path: "/app/login.ts" } },
    ],
    timestamp: now - 290000,
  },
  {
    role: "toolResult",
    content: [{ type: "text", text: `${"line of code ".repeat(60)} ${noise}` }],
    isError: false,
    timestamp: now - 280000,
  },
  {
    role: "toolResult",
    content: [{ type: "text", text: `Error: ENOENT no such file '/app/login.ts' ${noise}` }],
    isError: true,
    timestamp: now - 270000,
  },
  { role: "assistant", content: [{ type: "text", text: "Found it at src/login.ts; applied the fix and the rate limiter." }], timestamp: now - 260000 },
  { role: "user", content: "Also update the docs please", timestamp: now - 250000 },
  {
    role: "compactionSummary",
    summary: "Previous summary: goal was X, did Y, decided Z, next W.",
    timestamp: now - 240000,
  },
  { role: "user", content: "<system-reminder>runtime context</system-reminder>", timestamp: now - 230000 },
];

// --- TIER 2: digest with stale anchor ---
const anchor = { file: "/tmp/x.md", text: "GOAL: fix login\nDECISIONS: express middleware\nNEXT: docs", mtimeMs: now - 7 * 3600e3 };
const digest = mechanicalDigest(messages, anchor);
check("digest is non-null", typeof digest === "string");
check("digest captures user ask 1", digest?.includes("[USER] Fix the login page and add rate limiting"));
check("digest captures user ask 2", digest?.includes("[USER] Also update the docs please"));
check("digest captures assistant decision", digest?.includes("Found it at src/login.ts"));
check("digest captures tool error", digest?.includes("[TOOL-ERROR] Error: ENOENT"));
check("digest anchors to checkpoint", digest?.includes("## Goal / state carried from checkpoint") && digest?.includes("express middleware"));
check("digest carries prior summary labeled", digest?.includes("[STATE-CARRIED] Previous summary: goal was X"));
check("digest skips boilerplate user msg", !digest?.includes("[USER] <system-reminder>"));
check("digest header counts", digest?.startsWith("# Span digest (harness-recorded, no LLM)\n2 user request(s), 2 assistant step(s), 1 tool call(s)"));
check("digest under 6000 chars", (digest?.length || 99999) <= 6000);

// dedicated large span to force keep-most-recent elision
const big = [];
for (let i = 0; i < 60; i++) {
  big.push({ role: "user", content: `Request number ${i}: please do a distinct piece of work`, timestamp: now - 600000 + i * 1000 });
  big.push({ role: "assistant", content: [{ type: "text", text: `I did work ${i} and here is a fairly long explanation of what I did and why. ` }], timestamp: now - 600000 + i * 1000 + 500 });
}
const bigDigest = mechanicalDigest(big, null);
check("large span elides oldest lines", bigDigest?.includes("(earlier activity elided"));
check("large span keeps most-recent request", bigDigest?.includes("[USER] Request number 59:"));
check("large span drops oldest request", !bigDigest?.includes("[USER] Request number 0:"));
check("large span header counts 60 users", bigDigest?.includes("60 user request(s)"));

console.log("\n--- digest sample ---\n" + (digest || "").slice(0, 700) + "\n");

// --- no messages, no anchor → null (tier 3 fallback path) ---
check("empty span, no anchor → null", mechanicalDigest([], null) === null);
check("boilerplate-only span, no anchor → null", mechanicalDigest([messages[7]], null) === null);

// --- readCheckpoint: temp dir, per-session + active fallback + age + freshness ---
const dir = "/tmp/pi-checkpoint-test";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const sid = "test-session-123";
writeFileSync(join(dir, sid + ".md"), "GOAL: from per-session file\nDONE: step 1\n");
writeFileSync(join(dir, "active.md"), "GOAL: from active fallback\n");
writeFileSync(join(dir, "stale-session.md"), "GOAL: stale\n");
const stale = join(dir, "stale-session.md");
// --- readCheckpoint: age cap + freshness, in CLEAN dirs (no active.md fallback confounding) ---
import("node:fs").then(async (fs) => {
  const { default: fsp } = await import("node:fs/promises");
  // (a) per-session preference + active.md fallback, shared dir
  const r1 = await readCheckpoint(sid, null, dir);
  check("per-session file preferred", r1?.file === join(dir, sid + ".md") && r1?.text.includes("per-session"));
  const r2 = await readCheckpoint("unknown-session", null, dir);
  check("active.md fallback for unknown session", r2?.file === join(dir, "active.md"));

  // (b) 12h age cap: dir with ONLY a 13h-old per-session file, no fallback
  const dirStale = "/tmp/pi-checkpoint-stale";
  rmSync(dirStale, { recursive: true, force: true });
  fs.mkdirSync(dirStale, { recursive: true });
  fs.writeFileSync(join(dirStale, sid + ".md"), "GOAL: stale\n");
  fs.utimesSync(join(dirStale, sid + ".md"), new Date(Date.now() - 13 * 3600e3), new Date(Date.now() - 13 * 3600e3));
  const rStale = await readCheckpoint(sid, null, dirStale);
  check("12h age cap excludes 13h-old file", rStale === null);

  // (c) freshness: dir with ONLY a fresh per-session file (mtime = now)
  const dirFresh = "/tmp/pi-checkpoint-fresh";
  rmSync(dirFresh, { recursive: true, force: true });
  fs.mkdirSync(dirFresh, { recursive: true });
  fs.writeFileSync(join(dirFresh, sid + ".md"), "GOAL: fresh checkpoint\n");
  const st = await fsp.stat(join(dirFresh, sid + ".md"));
  const mt = st.mtimeMs;
  // work 2min AFTER checkpoint write (beyond 60s epsilon) → NOT fresh
  const c1 = await readCheckpoint(sid, mt + 120000, dirFresh);
  check("work 2min after checkpoint → NOT fresh", c1 === null);
  // work 30s before checkpoint write (within epsilon / checkpoint after work) → fresh
  const c2 = await readCheckpoint(sid, mt - 30000, dirFresh);
  check("work 30s before checkpoint → fresh", c2 !== null && c2.text.includes("fresh checkpoint"));
  // work exactly at checkpoint time → fresh
  const c3 = await readCheckpoint(sid, mt, dirFresh);
  check("work at checkpoint time → fresh", c3 !== null);
  // no boundary (anchor read) → fresh regardless
  const c4 = await readCheckpoint(sid, null, dirFresh);
  check("anchor read (no boundary) → fresh", c4 !== null);

  rmSync(dir, { recursive: true, force: true });
  rmSync(dirStale, { recursive: true, force: true });
  rmSync(dirFresh, { recursive: true, force: true });

  // --- fileLists ---
  const fl = fileLists({ read: new Set(["b.ts", "a.ts", "c.ts"]), written: new Set(["c.ts"]), edited: new Set(["a.ts"]) });
  check("fileLists: read minus modified", JSON.stringify(fl.readFiles) === JSON.stringify(["b.ts"]));
  check("fileLists: modified = written+edited sorted", JSON.stringify(fl.modifiedFiles) === JSON.stringify(["a.ts", "c.ts"]));

  // --- default export loads and registers without throwing (mock API) ---
  const calls = [];
  const mockApi = {
    registerTool: (t) => calls.push(["tool", t.name]),
    on: (name, _h) => calls.push(["on", name]),
    registerCommand: (name) => calls.push(["cmd", name]),
    registerHook: () => {},
  };
  try {
    mod.default(mockApi);
    check("default export registers tool+hook+command",
      calls.includes("tool") || JSON.stringify(calls).includes('"checkpoint_update"'));
  } catch (e) {
    check("default export registers tool+hook+command", false);
    console.error(e);
  }
  console.log(failed === 0 ? "\nALL TESTS PASSED" : `\n${failed} TEST(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, hookOutput } from "../hooks/radio-check.mjs";

const HOOK = new URL("../hooks/radio-check.mjs", import.meta.url).pathname;
const enforce = { mode: "enforce", ackTimeoutSec: 180, workTimeoutSec: 900 };
const now = new Date("2026-10-05T12:00:00Z");

test("decide assigns the next id to a call and says so", () => {
  const d = decide({ to: "bob", message: "[CALL] W/U Run the tests." }, [], enforce, now);
  assert.equal(d.message, "[CALL R-1] W/U Run the tests.");
  assert.equal(d.entry.id, "R-1");
  assert.match(d.context, /sent as \[CALL R-1\]/);
  assert.equal("text" in d.entry || "message" in d.entry, false, "the ledger never stores text");
});

test("hookOutput rewrites message and its content copy", () => {
  const input = { to: "bob", message: "[CALL] R main is green", content: "[CALL] R main is green" };
  const out = hookOutput(input, decide(input, [], enforce, now)).hookSpecificOutput;
  assert.equal(out.updatedInput.message, "[CALL R-1] R main is green");
  assert.equal(out.updatedInput.content, "[CALL R-1] R main is green");
  assert.equal(out.permissionDecision, "allow");
});

test("leading blank lines do not hide the head", () => {
  assert.equal(decide({ to: "lead", message: "\n\nWILCO R-1" }, [{ kind: "call", id: "R-1", attr: "W/U", at: "2026-10-05T11:59:00Z" }], enforce, now).entry.kind, "reply");
});

test("decide blocks in enforce mode and records in log mode", () => {
  const blocked = decide({ to: "lead", message: "on it!" }, [], enforce, now);
  assert.match(blocked.block, /first line must be/);
  assert.equal(blocked.entry.kind, "blocked");
  const logged = decide({ to: "lead", message: "on it!" }, [], { ...enforce, mode: "log" }, now);
  assert.equal(logged.block, undefined);
  assert.equal(logged.entry.kind, "unheaded");
});

test("decide reports overdue calls on a ledger without sessions to a sender without one", () => {
  const entries = [{ kind: "call", id: "R-1", attr: "W/U", to: "bob", at: "2026-10-05T11:50:00Z" }];
  const d = decide({ to: "carol", message: "[CALL] R FYI main is green." }, entries, enforce, now);
  assert.match(d.context, /R-1 to bob .* overdue — resend it once/);
});

test("overdue notes go only to the session that sent the call", () => {
  const entries = [{ kind: "call", id: "R-1", attr: "W/U", to: "carol", session: "sess-lead", at: "2026-10-05T11:50:00Z" }];
  const bob = decide({ to: "lead", message: "[CALL] R tests are green" }, entries, enforce, now, "sess-bob");
  assert.equal(bob.context ?? "", "radio: sent as [CALL R-2] R tests are green");
  const lead = decide({ to: "dave", message: "[CALL] R tests are green" }, entries, enforce, now, "sess-lead");
  assert.match(lead.context, /R-1 to carol .* resend it once/);
});

test("only the session that sent a call may resend it", () => {
  const entries = [{ kind: "call", id: "R-1", attr: "W/U", to: "carol", session: "sess-lead", at: "2026-10-05T11:50:00Z" }];
  const bob = decide({ to: "erin", message: "[CALL R-1] W/U Rotate the key" }, entries, enforce, now, "sess-bob");
  assert.match(bob.block, /sent by another session/);
  assert.equal(bob.entry.reason, "not-your-call");
  assert.equal(decide({ to: "erin", message: "[CALL R-1] W/U Rotate the key" }, entries, enforce, now, null).entry.reason, "not-your-call");
  const lead = decide({ to: "carol", message: "[CALL R-1] W/U Rotate the key" }, entries, enforce, now, "sess-lead");
  assert.equal(lead.entry.resend, true);
  // the real owner was never marked as having resent: its next overdue note still says resend
  assert.equal(decide({ to: "x", message: "[CALL] R ping" }, [...entries, bob.entry], enforce, now, "sess-lead").context.includes("resend it once"), true);
});

test("an escalation note is given once, then the call is retired", () => {
  const entries = [
    { kind: "call", id: "R-1", attr: "W/U", to: "dave", session: "sess-lead", at: "2026-10-05T11:30:00Z" },
    { kind: "call", id: "R-1", attr: "W/U", to: "dave", session: "sess-lead", at: "2026-10-05T11:40:00Z", resend: true },
  ];
  const first = decide({ to: "bob", message: "[CALL] R update 1" }, entries, enforce, now, "sess-lead");
  assert.match(first.context, /ESCALATE: R-1/);
  assert.deepEqual(first.extra.map((e) => [e.kind, e.id, e.action, e.session]), [["clock", "R-1", "escalate", "sess-lead"]]);
  const ledger = [...entries, first.entry, ...first.extra];
  const second = decide({ to: "bob", message: "[CALL] R update 2" }, ledger, enforce, now, "sess-lead");
  assert.doesNotMatch(second.context, /ESCALATE/);
  assert.deepEqual(second.extra, []);
});

test("near-miss heads get a precise reason", () => {
  const entries = [{ kind: "call", id: "R-1", attr: "W/U", at: "2026-10-05T11:59:00Z" }];
  const d = decide({ to: "lead", message: "**WILCO R-1**" }, entries, enforce, now);
  assert.match(d.block, /almost a head\. Remove the markdown around the head: start the line with WILCO R-1\./);
  assert.equal(d.entry.reason, "near-head");
  assert.equal(decide({ to: "lead", message: "WILCO R-1." }, entries, enforce, now).entry.kind, "reply");
});

function sandbox(config) {
  const dir = mkdtempSync(join(tmpdir(), "radio-test-"));
  if (config) {
    mkdirSync(join(dir, ".radio"));
    writeFileSync(join(dir, ".radio", "config.json"), JSON.stringify(config));
  }
  mkdirSync(join(dir, "sub"));
  return dir;
}
const run = (cwd, tool_input, tool_name = "SendMessage") =>
  spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input, cwd }), encoding: "utf8", env: { ...process.env, RADIO_DIR: "" } });

test("hook process: off without a config", () => {
  const dir = sandbox(null);
  try {
    const r = run(dir, { to: "bob", message: "anything goes" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook process: full exchange from a subfolder, ledger without text", () => {
  const dir = sandbox({ mode: "enforce" });
  try {
    const sub = join(dir, "sub");
    const c = run(sub, { to: "bob", message: "[CALL] W/U Run the secret-named tests." });
    assert.equal(c.status, 0);
    assert.equal(JSON.parse(c.stdout).hookSpecificOutput.updatedInput.message, "[CALL R-1] W/U Run the secret-named tests.");
    const bad = run(sub, { to: "lead", message: "ok will do" });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /message not sent/);
    assert.equal(run(sub, { to: "lead", message: "WILCO R-1" }).status, 0);
    assert.equal(run(sub, { to: "lead", message: "ROGER R-1" }).status, 2);
    assert.equal(run(sub, { to: "lead", message: "DONE R-1 — 3 passed" }).status, 0);
    assert.equal(run(sub, { to: "x" }, "Bash").status, 0);
    const ledger = readFileSync(join(dir, ".radio", "ledger.jsonl"), "utf8");
    assert.equal(ledger.trim().split("\n").length, 5);
    assert.equal(ledger.includes("secret"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook process: a broken config blocks with a clear message", () => {
  const dir = sandbox(null);
  try {
    mkdirSync(join(dir, ".radio"));
    writeFileSync(join(dir, ".radio", "config.json"), "{nope");
    const r = run(dir, { to: "bob", message: "WILCO R-1" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /config.json is not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const UNSENT = new URL("../hooks/radio-unsent.mjs", import.meta.url).pathname;
const CLOCK = new URL("../hooks/radio-clock.mjs", import.meta.url).pathname;
const stopHook = (hook, cwd, transcript, extra = {}) =>
  spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "sess-bob", cwd, transcript_path: transcript, stop_hook_active: false, ...extra }),
    encoding: "utf8",
    timeout: 8000,
    env: { ...process.env, RADIO_DIR: "" },
  });
function transcriptWith(dir, text) {
  const file = join(dir, "transcript.jsonl");
  const lines = [
    { type: "user", message: { content: "[CALL R-1] W/U Run the tests" } },
    { type: "assistant", message: { content: [{ type: "text", text }] } },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

test("radio-unsent: the ledger gets the head fields, never the text", () => {
  const dir = sandbox({ mode: "enforce" });
  try {
    const marker = "ghp_" + "A1".repeat(18);
    const r = stopHook(UNSENT, dir, transcriptWith(dir, `**DONE R-1 — 212 passed, token ${marker} in my_file.ts**`));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /You wrote "DONE R-1 — 212 passed, token ghp_A1/, "markdown removed, underscores kept");
    const ledger = readFileSync(join(dir, ".radio", "ledger.jsonl"), "utf8");
    const line = JSON.parse(ledger);
    assert.deepEqual({ kind: line.kind, head: line.head, word: line.word, id: line.id, session: line.session }, { kind: "unsent", head: "reply", word: "DONE", id: "R-1", session: "sess-bob" });
    for (const leak of ["A1A1", "212", "passed", "my_file", "myfile"]) assert.equal(ledger.includes(leak), false, `ledger holds "${leak}"`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("radio-clock: lets radio-unsent's block through at once instead of waiting", () => {
  const dir = sandbox({ mode: "enforce", ackTimeoutSec: 600, workTimeoutSec: 900, clockBudgetSec: 900 });
  try {
    // sess-bob has an open call, so without the unsent check the clock would wait up to 10 minutes
    writeFileSync(join(dir, ".radio", "ledger.jsonl"), JSON.stringify({ v: 1, kind: "call", id: "R-2", attr: "W/U", to: "lead", session: "sess-bob", at: new Date().toISOString() }) + "\n");
    const t0 = Date.now();
    const r = stopHook(CLOCK, dir, transcriptWith(dir, "DONE R-1 — 3 passed"));
    assert.equal(r.status, 0, `clock still waiting after ${Date.now() - t0} ms`);
    assert.ok(Date.now() - t0 < 5000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

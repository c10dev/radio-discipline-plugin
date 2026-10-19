import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clockStep } from "../lib/clock.mjs";
import { callStates, overdueLines } from "../lib/ledger.mjs";
import { failureOf, sentLine, undeliveredEntry } from "../lib/undelivered.mjs";
import { decide } from "../hooks/radio-check.mjs";
import { runClock } from "../hooks/radio-clock.mjs";

// SendMessage results as Claude Code 2.1.303 gives them to a PostToolUse hook (tool_response)
const UNREACHABLE = { success: false, message: "No agent named 'ghost' is reachable.\nUse ListAgents to see everyone you can message.", display: "Not sent — no agent named 'ghost' is reachable." };
const QUEUED = { success: true, message: "Message queued for delivery to pinger at its next tool round.", pin: { id: "a7e45b6cdbf89296c", name: "pinger", ref: "9509f4" } };

test("failureOf: a failed send gives a reason class, a delivered one gives null", () => {
  assert.equal(failureOf(UNREACHABLE), "unreachable");
  assert.equal(failureOf(JSON.stringify(UNREACHABLE)), "unreachable");
  assert.equal(failureOf([{ type: "text", text: JSON.stringify(UNREACHABLE) }]), "unreachable");
  assert.equal(failureOf({ success: false, message: "mailbox full" }), "rejected");
  assert.equal(failureOf({ success: false }), "rejected");
  assert.equal(failureOf("Error: SendMessage crashed"), "error");
  assert.equal(failureOf({ is_error: true }), "error");
  assert.equal(failureOf({ error: "boom" }), "error");
  for (const ok of [QUEUED, JSON.stringify(QUEUED), [{ type: "text", text: JSON.stringify(QUEUED) }], { success: true, error: "ignored" }, "sent", undefined, null, 42, []]) {
    assert.equal(failureOf(ok), null, JSON.stringify(ok));
  }
});

test("the undelivered line has head fields, a reason class and the tool id, never text", () => {
  const call = { v: 1, at: "2026-10-19T12:00:00Z", session: "lead", to: "ghost", kind: "call", id: "R-1", attr: "R", resend: false, tool: "toolu_A" };
  const reply = { v: 1, at: "2026-10-19T12:00:00Z", session: "bob", to: "lead", kind: "reply", id: "R-2", word: "DONE", tool: "toolu_B" };
  assert.equal(sentLine([call, reply], "toolu_A"), call);
  assert.equal(sentLine([call, reply], "toolu_X"), null);
  assert.equal(sentLine([{ ...call, kind: "blocked" }], "toolu_A"), null, "a blocked message was never sent");
  const now = new Date("2026-10-19T12:00:01Z");
  assert.deepEqual(undeliveredEntry(call, "unreachable", "lead", now), { v: 1, at: "2026-10-19T12:00:01.000Z", session: "lead", kind: "undelivered", head: "call", id: "R-1", reason: "unreachable", tool: "toolu_A" });
  assert.deepEqual(undeliveredEntry(reply, "error", "bob", now), { v: 1, at: "2026-10-19T12:00:01.000Z", session: "bob", kind: "undelivered", head: "reply", word: "DONE", id: "R-2", reason: "error", tool: "toolu_B" });
});

const cfg = { ackTimeoutSec: 180, workTimeoutSec: 900, clockBudgetSec: 1000 };
const base = Date.UTC(2026, 9, 19, 12, 0);
const t = (min) => new Date(base + min * 60_000).toISOString();
const ms = (min) => base + min * 60_000;
const call = (id, min, tool, resend = false, session = "lead") => ({ kind: "call", id, attr: "W/U", to: "dave", session, at: t(min), resend, tool });
const reply = (id, word, min, tool, session = "dave") => ({ kind: "reply", id, word, session, at: t(min), tool });
const gone = (tool, id, min, session = "lead") => ({ kind: "undelivered", head: "call", id, reason: "unreachable", session, at: t(min), tool });

test("an undelivered call is not open: no overdue note, no wait", () => {
  const e = [call("R-1", 0, "toolu_A"), gone("toolu_A", "R-1", 0)];
  assert.deepEqual(callStates(e, ms(30), cfg), []);
  assert.deepEqual(overdueLines(callStates(e, ms(30), cfg), ms(30)), []);
  assert.equal(clockStep(e, "lead", ms(1), cfg).kind, "done");
  assert.equal(clockStep(e, "lead", ms(30), cfg).kind, "done");
});

test("the overdue note on the next send does not name an undelivered call", () => {
  const e = [call("R-1", 0, "toolu_A"), gone("toolu_A", "R-1", 0)];
  const d = decide({ to: "bob", message: "[CALL] R main is green" }, e, cfg, new Date(ms(10)), "lead");
  assert.equal(d.context, "radio: sent as [CALL R-2] R main is green");
  assert.deepEqual(d.extra, []);
});

test("a delivered resend of an undelivered call revives it as a first send", () => {
  const e = [call("R-1", 0, "toolu_A"), gone("toolu_A", "R-1", 0), call("R-1", 5, "toolu_B", true)];
  const [s] = callStates(e, ms(6), cfg);
  assert.equal(s.status, "open");
  assert.equal(s.resends, 0);
  assert.equal(s.sentAt, t(5));
  assert.equal(clockStep(e, "lead", ms(6), cfg).kind, "wait");
  // overdue after its own ack timeout, and the first note says resend, not escalate
  const late = callStates(e, ms(9), cfg)[0];
  assert.equal(late.action, "resend");
});

test("an undelivered resend counts for nothing: the next note still says resend", () => {
  const e = [
    call("R-1", 0, "toolu_A"),
    { kind: "clock", session: "lead", id: "R-1", action: "resend", at: t(4) },
    call("R-1", 4, "toolu_B", true),
    gone("toolu_B", "R-1", 4),
  ];
  const [s] = callStates(e, ms(5), cfg);
  assert.equal(s.resends, 0);
  assert.equal(s.action, "resend");
  assert.match(overdueLines([s], ms(5))[0], /resend it once/);
});

test("an undelivered reply neither answers nor closes the call", () => {
  const e = [call("R-1", 0, "toolu_A"), reply("R-1", "DONE", 1, "toolu_B"), { ...gone("toolu_B", "R-1", 1, "dave"), head: "reply", word: "DONE" }];
  const [s] = callStates(e, ms(2), cfg);
  assert.equal(s.status, "open");
  assert.equal(clockStep(e, "lead", ms(2), cfg).kind, "wait");
});

test("runClock: a message from another session that was not delivered does not end the wait", async () => {
  let clock = ms(1);
  const ledger = [call("R-1", 0, "toolu_A")];
  let reads = 0;
  const r = await runClock({
    radioDir: "x", session: "lead", cfg: { ...cfg, ackTimeoutSec: 120 }, now: () => clock,
    pause: async (d) => { clock += d; },
    read: () => {
      if (++reads === 3) ledger.push(call("R-2", 1, "toolu_C", false, "carol"), gone("toolu_C", "R-2", 1, "carol"));
      return [...ledger];
    },
    append: (_, e) => ledger.push(e),
  });
  assert.equal(r.why, "overdue");
});

// The hooks as Claude Code runs them: PreToolUse, the tool, PostToolUse, then the Stop hook.
const hook = (name) => new URL(`../hooks/${name}.mjs`, import.meta.url).pathname;
const runHook = (name, input, timeout = 8000) =>
  spawnSync(process.execPath, [hook(name)], { input: JSON.stringify(input), encoding: "utf8", timeout, env: { ...process.env, RADIO_DIR: "" } });
const SESSION = "sess-lead";

function project(config) {
  const dir = mkdtempSync(join(tmpdir(), "radio-undelivered-"));
  mkdirSync(join(dir, ".radio"));
  writeFileSync(join(dir, ".radio", "config.json"), JSON.stringify(config));
  return dir;
}
const ledgerOf = (dir) => readFileSync(join(dir, ".radio", "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
// one SendMessage: PreToolUse with this tool id, then PostToolUse with the given result
function send(dir, tool_input, tool_use_id, tool_response) {
  const pre = runHook("radio-check", { hook_event_name: "PreToolUse", session_id: SESSION, cwd: dir, tool_name: "SendMessage", tool_input, tool_use_id });
  assert.equal(pre.status, 0, pre.stderr);
  const sent = pre.stdout ? JSON.parse(pre.stdout).hookSpecificOutput.updatedInput ?? tool_input : tool_input;
  const post = runHook("radio-undelivered", { hook_event_name: "PostToolUse", session_id: SESSION, cwd: dir, tool_name: "SendMessage", tool_input: { to: sent.to, message: sent.message }, tool_response, tool_use_id });
  assert.equal(post.status, 0, post.stderr);
  return post;
}

test("hook process: a send to an unreachable agent is marked undelivered and the clock does not wait", () => {
  const dir = project({ mode: "enforce", ackTimeoutSec: 600, workTimeoutSec: 900, clockBudgetSec: 900 });
  try {
    const marker = "secret-" + "Z9".repeat(8);
    const post = send(dir, { to: "ghost", message: `[CALL] R Status check ${marker}` }, "toolu_A", UNREACHABLE);
    const note = JSON.parse(post.stdout).hookSpecificOutput;
    assert.equal(note.hookEventName, "PostToolUse");
    assert.match(note.additionalContext, /\[CALL R-1\] was not delivered \(no agent by that name is reachable\)\. It does not count as sent/);

    const lines = ledgerOf(dir);
    assert.deepEqual(lines.map((e) => [e.kind, e.id, e.tool]), [["call", "R-1", "toolu_A"], ["undelivered", "R-1", "toolu_A"]]);
    assert.equal(lines[1].reason, "unreachable");
    const raw = readFileSync(join(dir, ".radio", "ledger.jsonl"), "utf8");
    for (const leak of ["Z9Z9", "Status", "reachable.", "ListAgents", "Not sent"]) assert.equal(raw.includes(leak), false, `ledger holds "${leak}"`);

    // without the fix this Stop hook waits until the call is overdue (10 minutes here)
    const t0 = Date.now();
    const stop = runHook("radio-clock", { hook_event_name: "Stop", session_id: SESSION, cwd: dir, stop_hook_active: false });
    assert.equal(stop.status, 0, `clock exit ${stop.status} after ${Date.now() - t0} ms: ${stop.stderr}`);
    assert.ok(Date.now() - t0 < 5000, `clock waited ${Date.now() - t0} ms`);

    // the same failure reported twice adds one line only
    runHook("radio-undelivered", { hook_event_name: "PostToolUse", session_id: SESSION, cwd: dir, tool_name: "SendMessage", tool_input: {}, tool_response: UNREACHABLE, tool_use_id: "toolu_A" });
    assert.equal(ledgerOf(dir).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook process: a delivered resend after a failed send revives the call; success adds nothing", () => {
  const dir = project({ mode: "enforce" });
  try {
    send(dir, { to: "ghost", message: "[CALL] W/U Run the tests" }, "toolu_A", UNREACHABLE);
    const post = send(dir, { to: "bob", message: "[CALL R-1] W/U Run the tests" }, "toolu_B", QUEUED);
    assert.equal(post.stdout, "", "a delivered message gets no note");
    const lines = ledgerOf(dir);
    assert.deepEqual(lines.map((e) => [e.kind, e.id, e.tool, e.resend ?? null]), [["call", "R-1", "toolu_A", false], ["undelivered", "R-1", "toolu_A", null], ["call", "R-1", "toolu_B", true]]);
    const [s] = callStates(lines, Date.now(), { ackTimeoutSec: 180, workTimeoutSec: 900 });
    assert.deepEqual([s.id, s.status, s.resends, s.to], ["R-1", "open", 0, "bob"]);
    assert.equal(clockStep(lines, SESSION, Date.now(), { ackTimeoutSec: 180, workTimeoutSec: 900 }).kind, "wait");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook process: a failed reply is marked undelivered and the model is told to send it again", () => {
  const dir = project({ mode: "enforce" });
  try {
    writeFileSync(join(dir, ".radio", "ledger.jsonl"), JSON.stringify({ v: 1, kind: "call", id: "R-1", attr: "W/U", to: "bob", session: "sess-other", at: new Date().toISOString() }) + "\n");
    const post = send(dir, { to: "lead", message: "DONE R-1 — 3 passed" }, "toolu_R", { success: false, message: "mailbox closed" });
    assert.match(JSON.parse(post.stdout).hookSpecificOutput.additionalContext, /DONE R-1 was not delivered \(SendMessage refused it\)\. The caller has not received it/);
    const lines = ledgerOf(dir);
    const { kind, head, word, id, reason, tool } = lines.at(-1);
    assert.deepEqual({ kind, head, word, id, reason, tool }, { kind: "undelivered", head: "reply", word: "DONE", id: "R-1", reason: "rejected", tool: "toolu_R" });
    assert.equal(callStates(lines, Date.now(), { ackTimeoutSec: 180, workTimeoutSec: 900 })[0].status, "open");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook process: radio-undelivered is silent off the radio, for unknown tool ids and for other tools", () => {
  const off = mkdtempSync(join(tmpdir(), "radio-off-"));
  const dir = project({ mode: "enforce" });
  try {
    const post = (cwd, extra) => runHook("radio-undelivered", { hook_event_name: "PostToolUse", session_id: SESSION, cwd, tool_name: "SendMessage", tool_input: {}, tool_response: UNREACHABLE, tool_use_id: "toolu_Q", ...extra });
    for (const r of [post(off), post(dir), post(dir, { tool_name: "Bash" }), post(dir, { tool_use_id: undefined })]) {
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "");
    }
    assert.throws(() => readFileSync(join(dir, ".radio", "ledger.jsonl")), /ENOENT/);
  } finally {
    rmSync(off, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

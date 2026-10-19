import { test } from "node:test";
import assert from "node:assert/strict";
import { clockStep } from "../lib/clock.mjs";
import { clockBudgetMs, runClock } from "../hooks/radio-clock.mjs";

const cfg = { ackTimeoutSec: 120, workTimeoutSec: 360, clockBudgetSec: 1000 };
const base = Date.UTC(2026, 9, 5, 12, 0);
const t = (sec) => new Date(base + sec * 1000).toISOString();
const call = (id, sec, session = "lead") => ({ kind: "call", id, attr: "W/U", to: "dave", session, at: t(sec) });
const reply = (id, word, sec, session = "dave") => ({ kind: "reply", id, word, session, at: t(sec) });

test("nothing open, or someone else's call: done", () => {
  assert.equal(clockStep([], "lead", base, cfg).kind, "done");
  assert.equal(clockStep([call("R-1", 0, "other")], "lead", base, cfg).kind, "done");
  assert.equal(clockStep([call("R-1", 0)], null, base, cfg).kind, "done");
});

test("open and not due: wait until the first due time", () => {
  const s = clockStep([call("R-1", 0), reply("R-1", "WILCO", 10)], "lead", base + 60_000, cfg);
  assert.equal(s.kind, "wait");
  assert.equal(s.untilMs, base + (10 + 360) * 1000 + 1000);
});

test("overdue: notify once per call and action", () => {
  const e = [call("R-1", 0), reply("R-1", "WILCO", 10)];
  const s = clockStep(e, "lead", base + 400_000, cfg);
  assert.equal(s.kind, "notify");
  assert.deepEqual(s.items, [{ id: "R-1", action: "resend" }]);
  assert.match(s.text, /R-1 to dave .* resend it once/);
  const after = [...e, { kind: "clock", session: "lead", id: "R-1", action: "resend", at: t(400) }];
  assert.equal(clockStep(after, "lead", base + 401_000, cfg).kind, "done");
  const resent = [...after, { ...call("R-1", 410), resend: true }];
  assert.equal(clockStep(resent, "lead", base + 500_000, cfg).kind, "wait");
  const s2 = clockStep(resent, "lead", base + 540_000, cfg);
  assert.deepEqual(s2.items, [{ id: "R-1", action: "escalate" }]);
  assert.match(s2.text, /ESCALATE: R-1/);
});

test("runClock: new traffic from another session ends the wait", async () => {
  let clock = base + 60_000;
  const ledger = [call("R-1", 0)];
  let reads = 0;
  const r = await runClock({
    radioDir: "x", session: "lead", cfg, now: () => clock,
    pause: async (ms) => { clock += ms; },
    read: () => (++reads === 3 ? ledger.push(reply("R-1", "WILCO", 70)) : 0, [...ledger]),
    append: () => assert.fail("no clock line expected"),
  });
  assert.equal(r.why, "traffic");
});

test("runClock: blocks with the overdue text and records it", async () => {
  let clock = base + 60_000;
  const ledger = [call("R-1", 0)];
  const r = await runClock({
    radioDir: "x", session: "lead", cfg, now: () => clock,
    pause: async (ms) => { clock += ms; },
    read: () => [...ledger],
    append: (_, e) => ledger.push(e),
  });
  assert.equal(r.code, 2);
  assert.match(r.text, /overdue/);
  assert.equal(ledger.at(-1).kind, "clock");
  assert.ok(clock >= base + 121_000 && clock <= base + 125_000, `woke at ${(clock - base) / 1000}s`);
});

test("runClock: gives up after the budget", async () => {
  let clock = base;
  const r = await runClock({
    radioDir: "x", session: "lead", cfg: { ...cfg, clockBudgetSec: 30 }, now: () => clock,
    pause: async (ms) => { clock += ms; },
    read: () => [call("R-1", 0)],
    append: () => {},
  });
  assert.equal(r.why, "budget");
});

// runClock until it returns, with a ledger that gets `late` appended on the third read
async function clockWith(late, extraCfg = {}) {
  let clock = base + 60_000;
  const ledger = [call("R-1", 0), call("R-9", 0, "carol")];
  let reads = 0;
  return runClock({
    radioDir: "x", session: "lead", cfg: { ...cfg, ...extraCfg }, now: () => clock,
    pause: async (ms) => { clock += ms; },
    read: () => (++reads === 3 ? ledger.push(late) : 0, [...ledger]),
    append: (_, e) => ledger.push(e),
  });
}

test("runClock: lines that were never delivered do not end the wait", async () => {
  for (const late of [
    { kind: "blocked", reason: "no-head", session: "carol", to: "erin", at: t(61) },
    { kind: "unsent", head: "reply", word: "DONE", id: "R-9", session: "carol", at: t(61) },
    { kind: "clock", id: "R-9", action: "resend", session: "carol", at: t(61) },
  ]) {
    const r = await clockWith(late);
    assert.equal(r.why, "overdue", late.kind);
  }
});

test("runClock: a reply to another session's call does not end the wait; other delivered traffic does", async () => {
  assert.equal((await clockWith(reply("R-9", "WILCO", 61, "erin"))).why, "overdue");
  assert.equal((await clockWith(reply("R-1", "WILCO", 61))).why, "traffic");
  assert.equal((await clockWith({ kind: "unheaded", reason: "no-head", session: "erin", to: "lead", at: t(61) })).why, "traffic");
  assert.equal((await clockWith(call("R-10", 61, "erin"))).why, "traffic");
});

test("an escalated call is not waited for", () => {
  const e = [call("R-1", 0), { ...call("R-1", 130), resend: true }, { kind: "clock", session: "lead", id: "R-1", action: "escalate", at: t(260) }];
  assert.equal(clockStep(e, "lead", base + 270_000, cfg).kind, "done");
  // with another call still open, the wait is for that one only (no NaN from the escalated call)
  const s = clockStep([...e, call("R-2", 200)], "lead", base + 270_000, cfg);
  assert.equal(s.kind, "wait");
  assert.equal(s.untilMs, base + 321_000);
});

test("the clock budget is capped below the hook timeout", () => {
  assert.equal(clockBudgetMs({}), 1_080_000);
  assert.equal(clockBudgetMs({ clockBudgetSec: 99_999 }), 1_140_000);
  assert.equal(clockBudgetMs({ clockBudgetSec: "soon" }), 1_080_000);
  assert.equal(clockBudgetMs({ clockBudgetSec: 30 }), 30_000);
});

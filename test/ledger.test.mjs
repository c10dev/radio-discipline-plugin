import { test } from "node:test";
import assert from "node:assert/strict";
import { callStates, nextId, overdueLines } from "../lib/ledger.mjs";

const cfg = { ackTimeoutSec: 180, workTimeoutSec: 900 };
const t = (min) => new Date(Date.UTC(2026, 9, 5, 12, 0) + min * 60000).toISOString();
const ms = (min) => Date.parse(t(min));
const call = (id, min, attr = "W/U", resend = false) => ({ kind: "call", id, attr, to: "bob", at: t(min), resend });
const reply = (id, word, min) => ({ kind: "reply", id, word, at: t(min) });
const one = (entries, now) => callStates(entries, ms(now), cfg)[0];

test("next id follows the highest call id", () => {
  assert.equal(nextId([]), "R-1");
  assert.equal(nextId([call("R-2", 0), call("R-10", 1), reply("R-99", "WILCO", 2)]), "R-11");
});

test("a call with no reply goes overdue after the ack timeout, then asks for one resend", () => {
  assert.equal(one([call("R-1", 0)], 2).overdue, false);
  const s = one([call("R-1", 0)], 4);
  assert.equal(s.overdue, true);
  assert.equal(s.action, "resend");
});

test("after one resend, the next overdue asks to escalate", () => {
  const e = [call("R-1", 0), call("R-1", 4, "W/U", true)];
  assert.equal(one(e, 6).overdue, false);
  const s = one(e, 8);
  assert.equal(s.action, "escalate");
  assert.match(overdueLines([s], ms(8))[0], /ESCALATE: R-1/);
});

test("STANDBY keeps the call open and restarts the timer", () => {
  const e = [call("R-1", 0), reply("R-1", "STANDBY", 2)];
  assert.equal(one(e, 4).status, "standby");
  assert.equal(one(e, 4).overdue, false);
  assert.equal(one(e, 6).overdue, true);
});

test("WILCO starts the work timer; STANDBY during work is a heartbeat; DONE closes", () => {
  const e = [call("R-1", 0), reply("R-1", "WILCO", 1)];
  assert.equal(one(e, 10).status, "working");
  assert.equal(one(e, 10).overdue, false);
  assert.equal(one(e, 17).overdue, true);
  const beat = [...e, reply("R-1", "STANDBY", 14)];
  assert.equal(one(beat, 17).overdue, false);
  assert.equal(one(beat, 17).status, "working");
  const done = [...beat, reply("R-1", "DONE", 20)];
  assert.equal(one(done, 60).status, "closed");
  assert.equal(one(done, 60).closedBy, "DONE");
  assert.equal(one(done, 60).overdue, false);
});

test("UNABLE, ROGER, AFFIRM and NEGATIVE close; replies after closing change nothing", () => {
  for (const w of ["UNABLE", "ROGER", "AFFIRM", "NEGATIVE"]) {
    const s = one([call("R-1", 0), reply("R-1", w, 1), reply("R-1", "WILCO", 2)], 60);
    assert.equal(s.status, "closed");
    assert.equal(s.closedBy, w);
  }
});

test("replies to unknown ids are ignored", () => {
  assert.deepEqual(callStates([reply("R-5", "WILCO", 0)], ms(1), cfg), []);
});

test("an escalation retires the call; a late reply still closes or revives it", () => {
  const esc = (min, session) => ({ kind: "clock", id: "R-1", action: "escalate", session, at: t(min) });
  const e = [call("R-1", 0), call("R-1", 4, "W/U", true), esc(8)];
  const s = one(e, 9);
  assert.equal(s.status, "escalated");
  assert.equal(s.overdue, false);
  assert.equal(s.due, null);
  assert.deepEqual(overdueLines(callStates(e, ms(30), cfg), ms(30)), []);
  assert.equal(one([...e, reply("R-1", "DONE", 20)], 21).status, "closed");
  const revived = one([...e, reply("R-1", "WILCO", 20)], 21);
  assert.equal(revived.status, "working");
  assert.equal(one([...e, reply("R-1", "WILCO", 20)], 40).action, "escalate");
  // only the caller's own escalation retires a call
  assert.equal(one([call("R-1", 0), call("R-1", 4, "W/U", true), esc(8, "someone-else")], 9).status, "open");
});

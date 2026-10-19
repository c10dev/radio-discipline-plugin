// The radio clock: what a session that is about to go idle should do about the calls it sent.
// CPDLC keeps a ground timer per open message and tells the controller when it expires.
// An idle agent has no timer, so the Stop hook plays that part. Pure function, no I/O.
import { callStates, overdueLines } from "./ledger.mjs";

// Returns one of:
//   { kind: "done" }                      nothing of mine is open, or every overdue call was already reported
//   { kind: "wait", untilMs }             calls are open and not yet due: wait until the first due time
//   { kind: "notify", items, text }       calls became overdue and were not reported yet
// Escalated calls are not waited for: their caller already told the user.
export function clockStep(entries, session, nowMs, cfg) {
  if (!session) return { kind: "done" };
  const open = callStates(entries, nowMs, cfg).filter((s) => s.session === session && s.status !== "closed" && s.status !== "escalated");
  if (!open.length) return { kind: "done" };
  const reported = new Set(entries.filter((e) => e.kind === "clock" && e.session === session).map((e) => `${e.id}:${e.action}`));
  const fresh = open.filter((s) => s.overdue && !reported.has(`${s.id}:${s.action}`));
  if (fresh.length) {
    const text = ["radio clock: calls you sent are overdue.", ...overdueLines(fresh, nowMs)].join("\n");
    return { kind: "notify", items: fresh.map((s) => ({ id: s.id, action: s.action })), text };
  }
  const waiting = open.filter((s) => !s.overdue);
  if (!waiting.length) return { kind: "done" };
  return { kind: "wait", untilMs: Math.min(...waiting.map((s) => Date.parse(s.due))) + 1000 };
}

// Ledger lines that end the clock's wait: a message that may be for this session was delivered.
// Not counted: this session's own lines, clock lines, messages that were never delivered (blocked,
// a head written as text: unsent, or a send that failed: undelivered, which runClock also uses to
// skip the failed message's own line), and replies to calls that another session sent (they went to
// that session). The ledger names the receiver, not its session, so any delivered call or unheaded
// message counts.
export function isTrafficFor(e, session, owners) {
  if (e.session === session) return false;
  if (e.kind === "clock" || e.kind === "blocked" || e.kind === "unsent" || e.kind === "undelivered") return false;
  if (e.kind === "reply") {
    const owner = owners.get(e.id) ?? null;
    if (owner !== null && owner !== session) return false;
  }
  return true;
}

// Who sent each call: id -> session (or null when unknown).
export function callOwners(entries) {
  const owners = new Map();
  for (const e of entries) if (e.kind === "call" && e.id && !owners.has(e.id)) owners.set(e.id, e.session ?? null);
  return owners;
}

// The radio clock: what a session that is about to go idle should do about the calls it sent.
// CPDLC keeps a ground timer per open message and tells the controller when it expires.
// An idle agent has no timer, so the Stop hook plays that part. Pure function, no I/O.
import { callStates, overdueLines } from "./ledger.mjs";

// Returns one of:
//   { kind: "done" }                      nothing of mine is open, or every overdue call was already reported
//   { kind: "wait", untilMs }             calls are open and not yet due: wait until the first due time
//   { kind: "notify", items, text }       calls became overdue and were not reported yet
export function clockStep(entries, session, nowMs, cfg) {
  if (!session) return { kind: "done" };
  const open = callStates(entries, nowMs, cfg).filter((s) => s.session === session && s.status !== "closed");
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

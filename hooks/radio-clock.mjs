#!/usr/bin/env node
// Stop hook: when a session is about to go idle while calls it sent are open, wait for them.
// - A new delivered message from another session that may be for this one (see isTrafficFor) ends
//   the wait, so the session can stop and receive it.
// - If one of its calls becomes overdue first, block the stop (exit 2) and say what to do:
//   resend once, or escalate to the user. Each (call, action) is reported once.
// - The wait checks the ledger at least every 3 s and is capped (clockBudgetSec, default 1080 s, never
//   more than 1140 s: hooks.json gives this hook 1200 s). Off unless .radio/config.json exists,
//   or with "clock": false.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { callOwners, clockStep, isTrafficFor } from "../lib/clock.mjs";
import { appendLedger, openRadio, readLedger } from "../lib/ledger.mjs";
import { readTranscript, unsentHead } from "../lib/unsent.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_BUDGET_SEC = 1080;
export const MAX_BUDGET_SEC = 1140;

export function clockBudgetMs(cfg) {
  const sec = Number(cfg.clockBudgetSec ?? DEFAULT_BUDGET_SEC);
  return Math.max(0, Math.min(Number.isFinite(sec) ? sec : DEFAULT_BUDGET_SEC, MAX_BUDGET_SEC)) * 1000;
}

export async function runClock({ radioDir, session, cfg, now = () => Date.now(), pause = sleep, read = readLedger, append = appendLedger }) {
  const start = now();
  const budget = clockBudgetMs(cfg);
  const startLen = read(radioDir).length;
  for (;;) {
    const entries = read(radioDir);
    const owners = callOwners(entries);
    if (entries.slice(startLen).some((e) => isTrafficFor(e, session, owners))) return { code: 0, why: "traffic" };
    const step = clockStep(entries, session, now(), cfg);
    if (step.kind === "done") return { code: 0, why: "done" };
    if (step.kind === "notify") {
      const at = new Date(now()).toISOString();
      for (const it of step.items) append(radioDir, { v: 1, at, session, kind: "clock", id: it.id, action: it.action });
      return { code: 2, why: "overdue", text: step.text };
    }
    if (now() - start >= budget) return { code: 0, why: "budget" };
    await pause(Math.max(200, Math.min(3000, step.untilMs - now())));
  }
}

async function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return 0;
  }
  if (!input.session_id) return 0;
  let radio;
  try {
    radio = openRadio(input.cwd || process.cwd());
  } catch {
    return 0;
  }
  if (!radio) return 0;
  const { dir: radioDir, cfg } = radio;
  if (cfg.clock === false) return 0;
  // Stop hooks run in parallel and the stop waits for both. When radio-unsent is blocking this stop
  // to get a head sent, waiting here would hold its message back for minutes: let it through now.
  if (!input.stop_hook_active && cfg.unsent !== false && input.transcript_path && unsentHead(readTranscript(input.transcript_path))) return 0;
  const r = await runClock({ radioDir, session: input.session_id, cfg });
  if (r.code === 2) process.stderr.write(r.text + "\n");
  return r.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();

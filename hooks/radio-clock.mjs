#!/usr/bin/env node
// Stop hook: when a session is about to go idle while calls it sent are open, wait for them.
// - Any new ledger line from another session (a reply or any message) ends the wait, so the session
//   can stop and receive that message.
// - If one of its calls becomes overdue first, block the stop (exit 2) and say what to do:
//   resend once, or escalate to the user. Each (call, action) is reported once.
// - The wait is capped (clockBudgetSec). Off unless .radio/config.json exists.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { clockStep } from "../lib/clock.mjs";
import { appendLedger, findRadioDir, readConfig, readLedger } from "../lib/ledger.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runClock({ radioDir, session, cfg, now = () => Date.now(), pause = sleep, read = readLedger, append = appendLedger }) {
  const start = now();
  const budget = (cfg.clockBudgetSec ?? 1080) * 1000;
  const startLen = read(radioDir).length;
  for (;;) {
    const entries = read(radioDir);
    if (entries.slice(startLen).some((e) => e.session !== session && e.kind !== "clock")) return { code: 0, why: "traffic" };
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
  const radioDir = findRadioDir(input.cwd || process.cwd());
  if (!radioDir || !input.session_id) return 0;
  let cfg;
  try {
    cfg = readConfig(radioDir);
  } catch {
    return 0;
  }
  if (cfg.clock === false) return 0;
  const r = await runClock({ radioDir, session: input.session_id, cfg });
  if (r.code === 2) process.stderr.write(r.text + "\n");
  return r.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();

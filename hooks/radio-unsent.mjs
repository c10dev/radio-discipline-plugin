#!/usr/bin/env node
// Stop hook: if this turn wrote a radio head as text but sent no SendMessage, block the stop once
// and say so. Off without .radio/config.json or with "unsent": false.
import { readFileSync } from "node:fs";
import { appendLedger, findRadioDir, readConfig } from "../lib/ledger.mjs";
import { unsentHead } from "../lib/unsent.mjs";

function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { return 0; }
  if (input.stop_hook_active) return 0; // already continued once because of a stop hook
  const radioDir = findRadioDir(input.cwd || process.cwd());
  if (!radioDir || !input.transcript_path) return 0;
  try { if (readConfig(radioDir).unsent === false) return 0; } catch { return 0; }
  let entries;
  try {
    entries = readFileSync(input.transcript_path, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return 0; }
  const head = unsentHead(entries);
  if (!head) return 0;
  try { appendLedger(radioDir, { v: 1, at: new Date().toISOString(), session: input.session_id ?? null, kind: "unsent", head: head.slice(0, 80) }); } catch {}
  process.stderr.write(`You wrote "${head.slice(0, 80)}" as text, but nobody reads this terminal: it was not sent. Send it now with the SendMessage tool to the session that called you.\n`);
  return 2;
}

process.exitCode = main();

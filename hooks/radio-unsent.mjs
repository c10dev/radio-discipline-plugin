#!/usr/bin/env node
// Stop hook: if this turn wrote a radio head as text but sent no SendMessage, block the stop once
// and say so. Off without .radio/config.json or with "unsent": false.
// The ledger gets the parsed head (kind, word, id, attribute), never the line itself.
import { readFileSync } from "node:fs";
import { appendLedger, openRadio } from "../lib/ledger.mjs";
import { readTranscript, unsentEntry, unsentHead } from "../lib/unsent.mjs";

function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { return 0; }
  if (input.stop_hook_active) return 0; // already continued once because of a stop hook
  if (!input.transcript_path) return 0;
  let radio;
  try { radio = openRadio(input.cwd || process.cwd()); } catch { return 0; }
  if (!radio || radio.cfg.unsent === false) return 0;
  const head = unsentHead(readTranscript(input.transcript_path));
  if (!head) return 0;
  try { appendLedger(radio.dir, unsentEntry(head, input.session_id ?? null)); } catch {}
  const shown = head.length > 80 ? head.slice(0, 80) + "…" : head;
  process.stderr.write(`You wrote "${shown}" as text, but nobody reads this terminal: it was not sent. Send it now with the SendMessage tool to the session that called you.\n`);
  return 2;
}

process.exitCode = main();

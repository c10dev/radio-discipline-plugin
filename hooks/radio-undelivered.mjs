#!/usr/bin/env node
// PostToolUse hook for SendMessage: when SendMessage did not deliver the message, record that in the
// ledger and tell the model. Off without .radio/config.json.
// radio-check tagged the message's ledger line with the tool call's id. This hook appends an
// "undelivered" line with that id, the head fields and a reason class, never the text or the result.
// It never blocks: the tool has already run.
import { readFileSync } from "node:fs";
import { appendLedger, openRadio, readLedger, withLock } from "../lib/ledger.mjs";
import { failureOf, sentLine, undeliveredEntry, undeliveredNote } from "../lib/undelivered.mjs";

function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { return 0; }
  if (input.tool_name && input.tool_name !== "SendMessage") return 0;
  const reason = failureOf(input.tool_response);
  if (!reason || !input.tool_use_id) return 0;
  let radio;
  try { radio = openRadio(input.cwd || process.cwd()); } catch { return 0; }
  if (!radio) return 0;
  let line;
  try {
    line = withLock(radio.dir, () => {
      const entries = readLedger(radio.dir);
      const sent = sentLine(entries, input.tool_use_id);
      const known = entries.some((e) => e.kind === "undelivered" && e.tool === input.tool_use_id);
      if (sent && !known) appendLedger(radio.dir, undeliveredEntry(sent, reason, input.session_id ?? null));
      return sent;
    });
  } catch {
    return 0;
  }
  if (!line) return 0;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: undeliveredNote(line, reason) } }));
  return 0;
}

process.exitCode = main();

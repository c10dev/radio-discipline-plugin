// Unsent reply: the session wrote a radio head (DONE R-2 …) as plain text and is about to stop
// without calling SendMessage. Nobody else reads its terminal, so the reply never left.
// unsentHead is pure: it takes parsed transcript entries and returns the unsent head line or null.
import { readFileSync } from "node:fs";
import { parseHead, unmark } from "./phraseology.mjs";

// Transcript JSONL -> entries. A missing or unreadable file gives [].
export function readTranscript(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

// The ledger line for an unsent head: the parsed head fields only. The ledger never stores text.
export function unsentEntry(line, session, now = new Date()) {
  const h = parseHead(line);
  const fields = !h ? {} : h.kind === "call" ? { id: h.id, attr: h.attr } : { word: h.word, id: h.id };
  return { v: 1, at: now.toISOString(), session, kind: "unsent", head: h?.kind ?? null, ...fields };
}

// A turn starts at the last user entry that is not a tool result (a prompt or a delivered message).
const isTurnStart = (e) =>
  e?.type === "user" && (typeof e.message?.content === "string" || (e.message?.content ?? []).some((c) => c.type === "text"));


export function unsentHead(entries) {
  let i = entries.length - 1;
  while (i >= 0 && !isTurnStart(entries[i])) i--;
  let head = null;
  for (const e of entries.slice(i + 1)) {
    if (e?.type !== "assistant") continue;
    for (const c of e.message?.content ?? []) {
      if (c.type === "tool_use" && c.name === "SendMessage") return null;
      if (c.type === "tool_use" && c.name === "Bash" && /radio\.mjs\s+send\b/.test(String(c.input?.command ?? ""))) return null; // sent to a script dispatcher
      if (c.type !== "text" || head) continue;
      const line = String(c.text).split(/\r?\n/).map(unmark).find((l) => l !== "");
      if (line && parseHead(line)) head = line;
    }
  }
  return head;
}

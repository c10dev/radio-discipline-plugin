// Unsent reply: the session wrote a radio head (DONE R-2 …) as plain text and is about to stop
// without calling SendMessage. Nobody else reads its terminal, so the reply never left.
// Pure: takes parsed transcript entries, returns the unsent head line or null.
import { parseHead } from "./phraseology.mjs";

// A turn starts at the last user entry that is not a tool result (a prompt or a delivered message).
const isTurnStart = (e) =>
  e?.type === "user" && (typeof e.message?.content === "string" || (e.message?.content ?? []).some((c) => c.type === "text"));

const strip = (line) => line.replace(/[*_`#>]/g, "").trim();

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
      const line = String(c.text).split(/\r?\n/).map(strip).find((l) => l !== "");
      if (line && parseHead(line)) head = line;
    }
  }
  return head;
}

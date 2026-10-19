// Undelivered messages: SendMessage ran but did not deliver the message (no agent by that name is
// reachable, or the tool failed). radio-check tags each message's ledger line with the id of its tool
// call (`tool`). After the tool runs, radio-undelivered reads the result and, on a failure, appends an
// "undelivered" line with the same tool id. The ledger then leaves that message out (see delivered()
// in ledger.mjs): the clock does not wait for it, no overdue note names it, and a later resend that is
// delivered counts as the first send. Pure functions only.

// Ledger kinds that stand for a message SendMessage tried to deliver.
const MESSAGE_KINDS = Object.freeze(["call", "reply", "unheaded"]);

// The reason class of a failed SendMessage result, or null when the message was delivered.
// "unreachable": no agent by that name; "rejected": another refusal; "error": the tool failed.
// Only the class is kept: the result text names the receiver and is never stored.
export function failureOf(response) {
  let r = response;
  if (typeof r === "string") {
    const s = r.trim();
    try {
      r = JSON.parse(s);
    } catch {
      return /^error\b/i.test(s) ? "error" : null;
    }
  }
  // the result as content blocks: [{ type: "text", text: "{\"success\":false,…}" }]
  if (Array.isArray(r)) {
    const text = r.find((c) => c?.type === "text")?.text;
    return typeof text === "string" ? failureOf(text) : null;
  }
  if (!r || typeof r !== "object") return null;
  if (r.success === true) return null;
  if (r.is_error === true || r.error) return "error";
  if (r.success === false) return /reachable|no agent named/i.test(String(r.message ?? "")) ? "unreachable" : "rejected";
  return null;
}

// The ledger line of the message that tool call `tool` sent, or null.
export function sentLine(entries, tool) {
  if (!tool) return null;
  return entries.findLast((e) => e.tool === tool && MESSAGE_KINDS.includes(e.kind)) ?? null;
}

// The "undelivered" ledger line for a message line: its head fields, the reason class and the tool id.
export function undeliveredEntry(line, reason, session, now = new Date()) {
  const head = line.kind === "call" ? { head: "call", id: line.id } : line.kind === "reply" ? { head: "reply", word: line.word, id: line.id } : { head: null };
  return { v: 1, at: now.toISOString(), session, kind: "undelivered", ...head, reason, tool: line.tool };
}

const WHY = Object.freeze({ unreachable: "no agent by that name is reachable", rejected: "SendMessage refused it", error: "SendMessage failed" });

// What the model is told after the failed send.
export function undeliveredNote(line, reason) {
  const why = WHY[reason] ?? reason;
  if (line.kind === "call") {
    return `radio: [CALL ${line.id}] was not delivered (${why}). It does not count as sent: the clock will not wait for it and no overdue note will name it. Check the receiver's name and send it again with the same id: [CALL ${line.id}] ${line.attr} …, or tell the user.`;
  }
  if (line.kind === "reply") {
    return `radio: ${line.word} ${line.id} was not delivered (${why}). The caller has not received it and still waits for it. Check the receiver's name and send it again.`;
  }
  return `radio: this message was not delivered (${why}). Check the receiver's name and send it again.`;
}

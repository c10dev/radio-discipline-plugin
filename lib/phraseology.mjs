// Phraseology: parse and check the first line of a message between agents.
// Pure functions only. No file or network access here.
//
// Call head (the sender asks for something):
//   [CALL R-12] W/U Run the tests in packages/api.
//   [CALL] W/U Run the tests in packages/api.      <- the hook assigns the id
//
// Reply head (the receiver answers a call):
//   WILCO R-12
//   UNABLE R-12 — no network access in this sandbox
//   STANDBY R-12 — tests take about 10 minutes
//   DONE R-12 — 214 passed, 0 failed
//   ROGER R-12
//   AFFIRM R-12 / NEGATIVE R-12

// Response attribute of a call, and the reply words that may answer it.
// The model is CPDLC (ICAO Doc 10037): each message says which reply closes it.
export const ATTRS = Object.freeze({
  "W/U": Object.freeze(["WILCO", "UNABLE", "STANDBY", "DONE"]), // an instruction
  "A/N": Object.freeze(["AFFIRM", "NEGATIVE", "STANDBY", "UNABLE"]), // a yes/no question
  "R": Object.freeze(["ROGER"]), // information only
});

export const REPLY_WORDS = Object.freeze(["WILCO", "UNABLE", "STANDBY", "DONE", "ROGER", "AFFIRM", "NEGATIVE"]);

// Words that close a call. STANDBY and WILCO keep it open (see ledger.mjs).
export const CLOSING_WORDS = Object.freeze(["UNABLE", "DONE", "ROGER", "AFFIRM", "NEGATIVE"]);

const CALL_HEAD = /^\[CALL(?: (R-\d+))?\] (W\/U|A\/N|R)(?:\s+(.*))?$/;
// filed references (WO-3@a1b2c3) may follow the call id: "WILCO R-7 WO-3@a1b2c3 — starting"
const REPLY_HEAD = /^(WILCO|UNABLE|STANDBY|DONE|ROGER|AFFIRM|NEGATIVE) (R-\d+)((?:\s+(?:WO|RPT)-\d+@[0-9a-f]{6})*)(?:\s*(?:—|–|-|:)\s*(.*))?$/;

const nonEmptyLines = (text) => text.split(/\r?\n/).filter((l) => l.trim() !== "");

// First non-empty line of a message, trimmed. Leading blank lines do not count as a missing head.
export const firstLine = (message) => String(message).split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? "";

// Parse a first line. Returns one of:
//   { kind: "call", id: "R-12" | null, attr: "W/U", text }
//   { kind: "reply", word: "UNABLE", id: "R-12", note: "..." | null }
//   null  (no head)
export function parseHead(line) {
  const s = String(line ?? "").trim();
  const call = CALL_HEAD.exec(s);
  if (call) return { kind: "call", id: call[1] ?? null, attr: call[2], text: (call[3] ?? "").trim() };
  const reply = REPLY_HEAD.exec(s);
  if (reply) return { kind: "reply", word: reply[1], id: reply[2], note: reply[4]?.trim() || null };
  return null;
}

// Check one message against the rules.
// `calls` maps a known call id to its attribute, e.g. new Map([["R-12", "W/U"]]).
// Pass `calls = null` when the ledger cannot be read: id checks are then skipped.
// Returns { ok: true, head } or { ok: false, reason, head }.
export function checkMessage(message, calls) {
  if (typeof message !== "string") return { ok: true, head: null, structured: true };
  const head = parseHead(firstLine(message));
  if (!head) return { ok: false, head, reason: "no-head" };

  if (head.kind === "call") {
    if (!head.text && nonEmptyLines(message).length < 2) return { ok: false, head, reason: "empty-call" };
    // A call with an id that already exists is a resend. It must keep the same attribute.
    if (head.id && calls && calls.has(head.id) && calls.get(head.id) !== head.attr) {
      return { ok: false, head, reason: "resend-attr-changed" };
    }
    if (head.id && calls && !calls.has(head.id)) return { ok: false, head, reason: "unknown-id" };
    return { ok: true, head };
  }

  if (calls) {
    if (!calls.has(head.id)) return { ok: false, head, reason: "unknown-id" };
    if (!ATTRS[calls.get(head.id)].includes(head.word)) return { ok: false, head, reason: "word-not-allowed" };
  }
  if (head.word === "UNABLE") {
    if (!head.note) return { ok: false, head, reason: "unable-without-reason" };
    if (nonEmptyLines(message).length > 1) return { ok: false, head, reason: "unable-multiline" };
  }
  return { ok: true, head };
}

// Filed documents (config "filed": true). Two extra rules on top of checkMessage:
// - every reference in a message must exist in the table at that exact version;
// - a reply to a call that carried a reference must quote it on its first line, which shows the
//   receiver read that version (the hearback of a datalink clearance).
// docs: all filed versions [{ id, sha }]; callRefs: Map call id -> "WO-3@a1b2c3".
export function checkRefs(message, head, docs, callRefs, parseRefs) {
  if (typeof message !== "string" || !head) return { ok: true };
  for (const r of parseRefs(message)) {
    if (!docs.some((d) => d.id === r.id && d.sha === r.sha)) return { ok: false, reason: "unknown-ref", ref: r.ref };
  }
  if (head.kind === "reply" && ["WILCO", "STANDBY", "UNABLE", "DONE"].includes(head.word)) {
    const want = callRefs.get(head.id);
    if (want && !firstLine(message).includes(want)) return { ok: false, reason: "ref-not-quoted", ref: want };
  }
  return { ok: true };
}

// What the hook tells the model when it blocks a message. One short paragraph per reason.
export function explain(reason, head, calls) {
  const allowed = head?.id && calls?.has(head.id) ? ATTRS[calls.get(head.id)].join(", ") : null;
  switch (reason) {
    case "no-head":
      return [
        "The first line must be a call head or a reply head.",
        "To ask for something: [CALL] W/U <instruction>  (or A/N for a yes/no question, R for information).",
        "To answer a call: WILCO R-n, UNABLE R-n — <reason>, STANDBY R-n, DONE R-n — <result>, ROGER R-n, AFFIRM R-n or NEGATIVE R-n.",
      ].join(" ");
    case "empty-call":
      return "A call needs text after the attribute. Say what you ask for.";
    case "unknown-id":
      return `${head.id} is not a call on this frequency. Answer with the id from the call you received. To start a new request, send [CALL] without an id.`;
    case "resend-attr-changed":
      return `${head.id} was sent with another attribute. A resend keeps the same attribute. For a new request, send [CALL] without an id.`;
    case "word-not-allowed":
      return `${head.word} does not answer ${head.id}. Allowed: ${allowed}.`;
    case "unable-without-reason":
      return `Give the reason on the same line: UNABLE ${head.id} — <reason>.`;
    case "unable-multiline":
      return `UNABLE is one line: UNABLE ${head.id} — <short reason>.`;
    case "unknown-ref":
      return `${head?.ref ?? "That reference"} is not in the document table at that version. Copy the reference exactly as \`radio file\` or \`radio read\` printed it.`;
    case "ref-not-quoted":
      return `${head.id} came with ${head.ref}. Read it (node <plugin>/bin/radio.mjs read ${head.ref}) and quote it on the first line: ${head.word} ${head.id} ${head.ref} …`;
    default:
      return `Message rejected (${reason}).`;
  }
}

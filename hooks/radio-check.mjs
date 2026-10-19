#!/usr/bin/env node
// PreToolUse hook for SendMessage.
// Off unless .radio/config.json exists in the working folder or a parent folder.
// enforce mode: a message without a valid head is blocked (exit 2) and the reason goes back to the model.
// log mode: nothing is blocked. Every message is recorded, so a plain-English team can be measured too.
// In both modes a call head without an id gets the next id (updatedInput).
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkMessage, checkRefs, explain, firstLine } from "../lib/phraseology.mjs";
import { findDoc, parseRefs, readDocs } from "../lib/docs.mjs";
import { appendLedger, callStates, callsOf, findRadioDir, nextId, overdueLines, readConfig, readLedger, withLock } from "../lib/ledger.mjs";

const lineCount = (text) => text.split(/\r?\n/).filter((l) => l.trim() !== "").length;

// Decide what to do with one SendMessage call. Pure apart from the ledger it is given.
// entries = null means the ledger could not be read: ids are then not checked.
// Returns { block: reason text } or { entry, message, context }.
export function decide(toolInput, entries, cfg, now = new Date(), session = null, docs = []) {
  const message = toolInput?.message;
  if (typeof message !== "string") return { entry: null, message: null, context: null };
  const calls = entries ? callsOf(entries) : null;
  entries ??= [];
  let result = checkMessage(message, calls);
  if (result.ok && cfg.filed && result.head) {
    const callRefs = new Map(entries.filter((e) => e.kind === "call" && e.ref && !e.resend).map((e) => [e.id, e.ref]));
    const r = checkRefs(message, result.head, docs, callRefs, parseRefs);
    if (!r.ok) result = { ok: false, reason: r.reason, head: { ...result.head, ref: r.ref } };
  }
  const base = { v: 1, at: now.toISOString(), session, to: toolInput.to ?? null, lines: lineCount(message), chars: message.length };

  if (!result.ok) {
    const entry = { ...base, kind: cfg.mode === "enforce" ? "blocked" : "unheaded", reason: result.reason, head: result.head?.kind ?? null };
    if (cfg.mode === "enforce") return { block: explain(result.reason, result.head, calls), entry };
    return { entry, message: null, context: null };
  }

  const head = result.head;
  let sent = null;
  let entry;
  if (head.kind === "call") {
    // without a readable ledger, a time-based id still cannot collide with R-1, R-2 …
    const id = head.id ?? (calls ? nextId(entries) : `R-${now.getTime()}`);
    if (!head.id) sent = message.replace(/^\s*\[CALL\]/, `[CALL ${id}]`);
    entry = { ...base, kind: "call", id, attr: head.attr, resend: Boolean(head.id) };
    const ref = parseRefs(message)[0]?.ref;
    if (ref) entry.ref = ref;
  } else {
    entry = { ...base, kind: "reply", id: head.id, word: head.word };
    const refs = parseRefs(message).map((r) => r.ref);
    if (refs.length) entry.refs = refs;
  }

  // push: attach each referenced document to the message, so the receiver needs no `radio read`.
  // The sender still writes only the reference; the ledger keeps its own length in `chars`.
  if (cfg.filed && cfg.push) {
    // a reply quotes its call's reference as a hearback; the caller already has that document
    const quoted = head.kind === "reply" ? entries.find((e) => e.kind === "call" && e.id === head.id && e.ref && !e.resend)?.ref : null;
    const attached = parseRefs(message).filter((r) => r.ref !== quoted).map((r) => findDoc(docs, r.ref)).filter(Boolean)
      .map((d) => `--- attached ${d.id}@${d.sha} · ${d.title} ---\n${d.body}\n--- end ${d.id}@${d.sha} ---`);
    if (attached.length) {
      sent = `${sent ?? message}\n\n${attached.join("\n\n")}`;
      entry.attachedChars = sent.length - message.length;
    }
  }

  const states = callStates([...entries, entry], now.getTime(), cfg);
  const late = overdueLines(states, now.getTime());
  const notes = [];
  if (sent) notes.push(`radio: sent as ${firstLine(sent)}`);
  if (late.length) notes.push("radio: overdue calls:", ...late);
  return { entry, message: sent, context: notes.length ? notes.join("\n") : null };
}

export function hookOutput(toolInput, decision) {
  if (!decision.message && !decision.context) return null;
  const out = { hookEventName: "PreToolUse" };
  if (decision.message) {
    out.permissionDecision = "allow";
    out.permissionDecisionReason = "radio: call id assigned or documents attached";
    out.updatedInput = { ...toolInput, message: decision.message };
    // the harness may carry a copy of the text in `content` (seen in atc's send guard): keep it in step
    if (typeof toolInput.content === "string") out.updatedInput.content = decision.message;
  }
  if (decision.context) out.additionalContext = decision.context;
  return { hookSpecificOutput: out };
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return 0;
  }
  if (input.tool_name && input.tool_name !== "SendMessage") return 0;
  const radioDir = findRadioDir(input.cwd || process.cwd());
  if (!radioDir) return 0;

  let cfg;
  try {
    cfg = readConfig(radioDir);
  } catch (e) {
    process.stderr.write(`radio: .radio/config.json is not valid JSON (${e.message}). Fix it or remove it.\n`);
    return 2;
  }

  // debug: true in config.json records the shape of each SendMessage input (field names, type, first line).
  // For pilots only: the first line is a head, but it can carry a few words of the call text.
  if (cfg.debug) {
    try {
      const ti = input.tool_input ?? {};
      const m = ti.message;
      appendFileSync(join(radioDir, "debug.jsonl"), JSON.stringify({ at: new Date().toISOString(), session: input.session_id ?? null, keys: Object.keys(ti), to: ti.to ?? null, messageType: typeof m, firstLine: typeof m === "string" ? firstLine(m).slice(0, 80) : null }) + "\n");
    } catch {}
  }

  let decision;
  try {
    decision = withLock(radioDir, () => {
      const d = decide(input.tool_input, readLedger(radioDir), cfg, new Date(), input.session_id ?? null, cfg.filed ? readDocs(radioDir) : []);
      if (d.entry) appendLedger(radioDir, d.entry);
      return d;
    });
  } catch (e) {
    // The format check is local and safe to enforce. The ledger is best effort:
    // if it cannot be read or written, check the format alone and let a good message through.
    decision = decide(input.tool_input, null, cfg, new Date(), input.session_id ?? null);
    if (!decision.block) decision = { ...decision, context: [decision.context, `radio: ledger unavailable (${e.message})`].filter(Boolean).join("\n") };
  }

  if (decision.block) {
    process.stderr.write(`radio: message not sent. ${decision.block}\n`);
    return 2;
  }
  const out = hookOutput(input.tool_input, decision);
  if (out) process.stdout.write(JSON.stringify(out));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();

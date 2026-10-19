#!/usr/bin/env node
// radio init [--mode enforce|log]   turn the radio on for this folder (.radio/config.json)
// radio status [--json]             open calls, and which are overdue
// radio stats [--json]              counts from the ledger: calls, replies, blocked, closing words
// radio file <WO|RPT> <title> [path] file a long document (body from path or stdin); prints its reference
// radio read <WO-3|WO-3@a1b2c3>      print a filed document
// radio docs                        list filed documents
// radio send <message>              send a radio message without SendMessage (to a script dispatcher): same
//                                   checks as the hook, recorded in the ledger, text in .radio/inbox.jsonl;
//                                   message from the argument or stdin
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileDoc, findDoc, readDocs } from "../lib/docs.mjs";
import { join, resolve } from "node:path";
import { appendLedger, callStates, DEFAULTS, findRadioDir, overdueLines, readConfig, readLedger, withLock } from "../lib/ledger.mjs";
import { decide } from "../hooks/radio-check.mjs";

const [cmd, ...args] = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? "");
};

function init() {
  const mode = flag("--mode") ?? "enforce";
  if (mode !== "enforce" && mode !== "log") return fail("--mode is enforce or log");
  const dir = join(resolve("."), ".radio");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "config.json");
  if (existsSync(file)) return fail(`${file} exists. Edit it instead.`);
  writeFileSync(file, JSON.stringify({ ...DEFAULTS, mode }, null, 2) + "\n");
  console.log(`radio on (${mode}): ${file}`);
  return 0;
}

function load() {
  const dir = findRadioDir(process.cwd());
  if (!dir) return null;
  return { dir, cfg: readConfig(dir), entries: readLedger(dir) };
}

function status() {
  const r = load();
  if (!r) return fail("radio is off here (no .radio/config.json). Run: radio init");
  const now = Date.now();
  const open = callStates(r.entries, now, r.cfg).filter((s) => s.status !== "closed");
  if (args.includes("--json")) return print(open);
  if (!open.length) return print("no open calls");
  for (const s of open) console.log(`${s.id} to ${s.to ?? "?"} ${s.attr} ${s.status}${s.overdue ? " OVERDUE" : ""} due ${s.due}`);
  for (const l of overdueLines(open, now)) console.log(l);
  return 0;
}

function stats() {
  const r = load();
  if (!r) return fail("radio is off here (no .radio/config.json)");
  const count = (pred) => r.entries.filter(pred).length;
  const words = {};
  for (const e of r.entries) if (e.kind === "reply") words[e.word] = (words[e.word] ?? 0) + 1;
  const reasons = {};
  for (const e of r.entries) if (e.reason) reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
  const states = callStates(r.entries, Date.now(), r.cfg);
  const out = {
    mode: r.cfg.mode,
    calls: count((e) => e.kind === "call" && !e.resend),
    resends: count((e) => e.kind === "call" && e.resend),
    replies: count((e) => e.kind === "reply"),
    blocked: count((e) => e.kind === "blocked"),
    unheaded: count((e) => e.kind === "unheaded"),
    replyWords: words,
    rejectReasons: reasons,
    closed: states.filter((s) => s.status === "closed").length,
    overdueNow: states.filter((s) => s.overdue).length,
  };
  return args.includes("--json") ? print(out) : print(JSON.stringify(out, null, 2));
}

function file() {
  const r = load();
  if (!r) return fail("radio is off here (no .radio/config.json)");
  const [kind, title, path] = args;
  if (!kind || !title) return fail("usage: radio file <WO|RPT> <title> [path]   (body from path or stdin)");
  let body;
  try {
    body = path ? readFileSync(path, "utf8") : readFileSync(0, "utf8");
  } catch (e) {
    return fail(`cannot read the body: ${e.message}`);
  }
  try {
    const d = fileDoc(r.dir, { kind, title, body, session: process.env.CLAUDE_SESSION_ID ?? null });
    console.log(`filed ${d.ref} (${d.chars} chars): ${d.title}`);
    return 0;
  } catch (e) {
    return fail(e.message);
  }
}

function read() {
  const r = load();
  if (!r) return fail("radio is off here (no .radio/config.json)");
  const d = findDoc(readDocs(r.dir), args[0]);
  if (!d) return fail(`no document ${args[0]}`);
  console.log(`ref ${d.id}@${d.sha} · ${d.title}\n\n${d.body}`);
  return 0;
}

function docs() {
  const r = load();
  if (!r) return fail("radio is off here (no .radio/config.json)");
  for (const d of readDocs(r.dir)) console.log(`${d.id}@${d.sha}\t${d.chars} chars\t${d.title}`);
  return 0;
}

function send() {
  const r = load();
  if (!r) return fail("radio is off here (no .radio/config.json)");
  let message = args.join(" ");
  if (!message.trim()) { try { message = readFileSync(0, "utf8"); } catch { message = ""; } }
  if (!message.trim()) return fail("usage: radio send <message>");
  const session = process.env.XP_ROLE ?? process.env.CLAUDE_SESSION_ID ?? null;
  const d = withLock(r.dir, () => {
    const out = decide({ to: "dispatcher", message }, readLedger(r.dir), r.cfg, new Date(), session, r.cfg.filed ? readDocs(r.dir) : []);
    if (out.entry) appendLedger(r.dir, out.entry);
    return out;
  });
  if (d.block) return fail(`message not sent. ${d.block}`);
  // the dispatcher reads the text from the inbox (the ledger keeps no text)
  appendFileSync(join(r.dir, "inbox.jsonl"), JSON.stringify({ at: new Date().toISOString(), session, kind: d.entry?.kind ?? null, id: d.entry?.id ?? null, text: d.message ?? message }) + "\n");
  console.log(`sent: ${(d.message ?? message).split("\n")[0]}`);
  return 0;
}

function print(x) {
  console.log(typeof x === "string" ? x : JSON.stringify(x, null, 2));
  return 0;
}
function fail(msg) {
  console.error(`radio: ${msg}`);
  return 1;
}

const commands = { init, status, stats, file, read, docs, send };
process.exitCode = commands[cmd] ? commands[cmd]() : fail("usage: radio init [--mode enforce|log] | status [--json] | stats [--json] | file <WO|RPT> <title> [path] | read <ref> | docs | send <message>");

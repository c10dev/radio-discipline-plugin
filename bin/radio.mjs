#!/usr/bin/env node
// The radio CLI. Inside Claude Code the plugin's bin/ folder is on the Bash tool's PATH, so it runs
// as `radio.mjs <command>`. Commands and environment: see HELP below, or `radio.mjs help`.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileDoc, findDoc, readDocs } from "../lib/docs.mjs";
import { join, resolve } from "node:path";
import { appendLedger, callStates, DEFAULTS, openRadio, overdueLines, radioDirAt, readConfig, readLedger, withLock } from "../lib/ledger.mjs";
import { decide } from "../hooks/radio-check.mjs";

const HELP = `radio.mjs: radio discipline for Claude Code agents that message each other.

Commands:
  init [--mode enforce|log]      turn the radio on for this folder (writes .radio/config.json)
  init --join <folder>           put this folder on the frequency of <folder>: sessions in both
                                 folders then share one ledger (writes {"frequency": ...})
  status [--json]                open calls, and which are overdue
  stats [--json]                 counts from the ledger: calls, replies, blocked, closing words
  file <WO|RPT> <title> [path]   file a long document (body from path or stdin); prints its reference
  read <WO-3|WO-3@a1b2c3>        print a filed document
  docs                           list filed documents
  send <message>                 send a radio message without SendMessage (to a script dispatcher):
                                 same checks as the hook, recorded in the ledger, text in
                                 .radio/inbox.jsonl; message from the argument or stdin
  help                           this text

Environment:
  RADIO_SESSION   session id that send and file record as the sender
                  (default: CLAUDE_CODE_SESSION_ID, which Claude Code sets for its Bash tool)
  RADIO_DIR       use this radio (a folder with .radio/config.json) instead of the one found
                  from the current folder
`;

// The sender's session: the same id the hooks get as session_id, so the clock and the overdue
// notes know which calls are this session's.
const sessionId = () => process.env.RADIO_SESSION || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;

const [cmd, ...args] = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? "");
};

function init() {
  const join_ = flag("--join");
  const mode = flag("--mode") ?? "enforce";
  if (mode !== "enforce" && mode !== "log") return fail("--mode is enforce or log");
  const dir = join(resolve("."), ".radio");
  const file = join(dir, "config.json");
  if (existsSync(file)) return fail(`${file} exists. Edit it instead.`);
  let config = { ...DEFAULTS, mode };
  if (join_ !== null) {
    if (!join_) return fail("usage: radio.mjs init --join <folder>");
    if (args.includes("--mode")) return fail("a joined folder uses the mode of the frequency it joins; set it there");
    const target = radioDirAt(resolve(join_));
    if (!target) return fail(`${join_} has no .radio/config.json. Run radio.mjs init there first.`);
    if (target === dir) return fail("a folder cannot join itself");
    let cfg;
    try {
      cfg = readConfig(target);
    } catch (e) {
      return fail(e.message);
    }
    if (cfg.frequency) return fail(`${target} is itself joined to ${cfg.frequency}. Join that folder instead.`);
    config = { frequency: target };
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  console.log(config.frequency ? `radio on: this folder joins the frequency at ${config.frequency}` : `radio on (${mode}): ${file}`);
  return 0;
}

// The radio for the current folder, or null when it is off. Throws a message for the user on a bad config.
function load() {
  const r = openRadio(process.cwd());
  if (!r) return null;
  return { ...r, entries: readLedger(r.dir) };
}

const OFF = "radio is off here (no .radio/config.json). Run: radio.mjs init";

function status() {
  const r = load();
  if (!r) return fail(OFF);
  const now = Date.now();
  const open = callStates(r.entries, now, r.cfg).filter((s) => s.status !== "closed");
  if (args.includes("--json")) return print(open);
  if (r.dir !== r.home) console.log(`frequency: ${r.dir}`);
  if (!open.length) return print("no open calls");
  for (const s of open) console.log(`${s.id} to ${s.to ?? "?"} ${s.attr} ${s.status}${s.overdue ? " OVERDUE" : ""}${s.due ? ` due ${s.due}` : ""}`);
  for (const l of overdueLines(open, now)) console.log(l);
  return 0;
}

function stats() {
  const r = load();
  if (!r) return fail(OFF);
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
    escalated: states.filter((s) => s.status === "escalated").length,
    overdueNow: states.filter((s) => s.overdue).length,
  };
  return args.includes("--json") ? print(out) : print(JSON.stringify(out, null, 2));
}

function file() {
  const r = load();
  if (!r) return fail(OFF);
  const [kind, title, path] = args;
  if (!kind || !title) return fail("usage: radio.mjs file <WO|RPT> <title> [path]   (body from path or stdin)");
  let body;
  try {
    body = path ? readFileSync(path, "utf8") : readFileSync(0, "utf8");
  } catch (e) {
    return fail(`cannot read the body: ${e.message}`);
  }
  try {
    const d = fileDoc(r.dir, { kind, title, body, session: sessionId() });
    console.log(`filed ${d.ref} (${d.chars} chars): ${d.title}`);
    return 0;
  } catch (e) {
    return fail(e.message);
  }
}

function read() {
  const r = load();
  if (!r) return fail(OFF);
  const d = findDoc(readDocs(r.dir), args[0]);
  if (!d) return fail(`no document ${args[0]}`);
  console.log(`ref ${d.id}@${d.sha} · ${d.title}\n\n${d.body}`);
  return 0;
}

function docs() {
  const r = load();
  if (!r) return fail(OFF);
  for (const d of readDocs(r.dir)) console.log(`${d.id}@${d.sha}\t${d.chars} chars\t${d.title}`);
  return 0;
}

function send() {
  const r = load();
  if (!r) return fail(OFF);
  let message = args.join(" ");
  if (!message.trim()) { try { message = readFileSync(0, "utf8"); } catch { message = ""; } }
  if (!message.trim()) return fail("usage: radio.mjs send <message>");
  const session = sessionId();
  const d = withLock(r.dir, () => {
    const out = decide({ to: "dispatcher", message }, readLedger(r.dir), r.cfg, new Date(), session, r.cfg.filed ? readDocs(r.dir) : []);
    for (const e of [out.entry, ...(out.extra ?? [])]) if (e) appendLedger(r.dir, e);
    return out;
  });
  if (d.block) return fail(`message not sent. ${d.block}`);
  // the dispatcher reads the text from the inbox (the ledger keeps no text)
  appendFileSync(join(r.dir, "inbox.jsonl"), JSON.stringify({ at: new Date().toISOString(), session, kind: d.entry?.kind ?? null, id: d.entry?.id ?? null, text: d.message ?? message }) + "\n");
  console.log(`sent: ${(d.message ?? message).split("\n")[0]}`);
  // overdue notes, as the hook gives them to the model (an escalation is noted only once)
  for (const l of (d.context ?? "").split("\n")) if (l && !l.startsWith("radio: sent as")) console.log(l);
  return 0;
}

function help() {
  process.stdout.write(HELP);
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

const commands = { init, status, stats, file, read, docs, send, help, "--help": help, "-h": help };
function run() {
  if (cmd === undefined || cmd === "") return help();
  if (!Object.hasOwn(commands, cmd)) {
    console.error(`radio: unknown command "${cmd}"\n\n${HELP}`);
    return 1;
  }
  try {
    return commands[cmd]();
  } catch (e) {
    return fail(e.message);
  }
}
process.exitCode = run();

// The ledger: an append-only JSONL file of calls and replies in .radio/ledger.jsonl.
// It stores heads, ids, sizes and times. It never stores message text.
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CLOSING_WORDS } from "./phraseology.mjs";

export const DEFAULTS = Object.freeze({
  mode: "enforce", // "enforce" blocks bad messages; "log" only records them
  ackTimeoutSec: 180, // a call with no reply is overdue after this
  workTimeoutSec: 900, // accepted work with no DONE or STANDBY is overdue after this
});

// Find .radio/config.json in cwd or a parent folder. No config means the plugin is off here.
export function findRadioDir(cwd) {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, ".radio", "config.json"))) return join(dir, ".radio");
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// The .radio folder at a path: the path itself when it is a .radio folder, or its .radio subfolder.
export function radioDirAt(path) {
  if (basename(path) === ".radio" && existsSync(join(path, "config.json"))) return path;
  if (existsSync(join(path, ".radio", "config.json"))) return join(path, ".radio");
  return null;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(e instanceof SyntaxError ? `${file} is not valid JSON (${e.message})` : e.message);
  }
}

export function readConfig(radioDir) {
  const cfg = { ...DEFAULTS, ...readJson(join(radioDir, "config.json")) };
  if (cfg.mode !== "enforce" && cfg.mode !== "log") cfg.mode = DEFAULTS.mode;
  return cfg;
}

// The radio a session in `cwd` is on. null means the plugin is off there. Otherwise { home, dir, cfg }:
// - home: the .radio folder named by RADIO_DIR, or else found in cwd or a parent folder;
// - dir: the frequency, the .radio folder whose config, ledger and lock are used. It is home, unless
//   home's config.json is {"frequency": "<folder>"}, which puts sessions in different folders on one
//   ledger (radio.mjs init --join). A relative path counts from the folder that holds home. One hop only.
// Throws, with a message for the user, when a config cannot be read or a path has no radio.
export function openRadio(cwd, env = process.env) {
  let home;
  if (env.RADIO_DIR) {
    home = radioDirAt(resolve(cwd, env.RADIO_DIR));
    if (!home) throw new Error(`RADIO_DIR is ${env.RADIO_DIR}, which has no .radio/config.json`);
  } else {
    home = findRadioDir(cwd);
    if (!home) return null;
  }
  const local = readJson(join(home, "config.json"));
  if (!local?.frequency) return { home, dir: home, cfg: readConfig(home) };
  const dir = radioDirAt(resolve(dirname(home), String(local.frequency)));
  if (!dir) throw new Error(`"frequency" in ${join(home, "config.json")} is ${local.frequency}, which has no .radio/config.json`);
  const cfg = readConfig(dir);
  if (cfg.frequency) throw new Error(`"frequency" in ${join(home, "config.json")} points at ${dir}, which is itself joined to ${cfg.frequency}. Point it at that folder.`);
  return { home, dir, cfg };
}

export function readLedger(radioDir) {
  const file = join(radioDir, "ledger.jsonl");
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a torn last line from a crash: skip it
    }
  }
  return out;
}

export function appendLedger(radioDir, entry) {
  mkdirSync(radioDir, { recursive: true });
  appendFileSync(join(radioDir, "ledger.jsonl"), JSON.stringify(entry) + "\n");
}

// Run fn while holding .radio/lock. Two sessions can send at the same moment and must not
// get the same id. A lock older than 5 s is from a dead process and is removed.
export function withLock(radioDir, fn, { waitMs = 3000 } = {}) {
  const lock = join(radioDir, "lock");
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5000) unlinkSync(lock);
      } catch {}
      if (Date.now() > until) throw new Error("radio lock busy");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {}
  }
}

// Known calls: id -> attribute.
export function callsOf(entries) {
  const calls = new Map();
  for (const e of entries) if (e.kind === "call" && e.id && !calls.has(e.id)) calls.set(e.id, e.attr);
  return calls;
}

export function nextId(entries) {
  let max = 0;
  for (const e of entries) {
    const n = e.kind === "call" && /^R-(\d+)$/.exec(e.id ?? "")?.[1];
    if (n && Number(n) > max) max = Number(n);
  }
  return `R-${max + 1}`;
}

// Fold the ledger into one state per call. Pure.
// status: "open" (no reply yet), "standby" (STANDBY before WILCO), "working" (WILCO, not DONE),
//         "closed" (UNABLE, DONE, ROGER, AFFIRM, NEGATIVE),
//         "escalated" (its caller was told to escalate: no more overdue notes, no timer)
// overdue: past the due time and not closed or escalated.
// action for an overdue call: "resend" first, "escalate" after one resend (CPDLC: revert to voice).
// An escalated call is retired, not closed: a late reply still closes it, and a late WILCO, STANDBY
// or resend brings it back with a new timer.
export function callStates(entries, nowMs, cfg = DEFAULTS) {
  const ack = cfg.ackTimeoutSec * 1000;
  const work = cfg.workTimeoutSec * 1000;
  const states = new Map();
  for (const e of entries) {
    const at = Date.parse(e.at);
    if (e.kind === "call" && e.id) {
      const s = states.get(e.id);
      if (!s) {
        states.set(e.id, { id: e.id, attr: e.attr, to: e.to, session: e.session ?? null, sentAt: e.at, status: "open", resends: 0, closedBy: null, escalated: false, dueMs: at + ack });
      } else if (s.status !== "closed") {
        // a resend asks again and restarts the reply timer
        s.resends += 1;
        s.escalated = false;
        s.dueMs = at + ack;
      }
      continue;
    }
    if (e.kind === "clock" && e.action === "escalate") {
      // the caller was told to escalate (by the clock or by a note on its own send)
      const s = states.get(e.id);
      if (s && s.status !== "closed" && (e.session ?? null) === s.session) s.escalated = true;
      continue;
    }
    if (e.kind !== "reply") continue;
    const s = states.get(e.id);
    if (!s || s.status === "closed") continue;
    s.escalated = false;
    if (CLOSING_WORDS.includes(e.word)) {
      s.status = "closed";
      s.closedBy = e.word;
      s.dueMs = null;
    } else if (e.word === "WILCO") {
      s.status = "working";
      s.dueMs = at + work;
    } else if (e.word === "STANDBY") {
      // STANDBY does not close the call. It restarts the timer that is running.
      if (s.status === "working") s.dueMs = at + work;
      else {
        s.status = "standby";
        s.dueMs = at + ack;
      }
    }
  }
  return [...states.values()].map((s) => {
    if (s.escalated) return { ...s, status: "escalated", dueMs: null, due: null, overdue: false, action: null };
    const overdue = s.dueMs !== null && nowMs > s.dueMs;
    return { ...s, due: s.dueMs === null ? null : new Date(s.dueMs).toISOString(), overdue, action: overdue ? (s.resends > 0 ? "escalate" : "resend") : null };
  });
}

// One line per overdue call, for the hook's additionalContext and for `radio status`.
export function overdueLines(states, nowMs) {
  return states
    .filter((s) => s.overdue)
    .map((s) => {
      const min = Math.round((nowMs - Date.parse(s.sentAt)) / 60000);
      const what = s.action === "resend" ? `resend it once with the same id: [CALL ${s.id}] ${s.attr} …` : "already resent. Tell the user: ESCALATE: " + s.id;
      return `${s.id} to ${s.to ?? "?"} (${s.attr}, ${s.status}, sent ${min} min ago) is overdue — ${what}`;
    });
}

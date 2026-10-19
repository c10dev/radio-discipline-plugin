import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, hookOutput } from "../hooks/radio-check.mjs";

const HOOK = new URL("../hooks/radio-check.mjs", import.meta.url).pathname;
const enforce = { mode: "enforce", ackTimeoutSec: 180, workTimeoutSec: 900 };
const now = new Date("2026-10-05T12:00:00Z");

test("decide assigns the next id to a call and says so", () => {
  const d = decide({ to: "bob", message: "[CALL] W/U Run the tests." }, [], enforce, now);
  assert.equal(d.message, "[CALL R-1] W/U Run the tests.");
  assert.equal(d.entry.id, "R-1");
  assert.match(d.context, /sent as \[CALL R-1\]/);
  assert.equal("text" in d.entry || "message" in d.entry, false, "the ledger never stores text");
});

test("hookOutput rewrites message and its content copy", () => {
  const input = { to: "bob", message: "[CALL] R main is green", content: "[CALL] R main is green" };
  const out = hookOutput(input, decide(input, [], enforce, now)).hookSpecificOutput;
  assert.equal(out.updatedInput.message, "[CALL R-1] R main is green");
  assert.equal(out.updatedInput.content, "[CALL R-1] R main is green");
  assert.equal(out.permissionDecision, "allow");
});

test("leading blank lines do not hide the head", () => {
  assert.equal(decide({ to: "lead", message: "\n\nWILCO R-1" }, [{ kind: "call", id: "R-1", attr: "W/U", at: "2026-10-05T11:59:00Z" }], enforce, now).entry.kind, "reply");
});

test("decide blocks in enforce mode and records in log mode", () => {
  const blocked = decide({ to: "lead", message: "on it!" }, [], enforce, now);
  assert.match(blocked.block, /first line must be/);
  assert.equal(blocked.entry.kind, "blocked");
  const logged = decide({ to: "lead", message: "on it!" }, [], { ...enforce, mode: "log" }, now);
  assert.equal(logged.block, undefined);
  assert.equal(logged.entry.kind, "unheaded");
});

test("decide reports overdue calls to whoever sends next", () => {
  const entries = [{ kind: "call", id: "R-1", attr: "W/U", to: "bob", at: "2026-10-05T11:50:00Z" }];
  const d = decide({ to: "carol", message: "[CALL] R FYI main is green." }, entries, enforce, now);
  assert.match(d.context, /R-1 to bob .* overdue — resend it once/);
});

function sandbox(config) {
  const dir = mkdtempSync(join(tmpdir(), "radio-test-"));
  if (config) {
    mkdirSync(join(dir, ".radio"));
    writeFileSync(join(dir, ".radio", "config.json"), JSON.stringify(config));
  }
  mkdirSync(join(dir, "sub"));
  return dir;
}
const run = (cwd, tool_input, tool_name = "SendMessage") =>
  spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input, cwd }), encoding: "utf8" });

test("hook process: off without a config", () => {
  const dir = sandbox(null);
  try {
    const r = run(dir, { to: "bob", message: "anything goes" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook process: full exchange from a subfolder, ledger without text", () => {
  const dir = sandbox({ mode: "enforce" });
  try {
    const sub = join(dir, "sub");
    const c = run(sub, { to: "bob", message: "[CALL] W/U Run the secret-named tests." });
    assert.equal(c.status, 0);
    assert.equal(JSON.parse(c.stdout).hookSpecificOutput.updatedInput.message, "[CALL R-1] W/U Run the secret-named tests.");
    const bad = run(sub, { to: "lead", message: "ok will do" });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /message not sent/);
    assert.equal(run(sub, { to: "lead", message: "WILCO R-1" }).status, 0);
    assert.equal(run(sub, { to: "lead", message: "ROGER R-1" }).status, 2);
    assert.equal(run(sub, { to: "lead", message: "DONE R-1 — 3 passed" }).status, 0);
    assert.equal(run(sub, { to: "x" }, "Bash").status, 0);
    const ledger = readFileSync(join(dir, ".radio", "ledger.jsonl"), "utf8");
    assert.equal(ledger.trim().split("\n").length, 5);
    assert.equal(ledger.includes("secret"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook process: a broken config blocks with a clear message", () => {
  const dir = sandbox(null);
  try {
    mkdirSync(join(dir, ".radio"));
    writeFileSync(join(dir, ".radio", "config.json"), "{nope");
    const r = run(dir, { to: "bob", message: "WILCO R-1" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /config.json is not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

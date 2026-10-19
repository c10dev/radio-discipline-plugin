import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRadio } from "../lib/ledger.mjs";

const HOOK = new URL("../hooks/radio-check.mjs", import.meta.url).pathname;
const CLI = new URL("../bin/radio.mjs", import.meta.url).pathname;

const send = (cwd, session, tool_input, env = {}) =>
  spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "SendMessage", session_id: session, tool_input, cwd }),
    encoding: "utf8",
    env: { ...process.env, RADIO_DIR: "", ...env },
  });
const cli = (cwd, args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, RADIO_DIR: "", ...env } });

function folders() {
  const root = mkdtempSync(join(tmpdir(), "radio-freq-"));
  for (const f of ["projA", "projB", "projC"]) mkdirSync(join(root, f));
  return root;
}

test("a folder joined to another shares its ledger: a reply from there closes the call", () => {
  const root = folders();
  const [a, b] = [join(root, "projA"), join(root, "projB")];
  try {
    assert.equal(cli(a, ["init"]).status, 0);
    const j = cli(b, ["init", "--join", a]);
    assert.equal(j.status, 0, j.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(b, ".radio", "config.json"), "utf8")), { frequency: join(a, ".radio") });

    const c = send(a, "sess-lead", { to: "bob", message: "[CALL] W/U Run the tests" });
    assert.equal(JSON.parse(c.stdout).hookSpecificOutput.updatedInput.message, "[CALL R-1] W/U Run the tests");
    const w = send(b, "sess-bob", { to: "lead", message: "WILCO R-1" });
    assert.equal(w.status, 0, w.stderr);
    assert.equal(send(b, "sess-bob", { to: "lead", message: "DONE R-1 — 3 passed" }).status, 0);

    const ledger = readFileSync(join(a, ".radio", "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(ledger.map((e) => [e.kind, e.id, e.word ?? null]), [["call", "R-1", null], ["reply", "R-1", "WILCO"], ["reply", "R-1", "DONE"]]);
    assert.equal(cli(a, ["status"]).stdout.trim(), "no open calls");
    const sb = cli(b, ["status"]);
    assert.match(sb.stdout, new RegExp(`frequency: ${join(a, ".radio").replace(/[.]/g, "\\.")}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RADIO_DIR puts a session in a folder without a radio on a frequency", () => {
  const root = folders();
  const [a, c] = [join(root, "projA"), join(root, "projC")];
  try {
    cli(a, ["init"]);
    send(a, "sess-lead", { to: "bob", message: "[CALL] W/U Run the tests" });
    // without RADIO_DIR the radio is off in projC: the reply goes out unchecked and unrecorded
    assert.equal(send(c, "sess-bob", { to: "lead", message: "anything" }).status, 0);
    assert.equal(send(c, "sess-bob", { to: "lead", message: "DONE R-1 — ok" }, { RADIO_DIR: a }).status, 0);
    assert.equal(cli(a, ["status"]).stdout.trim(), "no open calls");
    assert.equal(cli(c, ["status"], { RADIO_DIR: join(a, ".radio") }).stdout.trim(), "no open calls");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a frequency that points nowhere blocks with a clear message", () => {
  const root = folders();
  const b = join(root, "projB");
  try {
    mkdirSync(join(b, ".radio"));
    writeFileSync(join(b, ".radio", "config.json"), JSON.stringify({ frequency: "../projA" }));
    const r = send(b, "sess-bob", { to: "lead", message: "WILCO R-1" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /"frequency" in .* is \.\.\/projA, which has no \.radio\/config\.json/);
    const e = send(join(root, "projC"), "sess-bob", { to: "lead", message: "WILCO R-1" }, { RADIO_DIR: join(root, "nowhere") });
    assert.equal(e.status, 2);
    assert.match(e.stderr, /RADIO_DIR is .*nowhere, which has no \.radio\/config\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openRadio: one hop only, relative paths count from the joined folder", () => {
  const root = folders();
  const [a, b, c] = ["projA", "projB", "projC"].map((f) => join(root, f));
  try {
    cli(a, ["init", "--mode", "log"]);
    mkdirSync(join(b, ".radio"));
    writeFileSync(join(b, ".radio", "config.json"), JSON.stringify({ frequency: "../projA" }));
    const r = openRadio(join(b, "deep"), {});
    assert.equal(r.home, join(b, ".radio"));
    assert.equal(r.dir, join(a, ".radio"));
    assert.equal(r.cfg.mode, "log");
    // joining a folder that is itself joined is refused, by the CLI and by openRadio
    assert.match(cli(c, ["init", "--join", b]).stderr, /itself joined/);
    mkdirSync(join(c, ".radio"));
    writeFileSync(join(c, ".radio", "config.json"), JSON.stringify({ frequency: b }));
    assert.throws(() => openRadio(c, {}), /itself joined/);
    assert.equal(openRadio(join(root, "elsewhere"), {}), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

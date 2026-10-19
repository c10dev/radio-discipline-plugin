import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../bin/radio.mjs", import.meta.url).pathname;
// a clean environment: no session variables from the Claude Code session that runs the tests
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["RADIO_SESSION", "RADIO_DIR", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID"].includes(k)));
const cli = (cwd, args, env = {}, input) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...baseEnv, ...env }, input });

function radioFolder() {
  const dir = mkdtempSync(join(tmpdir(), "radio-cli-"));
  assert.equal(cli(dir, ["init"]).status, 0);
  return dir;
}
const ledgerOf = (dir) => readFileSync(join(dir, ".radio", "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("help, -h, --help and no command print the help and exit 0", () => {
  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    const r = cli(tmpdir(), args);
    assert.equal(r.status, 0, args.join(" "));
    assert.match(r.stdout, /Commands:[\s\S]*init --join <folder>[\s\S]*RADIO_SESSION/);
    assert.equal(r.stderr, "");
  }
  const bad = cli(tmpdir(), ["nope"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown command "nope"/);
});

test("the off hint names a command that exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "radio-off-"));
  try {
    const r = cli(dir, ["status"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Run: radio\.mjs init$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("send and file record the Claude Code session id, so the clock and overdue notes find the call", () => {
  const dir = radioFolder();
  try {
    assert.equal(cli(dir, ["send", "[CALL] W/U Do the thing"], { CLAUDE_CODE_SESSION_ID: "sess-lead" }).status, 0);
    assert.equal(cli(dir, ["send", "[CALL] R FYI"], { CLAUDE_CODE_SESSION_ID: "sess-lead", RADIO_SESSION: "dispatcher-1" }).status, 0);
    assert.equal(cli(dir, ["send", "[CALL] R no session"]).status, 0);
    assert.deepEqual(ledgerOf(dir).map((e) => e.session), ["sess-lead", "dispatcher-1", null]);
    writeFileSync(join(dir, "wo.md"), "step 1");
    assert.equal(cli(dir, ["file", "WO", "Work", join(dir, "wo.md")], { CLAUDE_CODE_SESSION_ID: "sess-lead" }).status, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, ".radio", "docs.jsonl"), "utf8")).session, "sess-lead");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("send prints overdue notes, including the one escalation note", () => {
  const dir = radioFolder();
  try {
    const old = (min) => new Date(Date.now() - min * 60000).toISOString();
    writeFileSync(join(dir, ".radio", "ledger.jsonl"), [
      { v: 1, kind: "call", id: "R-1", attr: "W/U", to: "dave", session: "sess-lead", at: old(30) },
      { v: 1, kind: "call", id: "R-1", attr: "W/U", to: "dave", session: "sess-lead", at: old(20), resend: true },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const env = { CLAUDE_CODE_SESSION_ID: "sess-lead" };
    assert.match(cli(dir, ["send", "[CALL] R update 1"], env).stdout, /ESCALATE: R-1/);
    assert.doesNotMatch(cli(dir, ["send", "[CALL] R update 2"], env).stdout, /ESCALATE/);
    assert.match(cli(dir, ["status"]).stdout, /R-1 to dave W\/U escalated/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

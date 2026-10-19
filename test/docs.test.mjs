import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileDoc, findDoc, nextDocId, parseRefs, readDocs, sha6 } from "../lib/docs.mjs";
import { checkRefs, parseHead } from "../lib/phraseology.mjs";
import { decide } from "../hooks/radio-check.mjs";

test("refs parse and ids count per kind", () => {
  assert.deepEqual(parseRefs("[CALL] W/U FILED WO-12@a1b2c3 — x, see RPT-2@00ff11"), [
    { id: "WO-12", sha: "a1b2c3", ref: "WO-12@a1b2c3" }, { id: "RPT-2", sha: "00ff11", ref: "RPT-2@00ff11" }]);
  assert.equal(nextDocId([{ id: "WO-1" }, { id: "RPT-4" }, { id: "WO-3" }], "WO"), "WO-4");
  assert.equal(sha6("x").length, 6);
});

test("file, find by id or exact version", () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-"));
  try {
    const a = fileDoc(dir, { kind: "WO", title: "t", body: "one" });
    const b = fileDoc(dir, { kind: "WO", title: "t2", body: "two" });
    assert.equal(a.ref, `WO-1@${sha6("one")}`);
    assert.equal(b.id, "WO-2");
    const docs = readDocs(dir);
    assert.equal(findDoc(docs, "WO-2").body, "two");
    assert.equal(findDoc(docs, a.ref).body, "one");
    assert.equal(findDoc(docs, "WO-1@000000"), null);
    assert.throws(() => fileDoc(dir, { kind: "XX", title: "t", body: "b" }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("checkRefs: unknown refs and unquoted refs are rejected", () => {
  const docs = [{ id: "WO-1", sha: "aaaaaa" }];
  const callRefs = new Map([["R-1", "WO-1@aaaaaa"]]);
  const chk = (m) => checkRefs(m, parseHead(m.split("\n")[0]), docs, callRefs, parseRefs);
  assert.equal(chk("WILCO R-1 WO-1@aaaaaa").ok, true);
  assert.equal(chk("WILCO R-1").reason, "ref-not-quoted");
  assert.equal(chk("DONE R-1 WO-1@aaaaaa — see RPT-9@bbbbbb").reason, "unknown-ref");
  assert.equal(chk("[CALL] W/U FILED WO-1@abcdef — x").reason, "unknown-ref");
  assert.equal(chk("ROGER R-2").ok, true);
});

test("decide in filed mode records the call ref and blocks an unquoted WILCO", () => {
  const cfg = { mode: "enforce", ackTimeoutSec: 60, workTimeoutSec: 180, filed: true };
  const docs = [{ id: "WO-1", sha: "aaaaaa" }];
  const now = new Date("2026-10-05T12:00:00Z");
  const c = decide({ to: "XP-AC1", message: "[CALL] W/U FILED WO-1@aaaaaa — cart fix" }, [], cfg, now, "ctl", docs);
  assert.equal(c.entry.ref, "WO-1@aaaaaa");
  const ledger = [c.entry];
  const bad = decide({ to: "XP-CTL", message: "WILCO R-1" }, ledger, cfg, now, "ac1", docs);
  assert.match(bad.block, /quote it on the first line/);
  const good = decide({ to: "XP-CTL", message: "WILCO R-1 WO-1@aaaaaa" }, ledger, cfg, now, "ac1", docs);
  assert.equal(good.entry.kind, "reply");
  const off = decide({ to: "XP-CTL", message: "WILCO R-1" }, ledger, { ...cfg, filed: false }, now, "ac1", docs);
  assert.equal(off.entry.kind, "reply");
});

test("a revision keeps the id and gets a new sha; read without sha gives the latest", () => {
  const dir = mkdtempSync(join(tmpdir(), "radio-rev-"));
  try {
    const a = fileDoc(dir, { kind: "WO", title: "t", body: "rev 1" });
    const b = fileDoc(dir, { kind: "WO", title: "t (revision 2)", body: "rev 2", id: a.id });
    assert.equal(b.id, a.id);
    assert.notEqual(b.sha, a.sha);
    assert.equal(findDoc(readDocs(dir), a.id).body, "rev 2");
    assert.equal(findDoc(readDocs(dir), a.ref).body, "rev 1");
    assert.throws(() => fileDoc(dir, { kind: "WO", title: "x", body: "y", id: "WO-9" }));
    assert.equal(fileDoc(dir, { kind: "WO", title: "n", body: "new" }).id, "WO-2");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("push attaches referenced documents; the ledger keeps the sender's length", () => {
  const dir = mkdtempSync(join(tmpdir(), "radio-push-"));
  try {
    const wo = fileDoc(dir, { kind: "WO", title: "Cart totals", body: "step 1\nstep 2" });
    const cfg = { mode: "enforce", ackTimeoutSec: 60, workTimeoutSec: 180, filed: true, push: true };
    const call = decide({ to: "XP-AC1", message: `[CALL] W/U FILED ${wo.ref} — Cart totals` }, [], cfg, new Date(), "ctl", readDocs(dir));
    assert.match(call.message, /^\[CALL R-1\] W\/U FILED/);
    assert.match(call.message, new RegExp(`--- attached ${wo.ref} · Cart totals ---\\nstep 1\\nstep 2\\n--- end ${wo.ref} ---$`));
    assert.equal(call.entry.chars, `[CALL] W/U FILED ${wo.ref} — Cart totals`.length);
    assert.ok(call.entry.attachedChars > 20);
    // without push, nothing is attached
    const plain = decide({ to: "XP-AC1", message: `[CALL] W/U FILED ${wo.ref} — x` }, [], { ...cfg, push: false }, new Date(), "ctl", readDocs(dir));
    assert.doesNotMatch(plain.message, /attached/);
    // the hearback rule still applies to the reply
    const bad = decide({ to: "XP-CTL", message: "WILCO R-1" }, [call.entry], cfg, new Date(), "ac1", readDocs(dir));
    assert.ok(bad.block);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("push on a reply attaches the report but not the quoted work order", () => {
  const dir = mkdtempSync(join(tmpdir(), "radio-push2-"));
  try {
    const wo = fileDoc(dir, { kind: "WO", title: "W", body: "work order body" });
    const rpt = fileDoc(dir, { kind: "RPT", title: "R", body: "report body" });
    const cfg = { mode: "enforce", ackTimeoutSec: 60, workTimeoutSec: 180, filed: true, push: true };
    const call = decide({ to: "XP-AC1", message: `[CALL] W/U FILED ${wo.ref} — W` }, [], cfg, new Date(), "ctl", readDocs(dir));
    const done = decide({ to: "XP-CTL", message: `DONE R-1 ${wo.ref} ${rpt.ref} — done` }, [call.entry], cfg, new Date(), "ac1", readDocs(dir));
    assert.match(done.message, /report body/);
    assert.doesNotMatch(done.message, /work order body/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

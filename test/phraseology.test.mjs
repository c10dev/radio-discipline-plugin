import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMessage, explain, parseHead } from "../lib/phraseology.mjs";

const calls = new Map([["R-1", "W/U"], ["R-2", "A/N"], ["R-3", "R"]]);

test("parses call heads with and without an id", () => {
  assert.deepEqual(parseHead("[CALL] W/U Run the tests."), { kind: "call", id: null, attr: "W/U", text: "Run the tests." });
  assert.deepEqual(parseHead("[CALL R-12] A/N Is main green?"), { kind: "call", id: "R-12", attr: "A/N", text: "Is main green?" });
  assert.equal(parseHead("[CALL] X Run"), null);
  assert.equal(parseHead("[call] W/U Run"), null);
});

test("parses reply heads with the separators people type", () => {
  for (const sep of [" — ", " - ", ": ", " – "]) {
    assert.deepEqual(parseHead(`UNABLE R-4${sep}no network`), { kind: "reply", word: "UNABLE", id: "R-4", note: "no network" });
  }
  assert.deepEqual(parseHead("WILCO R-4"), { kind: "reply", word: "WILCO", id: "R-4", note: null });
  assert.equal(parseHead("Wilco R-4"), null);
  assert.equal(parseHead("WILCO"), null);
  assert.equal(parseHead("Sure, I'll run the tests"), null);
});

test("accepts good messages", () => {
  for (const m of ["WILCO R-1", "STANDBY R-1 — 5 more minutes", "DONE R-1 — 12 passed\nDetails:\n- a\n- b", "UNABLE R-1 — no token", "AFFIRM R-2", "ROGER R-3", "[CALL] W/U Fix the lint errors.", "[CALL R-1] W/U Run the tests (resend)."]) {
    assert.equal(checkMessage(m, calls).ok, true, m);
  }
});

test("rejects with a reason", () => {
  const cases = [
    ["I'll get on it", "no-head"],
    ["WILCO R-9", "unknown-id"],
    ["ROGER R-1", "word-not-allowed"],
    ["WILCO R-3", "word-not-allowed"],
    ["UNABLE R-1", "unable-without-reason"],
    ["UNABLE R-1 — no token\nI tried three ways.", "unable-multiline"],
    ["[CALL] W/U", "empty-call"],
    ["[CALL R-1] R Same id, other attribute", "resend-attr-changed"],
    ["[CALL R-9] W/U invented id", "unknown-id"],
  ];
  for (const [m, reason] of cases) assert.equal(checkMessage(m, calls).reason, reason, m);
});

test("without a ledger, ids are not checked but the format still is", () => {
  assert.equal(checkMessage("WILCO R-9", null).ok, true);
  assert.equal(checkMessage("hello", null).reason, "no-head");
  assert.equal(checkMessage("UNABLE R-9", null).reason, "unable-without-reason");
});

test("structured messages pass through", () => {
  assert.equal(checkMessage({ type: "shutdown_response" }, calls).ok, true);
});

test("every reason has an explanation that names the fix", () => {
  for (const reason of ["no-head", "empty-call", "unknown-id", "resend-attr-changed", "word-not-allowed", "unable-without-reason", "unable-multiline"]) {
    const text = explain(reason, { kind: "reply", word: "ROGER", id: "R-1" }, calls);
    assert.ok(text.length > 20 && !text.includes("undefined"), `${reason}: ${text}`);
  }
  assert.match(explain("word-not-allowed", { word: "ROGER", id: "R-1" }, calls), /WILCO, UNABLE, STANDBY, DONE/);
});

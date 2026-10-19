import { test } from "node:test";
import assert from "node:assert/strict";
import { unsentHead } from "../lib/unsent.mjs";

const prompt = (text) => ({ type: "user", message: { content: text } });
const said = (...content) => ({ type: "assistant", message: { content } });
const text = (t) => ({ type: "text", text: t });
const tool = (name) => ({ type: "tool_use", name, input: {} });
const result = { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } };

test("a reply head written as text with no SendMessage is unsent", () => {
  const e = [prompt("[CALL R-2] W/U FILED WO-2@4a6582"), said(tool("Write")), result, said(text("**DONE R-2** RPT-2@ecbb36 — table done"))];
  assert.equal(unsentHead(e), "DONE R-2 RPT-2@ecbb36 — table done");
});

test("sent with SendMessage in the same turn is fine", () => {
  const e = [prompt("[CALL R-2] W/U go"), said(tool("SendMessage")), result, said(text("DONE R-2 — sent"))];
  assert.equal(unsentHead(e), null);
});

test("plain text without a head is fine", () => {
  assert.equal(unsentHead([prompt("hi"), said(text("Standing by."))]), null);
});

test("only the last turn counts", () => {
  const e = [prompt("[CALL R-1] W/U a"), said(text("DONE R-1 — x")), prompt("TICK"), said(text("Waiting."))];
  assert.equal(unsentHead(e), null);
});

test("a tool result does not start a new turn", () => {
  const e = [prompt("[CALL R-1] W/U a"), said(text("WILCO R-1"), tool("Bash")), result, said(text("All done."))];
  assert.equal(unsentHead(e), "WILCO R-1");
});

test("radio send through Bash counts as sent", () => {
  const e = [prompt("[CALL R-1] W/U a"), said({ type: "tool_use", name: "Bash", input: { command: "node /p/bin/radio.mjs send 'DONE R-1 — ok'" } }), result, said(text("DONE R-1 — ok"))];
  assert.equal(unsentHead(e), null);
});

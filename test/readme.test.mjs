import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DEFAULTS } from "../lib/ledger.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const README = read("README.md");

test("every config key the code reads is documented in the README", () => {
  const code = ["hooks", "lib", "bin"].flatMap((d) => readdirSync(new URL(`../${d}`, import.meta.url)).map((f) => read(`${d}/${f}`))).join("\n");
  const keys = new Set([...Object.keys(DEFAULTS), ...[...code.matchAll(/\bcfg\??\.(\w+)/g)].map((m) => m[1])]);
  assert.ok(keys.size >= 9, [...keys].join(","));
  const table = README.slice(README.indexOf("## Configuration"));
  for (const k of keys) assert.match(table, new RegExp("\\| `" + k + "` \\|"), `config key ${k} is not in the README table`);
});

test("the README install step names a path that works and the clock's wait", () => {
  assert.match(README, /radio\.mjs init/);
  assert.match(README, /plugins\/cache\/radio-discipline\/radio-discipline\/[\d.]+\/bin\/radio\.mjs init/);
  assert.match(README, /## Stop hooks[\s\S]*1080 seconds[\s\S]*"clock": false/);
  const version = JSON.parse(read("package.json")).version;
  for (const f of [".claude-plugin/plugin.json", "package.json"]) assert.equal(JSON.parse(read(f)).version, version, f);
  assert.equal(JSON.parse(read(".claude-plugin/marketplace.json")).plugins[0].version, version);
  assert.match(README, new RegExp(`Status: ${version.replace(/\./g, "\\.")}`));
  assert.match(README, new RegExp(`radio-discipline/${version.replace(/\./g, "\\.")}/bin`));
});

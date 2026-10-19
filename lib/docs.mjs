// Filed documents: long work orders and reports live in a table, messages carry only a reference.
// Like "cleared as filed": the route is in the filed flight plan, the clearance just points at it.
// Table: .radio/docs.jsonl, append-only. A reference is <ID>@<sha6>, e.g. WO-3@a1b2c3, where sha6 is
// the first 6 hex digits of the body's SHA-256, so a reply that quotes it proves which version was read.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const KINDS = Object.freeze(["WO", "RPT"]); // work order, report
export const REF = /\b((?:WO|RPT)-\d+)@([0-9a-f]{6})\b/g;

export const sha6 = (body) => createHash("sha256").update(String(body)).digest("hex").slice(0, 6);

// All references in a text, in order: [{ id, sha, ref }]
export function parseRefs(text) {
  return [...String(text ?? "").matchAll(REF)].map((m) => ({ id: m[1], sha: m[2], ref: m[0] }));
}

export function readDocs(radioDir) {
  const file = join(radioDir, "docs.jsonl");
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

export function nextDocId(docs, kind) {
  let max = 0;
  for (const d of docs) {
    const n = new RegExp(`^${kind}-(\\d+)$`).exec(d.id)?.[1];
    if (n && Number(n) > max) max = Number(n);
  }
  return `${kind}-${max + 1}`;
}

// Latest version of each document: id -> doc
export function latestDocs(docs) {
  const m = new Map();
  for (const d of docs) m.set(d.id, d);
  return m;
}

// Pass `id` (e.g. "WO-3") to file a new version of an existing document: same id, new sha.
export function fileDoc(radioDir, { kind, title, body, id: revise = null, session = null, now = new Date() }) {
  if (!KINDS.includes(kind)) throw new Error(`kind is ${KINDS.join(" or ")}`);
  if (!String(body ?? "").trim()) throw new Error("empty body");
  const docs = readDocs(radioDir);
  if (revise && !(new RegExp(`^${kind}-\\d+$`).test(revise) && docs.some((d) => d.id === revise))) throw new Error(`no ${kind} document ${revise} to revise`);
  const id = revise ?? nextDocId(docs, kind);
  const sha = sha6(body);
  const doc = { v: 1, at: now.toISOString(), id, sha, title: String(title ?? "").slice(0, 120), session, chars: String(body).length, body: String(body) };
  mkdirSync(radioDir, { recursive: true });
  appendFileSync(join(radioDir, "docs.jsonl"), JSON.stringify(doc) + "\n");
  return { ...doc, ref: `${id}@${sha}` };
}

// Find by "WO-3" (latest) or "WO-3@a1b2c3" (exact version).
export function findDoc(docs, key) {
  const m = /^((?:WO|RPT)-\d+)(?:@([0-9a-f]{6}))?$/.exec(String(key ?? "").trim());
  if (!m) return null;
  const versions = docs.filter((d) => d.id === m[1]);
  if (!versions.length) return null;
  return m[2] ? versions.find((d) => d.sha === m[2]) ?? null : versions.at(-1);
}

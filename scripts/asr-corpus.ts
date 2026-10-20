/**
 * pnpm asr:harvest [--from <runsDir>] [--out <file>] — F20. Collects what real ASR heard in finished runs
 * (`runs/<id>/trace.jsonl` asr spans, mock providers skipped) next to what the script said, and appends each new
 * pair to the live corpus as `verdict: "unlabelled"`. The corpus test skips those (and counts them) until a human
 * labels them pass / fail / hallucination. Reads manifests and traces only: no env, no keys, no network.
 */
import { appendFile, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expectedSpeech } from "../src/nodes/final-gate.ts";
import { RunManifest } from "../src/schemas.ts";
import { splitDelivery } from "../src/verbatim.ts";

export interface CorpusRow {
  source: string;
  kind: "line" | "silent";
  expected: string;
  heard: string;
  verdict: "pass" | "fail" | "hallucination" | "unlabelled";
  why?: string;
}

const key = (r: { expected: string; heard: string }) => `${r.expected}\u0000${r.heard}`;

export function parseRows(text: string): CorpusRow[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as CorpusRow);
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** New `{expected, heard}` pairs from the runs in `runsDir`, minus the ones `known` already holds. */
export async function harvest(runsDir: string, known: Iterable<{ expected: string; heard: string }> = []): Promise<CorpusRow[]> {
  const seen = new Set([...known].map(key));
  const out: CorpusRow[] = [];
  let names: string[];
  try {
    names = (await readdir(runsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
  for (const id of names) {
    const raw = await readText(join(runsDir, id, "manifest.json"));
    const trace = await readText(join(runsDir, id, "trace.jsonl"));
    if (!raw || !trace) continue;
    let script;
    try {
      script = RunManifest.parse(JSON.parse(raw)).script;
    } catch {
      continue; // unreadable or half-written: nothing to label against
    }
    if (!script) continue;
    for (const line of trace.split("\n")) {
      let s: { kind?: string; provider?: string; ok?: boolean; cached?: boolean; node?: string; shotId?: string; response?: { text?: unknown } };
      try {
        s = JSON.parse(line);
      } catch {
        continue;
      }
      if (s.kind !== "asr" || !s.ok || s.cached || /^mock/.test(s.provider ?? "mock") || typeof s.response?.text !== "string") continue;
      const heard = s.response.text.trim();
      const shot = script.shots.find((x) => x.id === s.shotId);
      const expected = s.node === "shot" && shot ? splitDelivery(shot.line).spoken : s.node === "burnSubtitles" || s.node === "finalGate" ? expectedSpeech(script) : undefined;
      if (expected === undefined || (expected === "" && heard === "")) continue;
      const row: CorpusRow = { source: `harvest ${id} ${s.node}${s.shotId ? ` ${s.shotId}` : ""} (${s.provider})`, kind: expected === "" ? "silent" : "line", expected, heard, verdict: "unlabelled" };
      if (seen.has(key(row))) continue;
      seen.add(key(row));
      out.push(row);
    }
  }
  return out;
}

export function parseCli(argv: string[]): { from: string; out: string } {
  const opts = { from: "runs", out: "tests/fixtures/asr-live.jsonl" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--from" || a === "--out") {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a path`);
      opts[a === "--from" ? "from" : "out"] = v;
    } else throw new Error(`unknown argument ${a}; usage: pnpm asr:harvest [--from <runsDir>] [--out <file>]`);
  }
  return opts;
}

export async function main(argv: string[], log: (l: string) => void = (l) => process.stdout.write(`${l}\n`)): Promise<number> {
  const { from, out } = parseCli(argv);
  const corpus = resolve(out);
  const tricky = join(resolve(out, ".."), "asr-tricky.jsonl");
  const known = [...parseRows((await readText(corpus)) ?? ""), ...parseRows((await readText(tricky)) ?? "")];
  const rows = await harvest(resolve(from), known);
  if (rows.length) await appendFile(corpus, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
  log(`asr:harvest: ${rows.length} new unlabelled row(s) from ${from} appended to ${out}; label each verdict by hand.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}

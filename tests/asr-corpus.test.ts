/**
 * F20: the verbatim gate against what Whisper really writes, for $0. `asr-live.jsonl` holds real transcripts from live
 * runs (and rows mined from the examples and the AI log); `asr-tricky.jsonl` holds hand-written but realistic
 * renderings of the cases that cost money before. A gate change that breaks one fails here, before any paid run.
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harvest, main as harvestMain, parseCli, parseRows, type CorpusRow } from "../scripts/asr-corpus.ts";
import { speechHeard } from "../src/nodes/visuals.ts";
import { compareLine } from "../src/verbatim.ts";
import { describeOps } from "../src/nodes/gate.ts";

const FIX = join(import.meta.dirname, "fixtures");
const load = (name: string): CorpusRow[] => parseRows(readFileSync(join(FIX, name), "utf8"));

const live = load("asr-live.jsonl");
const tricky = load("asr-tricky.jsonl");
const all = [...live.map((r) => ({ ...r, file: "asr-live" })), ...tricky.map((r) => ({ ...r, file: "asr-tricky" }))];
const labelled = all.filter((r) => r.verdict !== "unlabelled");

describe("ASR regression corpus (F20)", () => {
  it("loads both corpora and prints the counts", () => {
    const count = (rs: CorpusRow[]) => {
      const by: Record<string, number> = {};
      for (const r of rs) by[`${r.kind}:${r.verdict}`] = (by[`${r.kind}:${r.verdict}`] ?? 0) + 1;
      return by;
    };
    const unlabelled = all.length - labelled.length;
    console.log(`asr-live: ${live.length} rows ${JSON.stringify(count(live))}; asr-tricky: ${tricky.length} rows ${JSON.stringify(count(tricky))}; unlabelled skipped: ${unlabelled}`);
    expect(live.length).toBeGreaterThanOrEqual(11);
    expect(tricky.filter((r) => r.verdict === "pass").length).toBeGreaterThanOrEqual(30);
    expect(tricky.filter((r) => r.verdict === "fail").length).toBeGreaterThanOrEqual(15);
    for (const r of all) {
      expect(r.source, JSON.stringify(r)).toBeTruthy();
      expect(["line", "silent"]).toContain(r.kind);
      expect(["pass", "fail", "hallucination", "unlabelled"]).toContain(r.verdict);
    }
    // Every hand-written row says why it is there.
    for (const r of tricky) expect(r.why, r.expected).toMatch(/\S/);
  });

  it("every labelled line row: the verdict equals compareLine(expected, heard).pass", () => {
    const wrong = labelled
      .filter((r) => r.kind === "line")
      .flatMap((r) => {
        const got = compareLine(r.expected, r.heard);
        return (r.verdict === "pass") === got.pass
          ? []
          : [`[${r.file}] ${r.source}${r.why ? ` (${r.why})` : ""}: want ${r.verdict}, gate says ${got.pass ? "pass" : "fail"}; ops: ${describeOps(got.ops) || "none"}\n  expected: ${r.expected}\n  heard:    ${r.heard}`];
      });
    expect(wrong, wrong.join("\n")).toEqual([]);
  });

  it("every silent row is recognised as speech heard in a silent shot (it gets muted)", () => {
    const silent = labelled.filter((r) => r.kind === "silent");
    expect(silent.length).toBeGreaterThan(0);
    const missed = silent.filter((r) => !speechHeard({ text: r.heard, words: [] })).map((r) => `[${r.file}] ${r.source}: "${r.heard}"`);
    expect(missed, missed.join("\n")).toEqual([]);
    // The predicate is not "always true": an empty or symbol-only transcript keeps the ambient audio.
    expect(speechHeard({ text: "", words: [] })).toBe(false);
    expect(speechHeard({ text: " ♪ ", words: [] })).toBe(false);
  });
});

describe("pnpm asr:harvest (F20)", () => {
  it("appends new real-ASR pairs from run traces as unlabelled; skips mock, cached, failed and known pairs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "itv-harvest-"));
    try {
      const runs = join(dir, "runs");
      const run = join(runs, "20261020-073411-a20fab");
      await mkdir(run, { recursive: true });
      await copyFile(join(FIX, "live-manifests", "20261020-073411-a20fab.json"), join(run, "manifest.json"));
      const span = (over: Record<string, unknown>) => JSON.stringify({ id: "x", runId: "r", node: "shot", kind: "asr", provider: "groq-whisper", startedAt: "2026-10-20T07:40:00.000Z", ms: 1, ok: true, costUsd: 0, request: { path: "/app/x.mp4" }, ...over });
      const lines = [
        span({ shotId: "s2", response: { text: " Tickets, $4.50 and this train left Kiev in 1987 — it doesn't stop for anyone. " } }), // new
        span({ shotId: "s1", response: { text: "Thanks for watching." } }), // silent shot, new
        span({ shotId: "s2", response: { text: "Tickets $4.50, and this train left Kyiv in 1987. It doesn't stop for anyone." } }), // already in asr-live
        span({ shotId: "s3", provider: "mock-asr", response: { text: "mock" } }),
        span({ shotId: "s3", cached: true, response: { text: "cached" } }),
        span({ shotId: "s3", ok: false, response: {} }),
        span({ kind: "video", shotId: "s3", response: { text: "not asr" } }),
        span({ node: "finalGate", response: { text: "Tickets for $50 …" } }),
        "{half a line",
      ];
      await writeFile(join(run, "trace.jsonl"), `${lines.join("\n")}\n`);

      const known = load("asr-live.jsonl");
      const rows = await harvest(runs, known);
      expect(rows.map((r) => [r.kind, r.verdict, r.source])).toEqual([
        ["line", "unlabelled", "harvest 20261020-073411-a20fab shot s2 (groq-whisper)"],
        ["silent", "unlabelled", "harvest 20261020-073411-a20fab shot s1 (groq-whisper)"],
        ["line", "unlabelled", "harvest 20261020-073411-a20fab finalGate (groq-whisper)"],
      ]);
      expect(rows[0]!.expected).toMatch(/^Ticket's \$4\.50/);
      expect(rows[0]!.heard).toBe("Tickets, $4.50 and this train left Kiev in 1987 — it doesn't stop for anyone.");
      expect(rows[1]!.expected).toBe("");
      expect(rows[2]!.expected).toMatch(/You promised you'd wait\.$/);

      // main appends to --out, dedupes against it and the tricky corpus next to it, and prints a count, never env.
      const out = join(dir, "fixtures", "asr-live.jsonl");
      await mkdir(join(dir, "fixtures"), { recursive: true });
      await copyFile(join(FIX, "asr-live.jsonl"), out);
      const logs: string[] = [];
      expect(await harvestMain(["--from", runs, "--out", out], (l) => logs.push(l))).toBe(0);
      expect(await harvestMain(["--from", runs, "--out", out], (l) => logs.push(l))).toBe(0);
      const after = parseRows(await readFile(out, "utf8"));
      expect(after.length).toBe(known.length + 3);
      expect(after.filter((r) => r.verdict === "unlabelled")).toHaveLength(3);
      expect(logs[0]).toMatch(/^asr:harvest: 3 new unlabelled row\(s\)/);
      expect(logs[1]).toMatch(/^asr:harvest: 0 new/);
      expect(logs.join("\n")).not.toMatch(/KEY|SECRET|TOKEN/);
      expect(() => parseCli(["--nope"])).toThrow(/usage/);
      expect(parseCli([])).toEqual({ from: "runs", out: "tests/fixtures/asr-live.jsonl" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is wired as pnpm asr:harvest without loading .env", async () => {
    const pkg = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["asr:harvest"]).toBe("tsx scripts/asr-corpus.ts");
  });
});

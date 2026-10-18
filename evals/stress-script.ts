/**
 * Hard-idea stress test, $0. Scratch tool for docs/hard-ideas-report.md, not part of `pnpm verify`.
 *
 *   npx tsx --env-file=.env evals/stress-script.ts [--ids a,b] [--fresh] [--no-live]
 *
 * Per idea in evals/hard.jsonl:
 *   1. extractQuotedLines (pure).
 *   2. writeScript with the LIVE Gemini LLM (free tier). The ONLY live call this file makes. Drafts are cached in
 *      evals/results/hard-gemini-scripts.json so a re-run spends no quota (--fresh ignores the cache, --no-live
 *      only uses the cache).
 *   3. Pure checks on the result: quoted lines verbatim, seconds, normalize() of each line, plus a simulated-ASR
 *      check: plausible Whisper renderings of the line (hand-written below) run through compareWords.
 *   4. The full graph in MOCK mode twice: with the built-in mock script writer, and with the Gemini draft replayed
 *      through a MockLlm (so downstream stages see the real script). Both free.
 * Writes evals/results/<date>-hard-stress.json and prints a table.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPipeline } from "../src/graph.ts";
import { qualityFromEnv } from "../src/nodes/quality.ts";
import { ScriptError, writeScript } from "../src/nodes/script.ts";
import { GeminiLlm } from "../src/providers/gemini.ts";
import { createProviders, MockLlm, type LlmProvider, type LlmRequest, type LlmResult } from "../src/providers/index.ts";
import type { Attempt, Script } from "../src/schemas.ts";
import { compareWords, extractQuotedLines, normalize, splitDelivery, wordCount } from "../src/verbatim.ts";
import { parseIdeas } from "./metrics.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, "results", "hard-gemini-scripts.json");

/**
 * What Whisper (language=en, no prompt) plausibly writes for the spoken line. Hand-written from Whisper's usual
 * habits (digits for numbers, ASCII for foreign names, "AM", "24-7", laughter as "(laughs)" or "Ha ha"), so the
 * normaliser can be stress-tested with no audio and no API.
 */
const ASR_GUESSES: Record<string, string[]> = {
  "dialogue-two-speakers": ["Your father would have hated this parking lot. He hated every parking lot, Mom."],
  "three-lines": ["Where were you? Who saw you? Why are you lying to me?"],
  "long-line-33w": [
    "I played this song at our wedding, at your funeral, and every Sunday since, and I will keep playing it until these old hands finally forget how it goes.",
  ],
  "numbers-money-time": [
    "It's $4.50, it's 3:15 a.m., and we've been open 24/7 since 1987.",
    "It's $4.50, it's 3.15 AM, and we've been open 24-7 since 1987.",
    "It's four fifty, it's three fifteen a.m., and we've been open twenty-four seven since nineteen eighty-seven.",
  ],
  "unusual-names": [
    "Siobhan, tell Zoe that Mr. Nguyen is waiting downstairs.",
    "Shivaun, tell Zoe that Mr. Win is waiting downstairs.",
    "Siobhán, tell Zoë that Mr. Nguyễn is waiting downstairs.",
  ],
  "ellipsis-emdash-question-exclaim": ["Wait, you kept them, all of them? Every single one!"],
  "nested-single-quotes": ["He wrote, don't wait for me, and then he waited anyway."],
  "nested-double-quotes": ["When I say stop, you stop. Not in a minute. Now."],
  "ukrainian-only": ["I waited for you all winter.", "Я чекала на тебе цілу зиму."],
  "mixed-en-uk": ["Mamo, ya vdoma. I'm home.", "Мамо, я вдома. I'm home."],
  "cat-speaker": ["You're late again, human."],
  "robot-percent": ["Battery at 3%. Still waiting for you.", "Battery at three percent. Still waiting for you."],
  "child-question": ["Grandpa, why do the stars blink?"],
  "dark-grave": ["Nobody will ever find you here."],
  "abstract-no-quote": [],
  "whisper-tag": ["They're still in the house."],
  "abbrev-emoji": [
    "Dr. Patel, NASA and the FBI are on line two.",
    "Doctor Patel, NASA and the F.B.I. are on line 2.",
  ],
  "very-short-no": ["No."],
  "ends-laughs-tag": ["You actually believed me?", "You actually believed me? (laughs)", "You actually believed me? Ha ha ha."],
};

/** Delegates to the live LLM and keeps every raw reply, so a rejected script can still be shown in the report. */
class Recording implements LlmProvider {
  readonly name: string;
  readonly raws: unknown[] = [];
  readonly notes: string[] = [];
  constructor(private readonly inner: LlmProvider) {
    this.name = inner.name;
  }
  async generateJson<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const r = await this.inner.generateJson(req);
    this.raws.push(r.raw);
    this.notes.push(...(r.notes ?? []));
    return r;
  }
}

interface LiveScript {
  ok: boolean;
  error?: string;
  attempts: Attempt[];
  raws: unknown[];
  script?: Script;
}

type Cache = Record<string, LiveScript>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function liveScript(idea: string, llm: LlmProvider): Promise<LiveScript> {
  const rec = new Recording(llm);
  try {
    const { script, attempts } = await writeScript(idea, { llm: rec });
    return { ok: true, attempts, raws: rec.raws, script };
  } catch (e) {
    const attempts = e instanceof ScriptError ? e.attempts : [];
    return { ok: false, error: errMsg(e), attempts, raws: rec.raws };
  }
}

/** Lines whose normalised form looks wrong: digits left over, an isolated symbol token, or letters lost. */
function normaliserFlags(line: string): string[] {
  const out: string[] = [];
  const n = normalize(splitDelivery(line).spoken);
  if (/\d/.test(n)) out.push(`digits survive normalisation: "${n}"`);
  const sym = n.split(" ").filter((t) => /\p{S}/u.test(t));
  if (sym.length) out.push(`symbol token(s) ASR can never emit: ${sym.join(" ")}`);
  const letters = (s: string) => [...s.normalize("NFKC").toLowerCase()].filter((c) => /\p{L}/u.test(c)).join("");
  // Every letter of the line should still be there (numbers add letters, nothing should remove them).
  const lost = [...letters(splitDelivery(line).spoken)].filter((c) => !letters(n).includes(c));
  if (lost.length) out.push(`letters lost: ${[...new Set(lost)].join("")}`);
  return out;
}

async function mockRun(idea: string, runsDir: string, draft?: unknown) {
  const t0 = performance.now();
  try {
    const o = await runPipeline(
      { idea, mode: "mock" },
      {
        providers: (mode) =>
          createProviders({ mode, env: {}, overrides: draft === undefined ? {} : { llm: new MockLlm({ responder: () => draft }) } }),
        runsDir,
        maxCostUsd: 3,
        quality: qualityFromEnv({}),
        retry: { maxAttempts: 1 },
      },
    );
    const m = o.manifest;
    const failedStages = [...new Set(m.attempts.filter((a) => !a.ok).map((a) => a.stage))];
    return {
      ok: m.ok,
      ...(m.error ? { error: m.error.slice(0, 400) } : {}),
      seconds: m.final?.seconds,
      failedStages,
      verbatimPass: m.verbatim?.pass,
      ms: Math.round(performance.now() - t0),
    };
  } catch (e) {
    return { ok: false, error: `CRASH: ${errMsg(e).slice(0, 400)}`, ms: Math.round(performance.now() - t0) };
  }
}

async function main(argv: string[]) {
  const idsArg = argv.indexOf("--ids");
  const ids = idsArg >= 0 ? (argv[idsArg + 1] ?? "").split(",") : undefined;
  const fresh = argv.includes("--fresh");
  const noLive = argv.includes("--no-live");
  const ideas = parseIdeas(await readFile(join(HERE, "hard.jsonl"), "utf8")).filter((x) => !ids || ids.includes(x.id));
  const cache: Cache = existsSync(CACHE) ? (JSON.parse(await readFile(CACHE, "utf8")) as Cache) : {};
  const llm = noLive ? undefined : GeminiLlm.fromEnv(process.env);
  // Mock run folders are 2–3 MB each of test patterns: keep them out of the repo.
  const runsDir = join(tmpdir(), "idea-to-video-hard-runs");
  await mkdir(runsDir, { recursive: true });

  const rows = [];
  for (const [k, spec] of ideas.entries()) {
    process.stderr.write(`[${k + 1}/${ideas.length}] ${spec.id}\n`);
    // Nested double quotes now throw (F10); the harness records them as "no quotes" instead of crashing.
    const quoted = (() => {
      try {
        return extractQuotedLines(spec.idea);
      } catch {
        return [];
      }
    })();

    let live = cache[spec.id];
    if ((!live || fresh) && llm) {
      live = await liveScript(spec.idea, llm);
      cache[spec.id] = live;
      await writeFile(CACHE, `${JSON.stringify(cache, null, 2)}\n`);
      await sleep(4000); // free tier: stay well under the per-minute limit
    }

    const script = live?.script;
    const lastRaw = live?.raws.at(-1);
    const shots = script?.shots ?? [];
    const lines = shots.map((s) => s.line).filter((l) => l.trim() !== "");
    const allQuotedVerbatim = quoted.every((q) => lines.includes(q));
    const asr = (ASR_GUESSES[spec.id] ?? []).map((heard) => {
      const expected = lines.map((l) => splitDelivery(l).spoken).join(" ") || quoted.map((q) => splitDelivery(q).spoken).join(" ");
      const r = compareWords(expected, heard);
      return { heard, pass: r.pass, ops: r.ops };
    });

    const mockDefault = await mockRun(spec.idea, runsDir);
    const mockGemini = lastRaw !== undefined && live?.ok ? await mockRun(spec.idea, runsDir, lastRaw) : undefined;

    rows.push({
      id: spec.id,
      tags: spec.tags,
      quoted,
      live: live
        ? {
            ok: live.ok,
            ...(live.error ? { error: live.error } : {}),
            attempts: live.attempts.length,
            models: live.attempts.map((a) => a.provider),
            reasons: live.attempts.filter((a) => a.reason).map((a) => a.reason),
          }
        : undefined,
      character: script?.character,
      shots: shots.map((s) => ({ id: s.id, seconds: s.seconds, line: s.line, words: wordCount(splitDelivery(s.line).spoken) })),
      totalSeconds: shots.reduce((a, s) => a + s.seconds, 0),
      allQuotedVerbatim,
      normalized: (lines.length ? lines : quoted).map((l) => ({ line: l, norm: normalize(splitDelivery(l).spoken), flags: normaliserFlags(l) })),
      asr,
      mockDefault,
      mockGemini,
    });
  }

  const out = join(HERE, "results", `${new Date().toISOString().slice(0, 10)}-hard-stress.json`);
  await writeFile(out, `${JSON.stringify(rows, null, 2)}\n`);
  for (const r of rows) {
    const asrPass = r.asr.length ? `${r.asr.filter((a) => a.pass).length}/${r.asr.length}` : "-";
    const flags = r.normalized.flatMap((n) => n.flags).length;
    process.stdout.write(
      `${r.id.padEnd(34)} live=${r.live ? (r.live.ok ? `ok(${r.live.attempts})` : `FAIL(${r.live.attempts})`) : "n/a"} ` +
        `verbatim=${r.allQuotedVerbatim} secs=${r.totalSeconds} normFlags=${flags} asr=${asrPass} ` +
        `mock=${r.mockDefault.ok ? "ok" : "FAIL"} mockGemini=${r.mockGemini ? (r.mockGemini.ok ? "ok" : "FAIL") : "-"}\n`,
    );
  }
  process.stdout.write(`\nresults: ${out}\n`);
}

await main(process.argv.slice(2));

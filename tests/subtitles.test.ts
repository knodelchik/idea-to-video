import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HEIGHT, overlayCuesArgs, WIDTH } from "../src/media/args.ts";
import { cardSvg, CARD, renderCard, wrapLines } from "../src/media/subtitle-card.ts";
import { probe } from "../src/media/ffmpeg.ts";
import { assertCuesMatch, chunkLine, CUE_GAP_CLOSE, CUE_MIN, CUE_TAIL, timeCues } from "../src/nodes/subtitles.ts";
import type { TranscriptWord } from "../src/schemas.ts";
import { alignPieces } from "../src/verbatim.ts";

const exec = promisify(execFile);
const LINE = "It stopped in 1987, at 3:15 a.m., and so did I.";

/** Evenly timed words: 0.5 s apart from `t0`, each 0.4 s long. */
const timed = (text: string, t0 = 1): TranscriptWord[] =>
  text.split(" ").map((word, i) => ({ word, start: t0 + i * 0.5, end: t0 + i * 0.5 + 0.4 }));

describe("chunking (F13 acceptance 2)", () => {
  it("keeps 1987 and 3:15 a.m. intact and breaks at the commas", () => {
    expect(chunkLine(LINE)).toEqual(["It stopped in 1987,", "at 3:15 a.m.,", "and so did I."]);
  });

  it("2–6 words per cue, ≤ 32 chars per line, ≤ 2 lines, never inside a word; joined == line", () => {
    const lines = [
      LINE,
      "Meet me where it started.",
      "I kept the watch. I kept everything.",
      "You told me you would come back before the winter and you never came back at all, not once.",
      "No. I kept it.",
      "Extraordinarily uncharacteristically incomprehensibly unbelievable stuff happened",
      "We open at 7 p.m. on the dot",
      // A lone word before a phrase that splits into a full 6-word piece: must not be left as a 1-word cue.
      "Yes, I am the one who kept every single letter you sent me.",
      "No, I never stopped waiting for you to come home to me.",
      "Okay. So that is how it ended for the both of us tonight.",
    ];
    for (const line of lines) {
      const cues = chunkLine(line);
      expect(cues.join(" ")).toBe(line);
      for (const c of cues) {
        const n = c.split(" ").length;
        expect(n).toBeLessThanOrEqual(6);
        const wrapped = wrapLines(c);
        expect(wrapped.length).toBeLessThanOrEqual(CARD.maxLines);
        // A single word longer than a line can't be broken; everything else fits.
        for (const l of wrapped) if (l.includes(" ")) expect(l.length).toBeLessThanOrEqual(CARD.maxChars);
      }
      if (cues.length > 1) for (const c of cues) expect(c.split(" ").length).toBeGreaterThanOrEqual(2);
    }
    expect(chunkLine("No. I kept it.")).toEqual(["No. I kept it."]);
    // "p.m." stays with its number even when a long phrase has to be split.
    expect(chunkLine("We open at 7 p.m. on the dot").some((c) => /\b7 p\.m\./.test(c))).toBe(true);
  });

  it("assertCuesMatch fails loudly on any drift", () => {
    expect(() => assertCuesMatch(chunkLine(LINE), LINE)).not.toThrow();
    expect(() => assertCuesMatch(["It stopped in 1987", "at 3:15 a.m.,", "and so did I."], LINE)).toThrow(/do not equal the line/);
  });
});

describe("cue timing (F13 acceptance 2)", () => {
  it("numbers align to the spoken words; start = first word, end = last word + tail, clipped by the next cue", () => {
    const heard = timed("It stopped in nineteen eighty-seven, at three fifteen a.m., and so did I.");
    expect(alignPieces(chunkLine(LINE), heard.map((w) => w.word))).toEqual([
      { first: 0, last: 4 },
      { first: 5, last: 8 },
      { first: 9, last: 12 },
    ]);
    const r = timeCues(chunkLine(LINE), heard, { duration: 20 });
    expect(r.timing).toBe("asr");
    // Cue 1 ends at "eighty-seven" (3.4) + 0.15 = 3.55 > cue 2's start 3.5 → clipped: no overlap.
    expect(r.cues).toEqual([
      { start: 1, end: 3.5, text: "It stopped in 1987," },
      { start: 3.5, end: 5.5, text: "at 3:15 a.m.," },
      { start: 5.5, end: 7.55, text: "and so did I." }, // "I." ends 7.4, + CUE_TAIL
    ]);
  });

  it("minimum duration, no overlap, small gaps closed, clamped to the video", () => {
    const words: TranscriptWord[] = [
      { word: "Go", start: 1, end: 1.1 },
      { word: "now.", start: 1.15, end: 1.3 },
      { word: "Run", start: 3, end: 3.2 },
      { word: "fast.", start: 3.25, end: 3.4 },
      { word: "Then", start: 3.9, end: 4 },
      { word: "stop.", start: 4.05, end: 4.2 },
    ];
    const r = timeCues(["Go now.", "Run fast.", "Then stop."], words, { duration: 4.5 });
    const [a, b, c] = r.cues;
    expect(a).toMatchObject({ start: 1, end: 1 + CUE_MIN }); // 0.3 s of speech held for 0.8 s
    expect(b!.start).toBe(3);
    // 0.4 s of speech held to the 0.8 s minimum (3.8), then the 0.1 s gap to the next cue (< CUE_GAP_CLOSE) is closed.
    expect(CUE_GAP_CLOSE).toBeGreaterThan(0.1);
    expect(b!.end).toBe(3.9);
    expect(b!.end).toBe(c!.start);
    expect(c).toMatchObject({ start: 3.9, end: 4.5 }); // min would be 4.7: clamped to the 4.5 s video
    // Cue 1 held to 1.8 (min); the next starts at 1.95: a 0.15 s gap is closed. At 2.2 (0.4 s) it stays open.
    const next = (t: number): TranscriptWord[] => [{ word: "Run", start: t, end: t + 0.1 }, { word: "fast.", start: t + 0.1, end: t + 0.2 }];
    const gap = timeCues(["Go now.", "Run fast."], [words[0]!, words[1]!, ...next(1.95)]);
    expect(gap.cues[0]!.end).toBe(1.95);
    expect(timeCues(["Go now.", "Run fast."], [words[0]!, words[1]!, ...next(2.2)]).cues[0]!.end).toBe(1.8);
    for (const x of [r, gap]) {
      x.cues.forEach((q, i) => {
        expect(q.end).toBeGreaterThan(q.start);
        if (i > 0) expect(q.start).toBeGreaterThanOrEqual(x.cues[i - 1]!.end);
      });
    }
  });

  it("degenerate input (cues on the same instant): every cue keeps a valid window and none overlaps the next", () => {
    const same: TranscriptWord[] = ["Go", "now.", "Run", "fast.", "Then", "stop."].map((word) => ({ word, start: 2, end: 2 }));
    const zeroSpan = timeCues(["Go now.", "Run fast.", "Then stop."], [], { window: { start: 2, end: 2 }, duration: 10 });
    for (const r of [timeCues(["Go now.", "Run fast.", "Then stop."], same, { duration: 10 }), zeroSpan]) {
      r.cues.forEach((q, i) => {
        expect(q.end).toBeGreaterThan(q.start);
        const next = r.cues[i + 1];
        if (next) expect(q.end).toBeLessThanOrEqual(next.start);
      });
      // And the overlay accepts every window.
      expect(() => overlayCuesArgs({ input: "i", out: "o", cues: r.cues.map((q) => ({ png: "p", ...q })) })).not.toThrow();
    }
  });

  it("no timestamps → cues spread over speechStart–speechEnd by word count, recorded as spread", () => {
    const r = timeCues(chunkLine(LINE), [], { window: { start: 1, end: 8 }, duration: 10 });
    expect(r.timing).toBe("spread");
    expect(r.note).toMatch(/no word timestamps/);
    expect(r.cues[0]!.start).toBe(1);
    expect(r.cues.map((c) => c.text).join(" ")).toBe(LINE);
    // Weights 6 / 4 / 4 spoken words ("1987" is three).
    expect(r.cues[1]!.start).toBeCloseTo(1 + 7 * (6 / 14), 2);
    expect(r.cues.at(-1)!.end).toBeCloseTo(8 + CUE_TAIL, 3);
    expect(() => timeCues(chunkLine(LINE), [])).toThrow(/no speech window/);
  });
});

describe("cue cards (F13 acceptance 3)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "itv-subs-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("svg: bold white, black stroke, centred, the family list, text escaped", () => {
    const svg = cardSvg("Tom & Jerry <3");
    expect(svg).toContain('font-family="Arial, Helvetica, DejaVu Sans, sans-serif"');
    expect(svg).toContain('font-weight="700"');
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).toMatch(/fill="#fff" stroke="#000" stroke-width="12"/);
    expect(svg).toContain("Tom &amp; Jerry &lt;3");
  });

  it("a rendered card is 1080 px wide, transparent, with ink only in the lower third", async () => {
    const out = join(dir, "card.png");
    await renderCard("Meet me where it started.", out);
    const p = await probe(out);
    expect(p.width).toBe(WIDTH);
    expect(p.height).toBe(HEIGHT);
    const { stdout } = await exec("ffmpeg", ["-v", "error", "-i", out, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    });
    const px = stdout as Buffer;
    expect(px.length).toBe(WIDTH * HEIGHT * 4);
    let transparent = 0;
    let inkTop = 0;
    let inkLower = 0;
    let white = 0;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const i = (y * WIDTH + x) * 4;
        const a = px[i + 3]!;
        if (a === 0) transparent++;
        else if (y < (HEIGHT * 2) / 3) inkTop++;
        else inkLower++;
        if (a === 255 && px[i]! > 240 && px[i + 1]! > 240 && px[i + 2]! > 240) white++;
      }
    }
    expect(transparent).toBeGreaterThan(WIDTH * HEIGHT * 0.9);
    expect(inkTop).toBe(0);
    expect(inkLower).toBeGreaterThan(2000);
    expect(white).toBeGreaterThan(500); // the glyphs themselves, not only the outline
  });

  it("overlay args: one overlay per cue, enabled only in its half-open window [start, end), audio copied", () => {
    const a = overlayCuesArgs({ input: "in.mp4", out: "o.mp4", cues: [{ png: "a.png", start: 0.5, end: 1.75 }, { png: "b.png", start: 1.75, end: 3 }] });
    const fc = a[a.indexOf("-filter_complex") + 1]!;
    // Half-open: on a frame at exactly t = 1.75 only the second card is drawn (inclusive between() drew both).
    expect(fc).toBe(
      "[0:v:0][1:v:0]overlay=0:0:enable='gte(t,0.5)*lt(t,1.75)'[v1];[v1][2:v:0]overlay=0:0:enable='gte(t,1.75)*lt(t,3)'[vo];[vo]format=yuv420p[v]",
    );
    expect(fc).not.toContain("between(");
    expect(a.join(" ")).toContain("-c:a copy");
    expect(() => overlayCuesArgs({ input: "i", out: "o", cues: [] })).toThrow();
    expect(() => overlayCuesArgs({ input: "i", out: "o", cues: [{ png: "a", start: 2, end: 1 }] })).toThrow(/bad window/);
  });
});

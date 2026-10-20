import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  colorImageArgs,
  concatArgs,
  frameCount,
  loudnormArgs,
  muxArgs,
  normalizeClipArgs,
  sec,
  stillVideoArgs,
  toneArgs,
} from "../src/media/args.ts";
import { parseProbe, probe, run } from "../src/media/ffmpeg.ts";
import { contentKey, once } from "../src/util/cache.ts";

/** Value following `flag` in an args array. */
const after = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

describe("arg builders (acceptance 4)", () => {
  it("normalizeClipArgs: cover-crop to 1080×1920, 30 fps, yuv420p, exact frame count", () => {
    const a = normalizeClipArgs({ input: "in.mp4", out: "out.mp4", seconds: 5, audio: false });
    const vf = after(a, "-vf")!;
    expect(vf).toContain("scale=1080:1920:force_original_aspect_ratio=increase");
    expect(vf).toContain("crop=1080:1920");
    expect(vf).toContain("fps=30");
    expect(vf).toContain("tpad=stop_mode=clone");
    expect(after(a, "-frames:v")).toBe("150");
    expect(after(a, "-pix_fmt")).toBe("yuv420p");
    expect(after(a, "-r")).toBe("30");
    expect(a).toContain("-an");
    expect(a[0]).toBe("-i");
    expect(a.at(-1)).toBe("out.mp4");
  });

  it("normalizeClipArgs: keeps audio padded/cut to the exact frame duration", () => {
    const a = normalizeClipArgs({ input: "in.mp4", out: "o.mp4", seconds: 4.01, audio: true });
    expect(after(a, "-frames:v")).toBe("120");
    expect(after(a, "-af")).toBe("apad,atrim=0:4");
    expect(after(a, "-c:a")).toBe("aac");
    expect(a).not.toContain("-an");
    expect(() => normalizeClipArgs({ input: "i", out: "o", seconds: 0, audio: false })).toThrow(RangeError);
  });

  it("muxArgs: copies video, delays audio by offset, pads/cuts to video length", () => {
    const a = muxArgs({ video: "v.mp4", audio: "a.wav", out: "o.mp4", seconds: 6, offset: 0.25 });
    expect(a.slice(0, 4)).toEqual(["-i", "v.mp4", "-i", "a.wav"]);
    expect(after(a, "-filter_complex")).toBe("[1:a:0]adelay=250:all=1,apad,atrim=0:6[a]");
    expect(after(a, "-c:v")).toBe("copy");
    expect(after(a, "-t")).toBe("6");
    expect(a.filter((x, i) => a[i - 1] === "-map")).toEqual(["0:v:0", "[a]"]);
    expect(after(muxArgs({ video: "v", audio: "a", out: "o", seconds: 1 }), "-filter_complex")).toContain("adelay=0:");
    expect(() => muxArgs({ video: "v", audio: "a", out: "o", seconds: 3, offset: -1 })).toThrow(RangeError);
  });

  it("muxArgs: tempo speeds the audio up before the delay, within 1–1.2", () => {
    const f = after(muxArgs({ video: "v", audio: "a", out: "o", seconds: 9, tempo: 1.15 }), "-filter_complex");
    expect(f).toBe("[1:a:0]atempo=1.150,adelay=0:all=1,apad,atrim=0:9[a]");
    expect(() => muxArgs({ video: "v", audio: "a", out: "o", seconds: 9, tempo: 1.3 })).toThrow(RangeError);
    expect(() => muxArgs({ video: "v", audio: "a", out: "o", seconds: 9, tempo: 0.9 })).toThrow(RangeError);
  });

  it("concatArgs: concat filter over all inputs, with or without audio", () => {
    const a = concatArgs({ inputs: ["a.mp4", "b.mp4"], out: "o.mp4", audio: true });
    expect(a.filter((x, i) => a[i - 1] === "-i")).toEqual(["a.mp4", "b.mp4"]);
    expect(after(a, "-filter_complex")).toBe("[0:v:0][0:a:0][1:v:0][1:a:0]concat=n=2:v=1:a=1[v][a]");
    expect(a.filter((x, i) => a[i - 1] === "-map")).toEqual(["[v]", "[a]"]);
    expect(after(a, "-pix_fmt")).toBe("yuv420p");
    expect(a).toContain("-shortest");
    const s = concatArgs({ inputs: ["a.mp4"], out: "o.mp4", audio: false });
    expect(after(s, "-filter_complex")).toBe("[0:v:0]concat=n=1:v=1:a=0[v]");
    expect(s).toContain("-an");
    expect(() => concatArgs({ inputs: [], out: "o", audio: false })).toThrow(RangeError);
  });

  it("loudnormArgs: −16 LUFS, anull when silent, video copied", () => {
    const a = loudnormArgs({ input: "i.mp4", out: "o.mp4", silent: false });
    expect(after(a, "-af")).toMatch(/^loudnorm=I=-16:/);
    expect(after(a, "-c:v")).toBe("copy");
    expect(after(a, "-ar")).toBe("48000");
    expect(a).toContain("-shortest");
    expect(after(loudnormArgs({ input: "i", out: "o", silent: true }), "-af")).toBe("anull");
  });

  it("mock builders: colour PNG, zooming still, tone", () => {
    expect(after(colorImageArgs({ out: "o.png", hex: "a0b0c0" }), "-i")).toBe("color=c=0xa0b0c0:s=1080x1920");
    expect(() => colorImageArgs({ out: "o", hex: "red" })).toThrow(RangeError);
    const still = stillVideoArgs({ image: "i.png", out: "o.mp4", seconds: 2 });
    expect(after(still, "-vf")).toMatch(/zoompan=.*:d=60:s=1080x1920:fps=30/);
    expect(after(still, "-frames:v")).toBe("60");
    expect(after(toneArgs({ out: "o.wav", seconds: 1.5 }), "-i")).toContain("duration=1.5");
  });

  it("sec / frameCount", () => {
    expect(sec(2.33333)).toBe("2.333");
    expect(sec(4)).toBe("4");
    expect(frameCount(4.01)).toBe(120);
    expect(frameCount(0.001)).toBe(1);
  });

  it("parseProbe reads streams and format duration", () => {
    expect(
      parseProbe({
        streams: [{ codec_type: "video", width: 1080, height: 1920 }, { codec_type: "audio" }],
        format: { duration: "4.000000" },
      }),
    ).toEqual({ seconds: 4, width: 1080, height: 1920, hasAudio: true, hasVideo: true });
    expect(parseProbe({ streams: [{ codec_type: "audio" }], format: { duration: "1.2" } })).toMatchObject({
      hasVideo: false,
      width: 0,
    });
  });
});

describe("real ffmpeg round-trip", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "itv-media-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("still → normalize → mux → concat → loudnorm keeps 1080×1920 and exact length", async () => {
    const img = join(dir, "i.png");
    await run(colorImageArgs({ out: img, hex: "406080" }));
    const still = join(dir, "still.mp4");
    await run(stillVideoArgs({ image: img, out: still, seconds: 2 }));
    const norm = join(dir, "norm.mp4");
    await run(normalizeClipArgs({ input: still, out: norm, seconds: 1.5, audio: false }));
    const tone = join(dir, "t.wav");
    await run(toneArgs({ out: tone, seconds: 3 }));
    const muxed = join(dir, "m.mp4");
    await run(muxArgs({ video: norm, audio: tone, out: muxed, seconds: 1.5, offset: 0.2 }));
    const cat = join(dir, "c.mp4");
    await run(concatArgs({ inputs: [muxed, muxed], out: cat, audio: true }));
    const loud = join(dir, "l.mp4");
    await run(loudnormArgs({ input: cat, out: loud, silent: false }));

    const p = await probe(loud);
    expect(p).toMatchObject({ width: 1080, height: 1920, hasAudio: true, hasVideo: true });
    expect(Math.abs(p.seconds - 3)).toBeLessThanOrEqual(1 / 30 + 0.03);
    expect((await probe(norm)).hasAudio).toBe(false);
  }, 60_000);

  it("run surfaces ffmpeg stderr on failure", async () => {
    await expect(run(["-i", join(dir, "missing.mp4"), join(dir, "x.mp4")])).rejects.toThrow(/ffmpeg failed/);
  });
});

describe("cache (acceptance 3)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "itv-cache-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("contentKey hashes file contents, not paths, and is delimiter-safe", async () => {
    const a = join(dir, "a.txt");
    const b = join(dir, "b.txt");
    await writeFile(a, "same");
    await writeFile(b, "same");
    expect(await contentKey("x", { file: a })).toBe(await contentKey("x", { file: b }));
    await writeFile(b, "different");
    expect(await contentKey("x", { file: a })).not.toBe(await contentKey("x", { file: b }));
    expect(await contentKey("ab", "c")).not.toBe(await contentKey("a", "bc"));
    expect(await contentKey("same")).not.toBe(await contentKey({ file: a }));
    expect(await contentKey("k", 1)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("once never calls fn twice for the same out (sequential and concurrent)", async () => {
    const out = join(dir, "once.txt");
    let calls = 0;
    const fn = async (tmp: string) => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      await writeFile(tmp, "data");
      await writeFile(`${tmp}.transcript.json`, "{}");
      return 42;
    };
    const [r1, r2] = await Promise.all([once(out, fn), once(out, fn)]);
    const r3 = await once(out, fn);
    expect(calls).toBe(1);
    expect(r1).toEqual({ path: out, cached: false, result: 42 });
    expect(r2.cached).toBe(true);
    expect(r3).toEqual({ path: out, cached: true });
    // Companion files follow the main file.
    expect((await readdir(dir)).filter((f) => f.startsWith("once."))).toEqual(["once.txt", "once.txt.transcript.json"]);
  });

  it("a crashed write leaves no partial file (and can be retried)", async () => {
    const out = join(dir, "crash.mp4");
    const boom = once(out, async (tmp) => {
      expect(tmp.endsWith(".mp4")).toBe(true); // ffmpeg needs the extension
      await writeFile(tmp, "half");
      await writeFile(`${tmp}.transcript.json`, "{}");
      throw new Error("boom");
    });
    await expect(boom).rejects.toThrow("boom");
    expect((await readdir(dir)).filter((f) => f.startsWith("crash"))).toEqual([]);
    const ok = await once(out, async (tmp) => writeFile(tmp, "full"));
    expect(ok.cached).toBe(false);
  });

  it("once fails if fn forgot to write the file", async () => {
    await expect(once(join(dir, "nothing.txt"), async () => undefined)).rejects.toThrow(/did not write/);
  });
});

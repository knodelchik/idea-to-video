import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPreflight, envReport } from "../scripts/preflight.ts";
import { guardFetch, main } from "../scripts/smoke-free.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Req = { label: string; error?: string; requests?: Record<string, unknown>[] };

describe("preflight", () => {
  const env = {
    FAL_KEY: "fal-secret-value-1",
    ARK_API_KEY: "ark-secret-value-2",
    GEMINI_API_KEY: "gem-secret-value-3",
    SEEDANCE_TIER: "fast",
  };

  it("builds every live request without touching the network or leaking a key", async () => {
    const net = vi.fn(async () => {
      throw new Error("network");
    });
    globalThis.fetch = net as unknown as typeof fetch;
    const report = await buildPreflight(env);
    expect(net).not.toHaveBeenCalled();
    const text = JSON.stringify(report);
    for (const secret of Object.values(env).filter((v) => v.includes("secret"))) expect(text).not.toContain(secret);

    const reqs = report.requests as Req[];
    expect(reqs.filter((r) => r.error)).toEqual([]);
    const byLabel = (l: string) => reqs.find((r) => r.label.startsWith(l))!.requests!;

    const fal = byLabel("seedance fal").at(-1)!;
    expect(fal.endpoint).toBe("bytedance/seedance-2.0/fast/image-to-video");
    expect(fal.input).toMatchObject({ duration: "7", aspect_ratio: "9:16", resolution: "720p", generate_audio: true });

    const bp = byLabel("seedance byteplus")[0]!;
    expect(bp.url).toBe("https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks");
    expect(bp.headers).toEqual({ Authorization: "Bearer <redacted>", "Content-Type": "application/json" });
    expect(bp.body).toMatchObject({ model: "dreamina-seedance-2-0-fast-260128", duration: 7, ratio: "9:16", generate_audio: true });

    const or = byLabel("seedance openrouter")[0]!;
    expect(or.url).toBe("https://openrouter.ai/api/v1/videos");
    expect(or.headers).toEqual({ Authorization: "Bearer <redacted>", "Content-Type": "application/json" });
    expect(or.body).toMatchObject({ model: "bytedance/seedance-2.0-fast", duration: 7, aspect_ratio: "9:16", resolution: "720p", generate_audio: true });
    const orImg = byLabel("image openrouter")[0]!;
    expect(orImg.url).toBe("https://openrouter.ai/api/v1/images");
    expect(orImg.body).toMatchObject({ model: "google/gemini-nano-banana-2.1", aspect_ratio: "9:16" });

    const asr = byLabel("asr groq")[0]!;
    expect(JSON.stringify(asr.body)).toContain("timestamp_granularities[]");
    expect(byLabel("judge gemini")[0]!.params).toMatchObject({ model: "gemini-3.5-flash" });
  });

  it("env report lists names only", () => {
    const r = envReport(env);
    expect(r.set).toEqual(["GEMINI_API_KEY", "FAL_KEY", "ARK_API_KEY", "SEEDANCE_TIER"]);
    expect(r.missing).toContain("GROQ_API_KEY");
    expect(r.missing).toContain("OPENROUTER_API_KEY");
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});

describe("smoke-free", () => {
  it("refuses to run without --yes and calls nothing", async () => {
    const net = vi.fn();
    globalThis.fetch = net as unknown as typeof fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main([], { GEMINI_API_KEY: "g", GROQ_API_KEY: "q" })).toBe(1);
    log.mockRestore();
    expect(net).not.toHaveBeenCalled();
  });

  it("the fetch guard only lets Google's and Groq's API hosts through", async () => {
    const inner = vi.fn(async () => new Response("ok"));
    const f = guardFetch(inner as unknown as typeof fetch);
    await f("https://api.groq.com/openai/v1/audio/transcriptions");
    await f(new URL("https://generativelanguage.googleapis.com/v1beta/models"));
    for (const paid of ["https://queue.fal.run/x", "https://ark.ap-southeast.bytepluses.com/api/v3", "https://api.elevenlabs.io/v1"]) {
      await expect(f(paid)).rejects.toThrow(/refusing non-free host/);
    }
    expect(inner).toHaveBeenCalledTimes(2);
  });
});

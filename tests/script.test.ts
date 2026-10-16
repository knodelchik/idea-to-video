import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createProviders, MockLlm } from "../src/providers/index.ts";
import { GeminiLlm, toGeminiSchema, type GenAiClient } from "../src/providers/gemini.ts";
import { SCRIPT_PROMPT_VERSION, SCRIPT_SYSTEM } from "../src/prompts/script.ts";
import { ScriptError, scriptProblems, writeScript } from "../src/nodes/script.ts";
import { Script, ScriptDraft, type Shot } from "../src/schemas.ts";

const QUOTE = "Meet me where it all started.";
const IDEA = `A tired barista finds a note in the tip jar. She reads it aloud: "${QUOTE}"`;
const LOOK = "late twenties, tired brown eyes, dark hair in a messy bun, flour on her cheek, green apron over a grey tee";

function shot(over: Partial<Shot> = {}): Shot {
  return {
    id: "s1",
    camera: "close-up",
    visual: "She unfolds a small note above the tip jar",
    motion: "slow push-in on her face",
    emotion: "hopeful disbelief",
    line: QUOTE,
    seconds: 8,
    ...over,
  };
}

function draft(shots: Shot[] = [shot()], look = LOOK): ScriptDraft {
  return {
    title: "The Note",
    logline: "A barista finds a note from someone she lost.",
    setting: "Small café counter at closing time",
    character: { name: "Maya", look, voice: { gender: "female", age: "adult", tone: "soft, tired" } },
    shots,
  };
}

function script(d: ScriptDraft, quotedLines: string[] = [QUOTE]): Script {
  return { ...d, promptVersion: SCRIPT_PROMPT_VERSION, quotedLines };
}

describe("prompt", () => {
  it("has a version and the verbatim rule", () => {
    expect(SCRIPT_PROMPT_VERSION).toMatch(/\S/);
    expect(SCRIPT_SYSTEM).toMatch(/character-for-character/);
    expect(SCRIPT_SYSTEM).toMatch(/16 words/);
  });
});

describe("scriptProblems", () => {
  it("accepts a correct script", () => {
    expect(scriptProblems(script(draft()), IDEA)).toEqual([]);
  });

  it("rejects a paraphrased quote", () => {
    const s = script(draft([shot({ line: "Meet me where it started." })]));
    const p = scriptProblems(s, IDEA);
    expect(p.join("\n")).toContain(`"${QUOTE}"`);
    expect(p.join("\n")).toMatch(/exactly/);
  });

  it("rejects a quote that differs only in punctuation or case", () => {
    expect(scriptProblems(script(draft([shot({ line: "Meet me where it all started" })])), IDEA)).not.toEqual([]);
    expect(scriptProblems(script(draft([shot({ line: "meet me where it all started." })])), IDEA)).not.toEqual([]);
  });

  it("rejects quotedLines that differ from the idea's quotes", () => {
    const p = scriptProblems(script(draft(), []), IDEA);
    expect(p.join("\n")).toMatch(/quotedLines/);
  });

  it("flags total duration with a specific message (acceptance 2)", () => {
    const short = scriptProblems(script(draft([shot({ seconds: 5 })])), IDEA);
    expect(short).toContainEqual(expect.stringMatching(/total duration 5 s is outside 8–30 s/));
    const long = scriptProblems(
      script(draft([shot({ seconds: 20 }), shot({ id: "s2", line: "", seconds: 15 })])),
      IDEA,
    );
    expect(long).toContainEqual(expect.stringMatching(/total duration 35 s is outside 8–30 s/));
  });

  it("flags shot count with a specific message (acceptance 2)", () => {
    const three = [shot({ seconds: 4 }), shot({ id: "s2", line: "", seconds: 4 }), shot({ id: "s2", line: "", seconds: 4 })];
    expect(scriptProblems(script(draft(three)), IDEA)).toContainEqual(expect.stringMatching(/1–2 shots, got 3/));
    expect(scriptProblems(script(draft([])), IDEA)).toContainEqual(expect.stringMatching(/1–2 shots, got 0/));
  });

  it("flags digits in a non-quoted line, but not in a quoted one (acceptance 2)", () => {
    const idea = "A man checks his watch at the station.";
    const p = scriptProblems(script(draft([shot({ line: "The 9 train is late again." })]), []), idea);
    expect(p).toContainEqual(expect.stringMatching(/shot s1 line has digits "9".*spell numbers out/));
    const quoted = 'He says "Platform 9, 3:15." and waits.';
    const ok = scriptProblems(script(draft([shot({ line: "Platform 9, 3:15." })]), ["Platform 9, 3:15."]), quoted);
    expect(ok.filter((m) => /digit/.test(m))).toEqual([]);
  });

  it("flags an unspeakable line with a specific message (acceptance 2)", () => {
    // 16 words → 16 / 2.6 + 0.8 ≈ 6.95 s > 4 s.
    const line = "I have been waiting here every single night for you to come back through that door";
    const p = scriptProblems(script(draft([shot({ line, seconds: 4 }), shot({ id: "s2", line: "", seconds: 6 })]), []), "x");
    expect(p).toContainEqual(expect.stringMatching(/shot s1: 16 words need 7\.0 s .* has 4 s/));
  });

  it("flags a thin character.look", () => {
    const p = scriptProblems(script(draft([shot()], "a tired barista")), IDEA);
    expect(p).toContainEqual(expect.stringMatching(/character\.look has 3 words; needs at least 12/));
  });

  it("flags wrong shot ids", () => {
    const p = scriptProblems(script(draft([shot({ id: "s2" })])), IDEA);
    expect(p).toContainEqual(expect.stringMatching(/shot 1 must have id "s1"/));
  });
});

describe("writeScript", () => {
  it("re-prompts with the problem after a paraphrase, then passes (acceptance 1)", async () => {
    const bad = draft([shot({ line: "Meet me where it started." })]);
    const llm = new MockLlm({ queue: [bad, draft()] });
    const { script: s, attempts } = await writeScript(IDEA, { llm });
    expect(s.shots[0]!.line).toBe(QUOTE);
    expect(s.quotedLines).toEqual([QUOTE]);
    expect(s.promptVersion).toBe(SCRIPT_PROMPT_VERSION);
    expect(Script.safeParse(s).success).toBe(true);
    expect(llm.calls).toHaveLength(2);
    const problem = scriptProblems(script(bad), IDEA)[0]!;
    expect(llm.calls[1]!.prompt).toContain(problem);
    expect(llm.calls[1]!.prompt).toContain('"Meet me where it started."'); // the previous JSON
    expect(llm.calls[0]!.system).toBe(SCRIPT_SYSTEM);
    expect(attempts.map((a) => [a.stage, a.n, a.ok, a.provider])).toEqual([
      ["script", 1, false, "mock-llm"],
      ["script", 2, true, "mock-llm"],
    ]);
    expect(attempts[0]!.reason).toContain(problem);
    for (const a of attempts) expect(a.costUsd).toBe(0);
  });

  it("tells the model the quoted lines in the first prompt", async () => {
    const llm = new MockLlm({ queue: [draft()] });
    await writeScript(IDEA, { llm });
    expect(llm.calls[0]!.prompt).toContain(IDEA);
    expect(llm.calls[0]!.prompt).toContain(JSON.stringify(QUOTE));
  });

  it("throws ScriptError with the problems after 3 bad answers (acceptance 3)", async () => {
    const bad = draft([shot({ line: "Meet me where it started.", seconds: 5 })]);
    const llm = new MockLlm({ queue: [bad, bad, bad, draft()] });
    const err = await writeScript(IDEA, { llm }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScriptError);
    const e = err as ScriptError;
    expect(e.problems).toEqual(scriptProblems(script(bad), IDEA));
    expect(e.problems.join("\n")).toMatch(/total duration 5 s/);
    expect(e.message).toContain(e.problems[0]);
    expect(e.attempts).toHaveLength(3);
    expect(e.attempts.every((a) => !a.ok)).toBe(true);
    expect(llm.calls).toHaveLength(3);
  });

  it("feeds a bad shape back as problems", async () => {
    const llm = new MockLlm({ queue: [{ title: "x" }, draft()] });
    const { attempts } = await writeScript(IDEA, { llm });
    expect(attempts[0]!.ok).toBe(false);
    expect(llm.calls[1]!.prompt).toMatch(/character/);
  });

  it("without quotes, a valid generated line passes and quotedLines is [] (acceptance 4)", async () => {
    const idea = "An old fisherman finds his late wife's ring in a fish at dawn.";
    const d = draft([shot({ line: "You always said you'd come back to me.", seconds: 6 }), shot({ id: "s2", line: "", seconds: 4 })]);
    const llm = new MockLlm({ queue: [d] });
    const { script: s, attempts } = await writeScript(idea, { llm });
    expect(s.quotedLines).toEqual([]);
    expect(s.shots[0]!.line).toBe("You always said you'd come back to me.");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.ok).toBe(true);
  });
});

// --- Gemini adapter, through a fake client only (acceptance 5) ---

type Params = Parameters<GenAiClient["models"]["generateContent"]>[0];

function fakeClient(script: (params: Params, call: number) => unknown): GenAiClient & { calls: Params[] } {
  const calls: Params[] = [];
  return {
    calls,
    models: {
      async generateContent(params: Params) {
        calls.push(params);
        const r = script(params, calls.length - 1);
        if (r instanceof Error) throw r;
        return r as Awaited<ReturnType<GenAiClient["models"]["generateContent"]>>;
      },
    },
  };
}

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const Small = z.object({ answer: z.string().min(1) });

describe("GeminiLlm (fake client)", () => {
  it("sends the JSON schema and system prompt, parses the answer, prices tokens", async () => {
    const client = fakeClient(() => ({
      text: JSON.stringify({ answer: "hi" }),
      usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 100_000, thoughtsTokenCount: 100_000 },
    }));
    const llm = new GeminiLlm({ client, models: ["gemini-2.5-flash"] });
    const r = await llm.generateJson({ system: "SYS", prompt: "P", schema: Small, temperature: 0.7 });
    expect(r.ok && r.data).toEqual({ answer: "hi" });
    expect(r.model).toBe("gemini-2.5-flash");
    expect(r.costUsd).toBeCloseTo(0.3 + 0.2 * 2.5, 6);
    const p = client.calls[0]!;
    expect(p.model).toBe("gemini-2.5-flash");
    expect(p.contents).toBe("P");
    expect(p.config?.systemInstruction).toBe("SYS");
    expect(p.config?.temperature).toBe(0.7);
    expect(p.config?.responseMimeType).toBe("application/json");
    expect(p.config?.responseJsonSchema).toEqual(toGeminiSchema(Small));
  });

  it("returns ok:false with the zod issues on a bad shape", async () => {
    const client = fakeClient(() => ({ text: JSON.stringify({ answer: "" }) }));
    const r = await new GeminiLlm({ client, models: ["gemini-2.5-flash"] }).generateJson({ system: "", prompt: "", schema: Small });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/answer/);
  });

  it("returns ok:false on non-JSON text", async () => {
    const client = fakeClient(() => ({ text: "not json" }));
    const r = await new GeminiLlm({ client, models: ["gemini-2.5-flash"] }).generateJson({ system: "", prompt: "", schema: Small });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JSON/);
  });

  it("falls to the next model on 429/503 and records it", async () => {
    const client = fakeClient((p) =>
      p.model === "a" ? httpError(429) : p.model === "b" ? httpError(503) : { text: JSON.stringify({ answer: "ok" }) },
    );
    const r = await new GeminiLlm({ client, models: ["a", "b", "gemini-2.5-flash"] }).generateJson({ system: "", prompt: "", schema: Small });
    expect(r.ok).toBe(true);
    expect(client.calls.map((c) => c.model)).toEqual(["a", "b", "gemini-2.5-flash"]);
    expect(r.model).toBe("gemini-2.5-flash");
    expect(r.notes).toEqual([expect.stringMatching(/a.*429/), expect.stringMatching(/b.*503/)]);
  });

  it("throws on other errors and when every model is unavailable", async () => {
    const boom = fakeClient(() => httpError(400));
    await expect(new GeminiLlm({ client: boom, models: ["a", "b"] }).generateJson({ system: "", prompt: "", schema: Small })).rejects.toThrow(/400/);
    expect(boom.calls).toHaveLength(1);
    const busy = fakeClient(() => httpError(429));
    await expect(new GeminiLlm({ client: busy, models: ["a", "b"] }).generateJson({ system: "", prompt: "", schema: Small })).rejects.toThrow(/all models unavailable.*a.*b/);
  });

  it("notes an unknown model price instead of silently reporting it as free", async () => {
    const client = fakeClient(() => ({ text: JSON.stringify({ answer: "ok" }), usageMetadata: { promptTokenCount: 10 } }));
    const r = await new GeminiLlm({ client, models: ["mystery"] }).generateJson({ system: "", prompt: "", schema: Small });
    expect(r.costUsd).toBe(0);
    expect(r.notes).toContainEqual(expect.stringMatching(/no price.*mystery/));
  });

  it("reads the model chain and key from env", () => {
    expect(() => GeminiLlm.fromEnv({})).toThrow(/GEMINI_API_KEY/);
    const llm = GeminiLlm.fromEnv({ GEMINI_API_KEY: "k", SCRIPT_MODELS: " x , y ,," }, fakeClient(() => ({})));
    expect(llm.models).toEqual(["x", "y"]);
  });

  it("is the live llm in createProviders (client built locally, no request made)", () => {
    const env = { GEMINI_API_KEY: "k", GROQ_API_KEY: "k", FAL_KEY: "k" };
    const { llm: _unused, ...m } = createProviders({ mode: "mock", env: {} });
    const p = createProviders({ mode: "live", env, overrides: m });
    expect(p.llm).toBeInstanceOf(GeminiLlm);
    expect(p.tts).toBe(m.tts);
  });

  it("produces a schema with only keywords Gemini documents", () => {
    const s = toGeminiSchema(ScriptDraft) as Record<string, unknown>;
    expect(s.$schema).toBeUndefined();
    expect(JSON.stringify(s)).not.toMatch(/"(minLength|pattern|\$schema)"/);
    expect(s.type).toBe("object");
    expect(s.required).toContain("shots");
  });
});

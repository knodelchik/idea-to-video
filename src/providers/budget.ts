/**
 * MAX_COST_USD guard. Every provider call asks the provider what it *would* cost first; a call that would push
 * spent + in-flight estimates past the cap is refused before any request leaves the machine. Parallel shots
 * reserve their estimate, so two concurrent calls can't both squeeze under the cap.
 */
import type { Providers } from "./types.ts";

export const DEFAULT_MAX_COST_USD = 3;

export class BudgetExceededError extends Error {
  constructor(
    readonly provider: string,
    readonly estimateUsd: number,
    readonly committedUsd: number,
    readonly maxUsd: number,
  ) {
    super(
      `budget: ${provider} call would cost ~$${estimateUsd.toFixed(4)} on top of $${committedUsd.toFixed(4)} ` +
        `already spent or in flight, over MAX_COST_USD=$${maxUsd}; aborted before calling`,
    );
    this.name = "BudgetExceededError";
  }
}

/** MAX_COST_USD from env. Unset → default; anything non-numeric or negative fails loudly. */
export function maxCostFromEnv(env: Record<string, string | undefined>): number {
  const raw = env.MAX_COST_USD;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_COST_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`MAX_COST_USD must be a number >= 0, got "${raw}"`);
  return n;
}

export class Budget {
  private reserved = 0;
  constructor(
    readonly maxUsd: number,
    /** Already spent (e.g. by the finished stages of a resumed run). */
    public spentUsd = 0,
  ) {}

  /** Runs `call` only if its estimate fits; books the actual cost afterwards (even a failed call releases). */
  async guard<R extends { costUsd: number }>(provider: string, estimateUsd: number, call: () => Promise<R>): Promise<R> {
    const committed = this.spentUsd + this.reserved;
    // A 0-cost call (mocks, local tools) is never refused: the cap is about money, not about calls.
    if (estimateUsd > 0 && committed + estimateUsd > this.maxUsd + 1e-9) {
      throw new BudgetExceededError(provider, estimateUsd, committed, this.maxUsd);
    }
    this.reserved += estimateUsd;
    try {
      const r = await call();
      this.spentUsd += r.costUsd;
      return r;
    } finally {
      this.reserved -= estimateUsd;
    }
  }
}

/** Same providers, every paid method behind `budget.guard`. Read-only fields (capabilities, maxSeconds) delegate. */
export function withBudget(p: Providers, budget: Budget): Providers {
  const { llm, tts, asr, image, video, lipsync, talking } = p;
  return {
    llm: {
      name: llm.name,
      generateJson: (req) => budget.guard(llm.name, llm.estimateUsd?.(req) ?? 0, () => llm.generateJson(req)),
    },
    tts: { name: tts.name, speak: (req) => budget.guard(tts.name, tts.estimateUsd?.(req) ?? 0, () => tts.speak(req)) },
    asr: {
      name: asr.name,
      transcribe: (req) => budget.guard(asr.name, asr.estimateUsd?.(req) ?? 0, () => asr.transcribe(req)),
    },
    image: {
      name: image.name,
      generate: (req) => budget.guard(image.name, image.estimateUsd?.(req) ?? 0, () => image.generate(req)),
    },
    video: {
      name: video.name,
      get capabilities() {
        return video.capabilities;
      },
      animate: (req) => budget.guard(video.name, video.estimateUsd?.(req) ?? 0, () => video.animate(req)),
    },
    lipsync: {
      name: lipsync.name,
      get maxSeconds() {
        return lipsync.maxSeconds;
      },
      sync: (req) => budget.guard(lipsync.name, lipsync.estimateUsd?.(req) ?? 0, () => lipsync.sync(req)),
    },
    talking: {
      name: talking.name,
      talk: (req) => budget.guard(talking.name, talking.estimateUsd?.(req) ?? 0, () => talking.talk(req)),
    },
  };
}

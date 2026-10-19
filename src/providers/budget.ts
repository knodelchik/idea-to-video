/**
 * MAX_COST_USD guard. Every provider call asks the provider what it *would* cost first; a call that would push
 * spent + in-flight estimates past the cap is refused before any request leaves the machine. Parallel shots
 * reserve their estimate, so two concurrent calls can't both squeeze under the cap.
 */
import type { JudgeProvider, JudgeVideoRequest, Providers } from "./types.ts";

export const DEFAULT_MAX_COST_USD = 3;
/** Clip length assumed for a video judge request that doesn't say (the longest shot a script allows). */
const JUDGE_VIDEO_SECONDS_FALLBACK = 15;

/**
 * A clip judged as video may fall back to its frames (F14), so reserve the dearer of the two. The fallback is a
 * second request only after a 400, which Gemini does not bill, so the max is the worst case, not the sum.
 */
export function judgeVideoEstimate(judge: JudgeProvider, req: JudgeVideoRequest): number {
  const refs = req.refs?.length ?? 0;
  const frames = judge.estimateUsd?.({ images: req.frames.length + refs, rubric: req.rubric }) ?? 0;
  if (!req.video) return frames;
  const video = judge.estimateUsd?.({ images: refs, rubric: req.rubric, videoSeconds: req.seconds ?? JUDGE_VIDEO_SECONDS_FALLBACK }) ?? 0;
  return Math.max(frames, video);
}

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

  /**
   * Would a call (or a group of calls) estimated at `estimateUsd` fit right now? Lets a node skip an *optional*
   * step (a quality regeneration) and record why, instead of starting it and failing the run with BudgetExceededError.
   */
  allows(estimateUsd: number): boolean {
    return estimateUsd <= 0 || this.spentUsd + this.reserved + estimateUsd <= this.maxUsd + 1e-9;
  }

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
    } catch (e) {
      // Some errors were paid for (JudgeOutputError: the model answered, badly); book what they say they cost.
      const paid = (e as { costUsd?: unknown } | null)?.costUsd;
      if (typeof paid === "number" && paid > 0) this.spentUsd += paid;
      throw e;
    } finally {
      this.reserved -= estimateUsd;
    }
  }
}

/**
 * Same providers, every paid method behind `budget.guard`. Read-only fields (capabilities, maxSeconds) delegate, and
 * so do the estimates of video / lipsync / judge, which nodes use to ask `budget.allows` before an optional regeneration.
 */
export function withBudget(p: Providers, budget: Budget): Providers {
  const { llm, tts, asr, image, video, lipsync, talking, judge } = p;
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
      estimateUsd: (req) => video.estimateUsd?.(req) ?? 0,
    },
    lipsync: {
      name: lipsync.name,
      get maxSeconds() {
        return lipsync.maxSeconds;
      },
      sync: (req) => budget.guard(lipsync.name, lipsync.estimateUsd?.(req) ?? 0, () => lipsync.sync(req)),
      estimateUsd: (req) => lipsync.estimateUsd?.(req) ?? 0,
    },
    talking: {
      name: talking.name,
      talk: (req) => budget.guard(talking.name, talking.estimateUsd?.(req) ?? 0, () => talking.talk(req)),
    },
    judge: {
      name: judge.name,
      judgeImage: (req) =>
        budget.guard(judge.name, judge.estimateUsd?.({ images: 1 + (req.refs?.length ?? 0), rubric: req.rubric }) ?? 0, () =>
          judge.judgeImage(req),
        ),
      judgeVideo: (req) =>
        budget.guard(
          judge.name,
          judgeVideoEstimate(judge, req),
          () => judge.judgeVideo(req),
        ),
      estimateUsd: (req) => judge.estimateUsd?.(req) ?? 0,
    },
  };
}

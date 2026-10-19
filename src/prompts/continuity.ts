/**
 * Continuity critic prompt (F18): one cheap LLM read of the whole script after the code checks pass. It looks for what
 * only reading the story can find; code already checked names, speaking order, pace keywords and screen direction.
 * Bump CONTINUITY_PROMPT_VERSION on any wording change.
 */
import type { Script } from "../schemas.ts";

export const CONTINUITY_PROMPT_VERSION = "continuity-v1";

export const CONTINUITY_SYSTEM = `You are a film continuity supervisor. You read a short vertical-video script (1–4 shots, each maybe with 2–3 cuts)
and the idea it was written from, and you check that a viewer can follow it. Each shot and cut has "blocking"
(subjects with position/side/facing, movement with direction/target/pace, speaking) and each shot has "continuity"
(how it follows the previous shot, screen direction).

Report a problem only for these:
1. Contradictions between shots: a character moves away from a place the next shot is inside, or ends a shot somewhere
   the next shot does not follow from.
2. A goal not visible: a movement toward something ("runs toward the train") whose target is not in frame or has no
   position, so the viewer can't see where they are going.
3. A line over another person's face: a cut that shows someone other than the speaker facing the camera while the
   line is heard.
4. Pace that does not fit the action: slow motion nobody asked for, or a run written as a stroll.
5. A confusing first shot: in 2 seconds a viewer must understand who, where and what.

Each problem: one sentence naming the shot (and cut) and the fix. Do not comment on wording, the spoken lines, the
camera sizes or anything else. If nothing is wrong, return {"ok": true, "problems": []}.
Return only JSON: {"ok": boolean, "problems": string[]}.`;

/** The idea plus the staging-relevant fields of the script (looks and voices are not continuity). */
export function continuityPrompt(idea: string, script: Script): string {
  const shots = script.shots.map((s) => ({
    id: s.id,
    camera: s.camera,
    visual: s.visual,
    motion: s.motion,
    line: s.line,
    ...(s.speaker ? { speaker: s.speaker } : {}),
    onScreen: s.onScreen,
    blocking: s.blocking,
    continuity: s.continuity,
    ...(s.cuts ? { cuts: s.cuts } : {}),
  }));
  return `Idea:\n${idea}\n\nSetting: ${script.setting}\n\nScript shots:\n${JSON.stringify(shots, null, 2)}`;
}

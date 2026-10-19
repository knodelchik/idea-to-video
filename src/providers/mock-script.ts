/**
 * The mock script writer: a draft for any idea, read back out of the script prompt (`Idea:` block + `- "quoted line"`
 * bullets), so `pnpm make --mock` runs end to end with no canned queue. Deterministic heuristics only; it exists to
 * exercise the pipeline, not to write well.
 */
import { CUT_SHOT_MIN_SECONDS, MAX_SHOTS } from "../schemas.ts";
import { differentSpeakers, quoteSpeakers, type Attribution, type Gender } from "../speakers.ts";
import { parseStoryboard, quoteBeats, type Storyboard } from "../storyboard.ts";
import { splitDelivery, wordCount } from "../verbatim.ts";
import type { Responder } from "./mock.ts";

const spokenWords = (line: string) => wordCount(splitDelivery(line).spoken);

/** Line the mock writer uses when the idea quotes none. Plain words, no digits (passes scriptProblems). */
export const MOCK_DEFAULT_LINE = "I never stopped looking for you.";

const MOCK_CAST: Record<Gender, { name: string; look: string; tone: string }[]> = {
  female: [
    { name: "Alex", look: "a woman in her thirties with short jet-black hair, a bright red wool coat, a small scar above the left eyebrow", tone: "low and steady" },
    { name: "Rosa", look: "a woman in her fifties with silver curly hair, a mustard-yellow cardigan, thin gold reading glasses", tone: "warm and tired" },
  ],
  male: [
    { name: "Sam", look: "a man in his twenties with messy copper-red hair, a bright blue hoodie, a faint freckled nose and tired green eyes", tone: "soft and anxious" },
    { name: "Dan", look: "a man in his sixties with a short white beard, a wide black flat cap, a brown corduroy jacket with patched elbows", tone: "deep and slow" },
  ],
};

/**
 * Words that mean the place matters, so the mock picks a wide size (F12; a keyword heuristic is enough for a mock).
 * English and Ukrainian stems; the lookbehind stands in for \b, which is ASCII-only in JS.
 */
const PLACE =
  /(?<![\p{L}])(hall|ballroom|castle|palace|street|landscape|city|cliff|sea|ocean|forest|field|mountain|desert|tower|cathedral|square|bridge|зал|замк|замок|палац|вулиц|міст|пейзаж|скел|мор[ея]|ліс|гор[иа]|площ)/iu;
export const mentionsPlace = (text: string): boolean => PLACE.test(text);

/**
 * More than one quote per shot (F10): split them into `n` contiguous groups with the most even word counts, each
 * group one shot line with its quotes joined by a space. Only used for two groups, the pre-F12 behaviour.
 */
function packLines(quoted: string[]): string[] {
  if (quoted.length <= 2) return quoted;
  const w = quoted.map(spokenWords);
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  let k = 1;
  for (let i = 2; i < quoted.length; i++) {
    if (Math.max(sum(w.slice(0, i)), sum(w.slice(i))) < Math.max(sum(w.slice(0, k)), sum(w.slice(k)))) k = i;
  }
  return [quoted.slice(0, k).join(" "), quoted.slice(k).join(" ")];
}

/**
 * Who says each quote: the 0-based run of consecutive lines from one person, alternating between two people.
 * One run = one speaker; two or more = a dialogue between two characters (runs alternate A, B, A, …).
 */
function speakerRunsOf(idea: string, quoted: string[]): { run: number[]; gender: (Gender | undefined)[] } {
  let said: (Attribution | undefined)[];
  try {
    said = quoteSpeakers(idea);
  } catch {
    said = [];
  }
  if (said.length !== quoted.length) return { run: quoted.map(() => 0), gender: [] };
  const run: number[] = [];
  const gender: (Gender | undefined)[] = [];
  quoted.forEach((_, i) => {
    const r = i === 0 ? 0 : run[i - 1]! + (differentSpeakers(said[i - 1], said[i]) ? 1 : 0);
    run.push(r);
    gender[r % 2] ??= said[i]?.gender;
  });
  return { run, gender };
}

function castFor(people: number, gender: (Gender | undefined)[]) {
  const used = { female: 0, male: 0 };
  return Array.from({ length: people }, (_, i) => {
    const g: Gender = gender[i] ?? (i === 1 ? "male" : "female");
    const c = MOCK_CAST[g][used[g]++ % 2]!;
    return {
      name: c.name,
      look: c.look,
      voice: { gender: g, age: "adult" as const, tone: c.tone },
      voiceDescription: `${c.tone} ${g} voice, adult, neutral American accent, unhurried`,
    };
  });
}

/** Sized by *spoken* words (wordCount), like scriptProblems: "1987" is three words, "[whispers]" none. Plus 1 s of room. */
const secondsFor = (line: string) => Math.min(15, Math.max(5, Math.ceil(spokenWords(line) / 2.6 + 0.8) + 1));

interface MockShot {
  line: string;
  who: string;
  camera: string;
  visual: string;
  /** The idea (or this beat) names a place: a cut shot opens wide. */
  place?: boolean;
}

/**
 * Cuts for a shot of CUT_SHOT_MIN_SECONDS or more (F13, My Muse pacing): wide → medium when a place matters, else the
 * speaker → a close-up on the peak. Two cuts, never the same size twice; the first cut is the shot's own framing.
 */
function cutsFor(s: MockShot): { camera: string; cuts: { camera: string; visual: string; onScreen: string[] }[] } {
  const [first, second] = s.place
    ? ["wide shot", "medium shot"]
    : [s.camera === "close-up" ? "medium close-up" : s.camera, "close-up"];
  return {
    camera: first,
    cuts: [
      { camera: first, visual: s.visual, onScreen: [s.who] },
      { camera: second, visual: `${s.who}'s face, the emotional peak of the line`, onScreen: [s.who] },
    ],
  };
}

function toShots(shots: MockShot[]) {
  return shots.slice(0, MAX_SHOTS).map((s, i) => {
    const seconds = s.line ? secondsFor(s.line) : 4;
    const cut = seconds >= CUT_SHOT_MIN_SECONDS ? cutsFor(s) : undefined;
    const camera = cut?.camera ?? s.camera;
    return {
      id: `s${i + 1}`,
      camera,
      visual: s.visual,
      motion: /wide|full/.test(camera) ? "locked-off camera, a slow pull-back" : "slow push-in",
      emotion: s.line ? "quiet resolve" : "stillness",
      line: s.line,
      seconds,
      ...(s.line ? { speaker: s.who } : {}),
      onScreen: [s.who],
      ...(cut ? { cuts: cut.cuts } : {}),
    };
  });
}

/**
 * Storyboard (F12): one shot per beat, in order. A beat's quotes are its line (a quote in the shared context joins
 * beat 1); with no quote at all the default line goes on the last beat. Beats that name a place get a wide shot.
 */
function storyboardDraft(idea: string, board: Storyboard, quoted: string[]) {
  const { run, gender } = speakerRunsOf(idea, quoted);
  const people = Math.max(...run, 0) > 0 ? 2 : 1;
  const cast = castFor(people, gender);
  const beatOf = quoteBeats(idea, board).map((k) => Math.max(k, 0));
  const shots: MockShot[] = board.beats.map((beat, k) => {
    const mine = quoted.map((_, i) => i).filter((i) => beatOf[i] === k);
    const line = mine.map((i) => quoted[i]!).join(" ") || (quoted.length === 0 && k === board.beats.length - 1 ? MOCK_DEFAULT_LINE : "");
    const who = cast[mine.length ? run[mine[0]!]! % 2 : 0]!.name;
    const camera = mentionsPlace(beat) ? "wide shot" : line ? "medium close-up" : "medium shot";
    return { line, who, camera, visual: `${who}: ${board.context ? `${board.context} ` : ""}${beat}`, place: mentionsPlace(beat) };
  });
  return { title: "Mock storyboard", logline: idea, setting: board.context || board.beats[0]!, characters: cast, shots: toShots(shots) };
}

/**
 * One speaker: a silent 4 s establishing shot (wide when the idea names a place, else medium), then the line(s) on a
 * medium close-up. People taking turns (F11): two characters, shot-reverse-shot close-ups, one speaker per shot.
 * Every shot is long enough for its words (words / 2.6 + 0.8 s, rounded up, plus 1 s of room); voices follow the
 * idea's "she"/"he". A shot of 6 s or more gets 2 cuts (F13, see cutsFor).
 */
export const mockScriptResponder: Responder = (prompt) => {
  const idea = /Idea:\n([\s\S]*?)\n\n/.exec(prompt)?.[1]?.trim() || "a quiet moment";
  const quoted = [...prompt.matchAll(/^- (".*")$/gm)].map((m) => JSON.parse(m[1]!) as string);
  let board: Storyboard | null = null;
  try {
    board = parseStoryboard(idea);
  } catch {
    board = null; // over-long storyboards never reach the writer (pre-spend check)
  }
  if (board) return storyboardDraft(idea, board, quoted);

  const { run, gender } = speakerRunsOf(idea, quoted);
  const turns = Math.max(...run, 0) + 1;
  const cast = castFor(turns > 1 ? 2 : 1, gender);
  const visual = (who: string) => `${who} in the scene from the idea: ${idea}`;
  let shots: MockShot[];
  if (turns > 1) {
    shots = Array.from({ length: turns }, (_, r) => {
      const who = cast[r % 2]!.name;
      const line = quoted.filter((_, i) => run[i] === r).join(" ");
      return { line, who, camera: "close-up", visual: visual(who) };
    });
  } else {
    const who = cast[0]!.name;
    const lines = quoted.length ? packLines(quoted) : [MOCK_DEFAULT_LINE];
    shots =
      lines.length === 2
        ? lines.map((line, i) => ({ line, who, camera: i === 0 ? "medium shot" : "medium close-up", visual: visual(who) }))
        : [
            { line: "", who, camera: mentionsPlace(idea) ? "wide shot" : "medium shot", visual: visual(who) },
            { line: lines[0]!, who, camera: "medium close-up", visual: visual(who) },
          ];
  }
  const place = mentionsPlace(idea);
  return { title: "Mock beat", logline: idea, setting: "a dim interior at night", characters: cast, shots: toShots(shots.map((s) => ({ ...s, place }))) };
};

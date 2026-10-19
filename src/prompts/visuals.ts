/**
 * Image and video prompts. Pure, so tests can pin exactly what a model is asked for. Bump VISUALS_PROMPT_VERSION
 * on any wording change: it is part of every artifact's content key, so a changed prompt makes a new file.
 *
 * Video prompts follow the official Seedance 2.0 guide (docs/research/seedance-playbook.md, "Changes we should
 * make" 2–8): audio policy first, dialogue as `Name says in English: {line}` with nothing after the closing brace,
 * references as `@Image N (noun)` in upload order, one camera move, and the constraint tail last.
 */
import { castOf, isWide, openingCastOf, openingOf, speakerOf, type Character, type Cut, type Script, type Shot } from "../schemas.ts";
import { openingStaging, paceSentence, plain, speakingSentence, stagingSentences, type Naming } from "./staging.ts";
import { splitDelivery } from "../verbatim.ts";
import { issuesNote } from "./judge.ts";

// v3: Seedance playbook wording, 1–2 characters (F11).
// v4: shot size leads the video prompt; wide sizes show the character small and whole, recognised by its look,
//     with a heard (not lip-read) line (F12).
// v5: a shot with cuts is written as Seedance's multi-shot list "Shot 1: … Shot 2: …", the dialogue once after it;
//     the keyframe shows the first cut (F13).
// v6: the keyframe of a cut shot names only the first cut's cast (F13, human note).
// v7: blocking as plain staging sentences after the size and camera move, "Only X speaks" per cut, a pace sentence on
//     every shot, the keyframe placed by the opening blocking with the movement's goal in frame (F18).
export const VISUALS_PROMPT_VERSION = "visuals-v7";

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
/** A field as one sentence: single-spaced, ending in exactly one full stop (unless it ends in ! or ?). */
const sentence = (s: string): string => `${oneLine(s).replace(/[.\s]+$/, "")}${/[!?]$/.test(oneLine(s)) ? "" : "."}`;

/** Image and video models write gibberish: any note, sign or screen in frame must show no readable writing. */
const NO_WRITING = "Any paper, note, sign or screen in frame shows no legible writing: blank, folded, or turned away from the camera.";

const NO_MUSIC = "no music, background music, BGM, score, instrumental, melody, soundtrack, synth, ambient pad or stinger at any moment.";

/** The official headshot spec (playbook change 6). One view only: multi-view sheets make bad references. */
export const HEADSHOT =
  "Front-facing close-up framed above the shoulders, the face filling about two-thirds of the frame, neutral expression, mouth closed, plain light-grey background, even soft light. Vertical portrait.";

const characterNamed = (script: Script, name: string | undefined): Character => {
  const c = name === undefined ? script.characters[0] : script.characters.find((x) => x.name === name);
  if (!c) throw new Error(`no character named ${JSON.stringify(name)} in the script`);
  return c;
};

/** Identity anchor, one per character: every keyframe showing them is generated with it as a reference. */
export function portraitPrompt(script: Script, name?: string): string {
  const c = characterNamed(script, name);
  return [
    `Character reference portrait of ${oneLine(c.name)}: ${sentence(c.look)}`,
    HEADSHOT,
    "Photoreal, 9:16, a single photo (not a multi-view sheet), no text, no watermark.",
  ].join(" ");
}

/** A character's look without its final full stop, for use inside a sentence. */
const cues = (c: Character): string => oneLine(c.look).replace(/[.\s]+$/, "");

/**
 * Wide sizes (F12): the character is small, so identity comes from the look's high-contrast features, and the frame
 * needs a vertical reason (tall architecture, the character in the lower third).
 */
function wideFraming(cast: Character[], name: Naming): string {
  const who = cast.map((c) => `${name(c)} is small in frame, full figure visible, recognisable by ${cues(c)}`).join("; ");
  return `${who}; the place dominates, composed vertically: tall architecture or landscape fills the frame, the character small in the lower third.`;
}

/** First frame of a shot: everyone on screen, speaker first (the order of the portrait refs). Mouths closed. */
export function keyframePrompt(shot: Shot, script: Script): string {
  // With cuts (F13) the first frame is the first cut: its cast, framing and visual only.
  const cast = openingCastOf(script, shot);
  const { camera, visual } = openingOf(shot);
  const same =
    cast.length === 1
      ? "Same person as the reference image."
      : `Same people as the reference images, in order: ${cast.map((c) => oneLine(c.name)).join(", ")}.`;
  return [
    ...cast.map((c) => `${oneLine(c.name)}, ${sentence(c.look)}`),
    `Setting: ${sentence(script.setting)}`,
    `Shot: ${camera}. ${sentence(visual)}`,
    openingStaging(shot),
    `Emotion: ${sentence(shot.emotion)}`,
    same,
    isWide(camera)
      ? `${wideFraming(cast, plain)} Photoreal, cinematic, vertical 9:16, no text, no watermark.`
      : "Photoreal, cinematic, vertical 9:16, face clearly visible, mouth closed, no text, no watermark.",
    NO_WRITING,
  ]
    .filter(Boolean)
    .join(" ");
}

export interface VideoPromptOpts {
  /** Judge issues from the previous take; they go before the constraint tail, which stays last. */
  issues?: string[];
}


const isSpoken = (shot: Shot): boolean => splitDelivery(shot.line).spoken !== "";

function audioPolicy(shot: Shot, script: Script): string {
  return isSpoken(shot)
    ? `Audio policy: only ${oneLine(speakerOf(script, shot).name)}'s spoken line plus quiet natural room tone; ${NO_MUSIC}`
    : `Audio policy: no speech, only quiet natural room tone; ${NO_MUSIC}`;
}

function constraintTail(shot: Shot, script: Script): string {
  const cast = castOf(script, shot);
  const only = cast.map((c) => `one ${oneLine(c.name)}`).join(" and ");
  return [
    isSpoken(shot)
      ? "Generate audio strictly according to the dialogue; do not add or remove any words; one speaker only; clean, clear, standard pronunciation. No music of any kind."
      : "No speech and no music of any kind.",
    `${cast.length === 1 ? "The character's face remains" : "Each character's face remains"} stable and consistent throughout, without deformation; hands anatomically correct; natural, smooth movement.`,
    `Only ${only} in frame; no duplicate or twin.`,
    "Avoid generating subtitles, captions, a logo or a watermark.",
  ].join(" ");
}

/**
 * The shot itself. The spoken line goes in braces exactly as written, with the delivery *before* it and nothing after
 * the closing brace in that sentence: the guide says text attached after a line can trigger burned-in subtitles.
 * Delivery tags ("[whispers]") and emoji are not words, so they leave the braces (tags join the delivery).
 */
function body(shot: Shot, script: Script, name: Naming): string[] {
  if (shot.cuts?.length) return cutBody(shot, shot.cuts, script, name);
  const { spoken, tags, emoji } = splitDelivery(shot.line);
  const delivery = [oneLine(shot.emotion), ...tags].filter(Boolean).join(", ");
  const wide = isWide(shot.camera);
  // Order (F12, Seedance guides): shot size, one camera move, subject, action, then audio.
  const size = `Shot size: ${shot.camera}.`;
  const camera = wide
    ? "Locked-off camera, or one slow crane up or pull-back; no other camera move."
    : "Locked-off camera with at most a slow push-in.";
  const cast = castOf(script, shot);
  const subject = wide ? [wideFraming(cast, name)] : [];
  const action = `${sentence(shot.visual)} ${sentence(shot.motion)}`;
  // F18: staging after the size and the camera move, then the pace, so direction and goal are explicit.
  const staging = [...stagingSentences(shot.blocking, script, name), paceSentence(shot)];
  if (spoken === "") {
    const who = cast.map(name).join(" and ");
    return [size, camera, ...subject, action, ...staging, `Emotion: ${delivery}. ${who} ${cast.length === 1 ? "is" : "are"} silent, mouth closed.`, NO_WRITING];
  }
  const [speaker, ...listeners] = cast;
  // Emoji are not words either: a model asked to "say" 🚀 may improvise one (F10).
  const said = tags.length || emoji ? spoken : shot.line;
  // Blocking may turn the speaker away (seen from behind); then "looks toward the camera" would contradict it.
  const faces = shot.blocking.subjects.find((s) => s.name === speaker!.name)?.facing ?? "camera";
  // Wide: the line is heard, not lip-read, so no "looks toward the camera"; the delivery gets its own sentence so
  // the dialogue sentence stays `Name, small in frame, says in English: {line}`.
  const line = wide
    ? `Delivery: ${delivery}. ${name(speaker!)}, small in frame, says in English: {${said}}`
    : faces === "camera"
      ? `${name(speaker!)} looks toward the camera and, ${delivery}, says in English: {${said}}`
      : `Delivery: ${delivery}. ${name(speaker!)} says in English: {${said}}`;
  return [
    size,
    camera,
    ...subject,
    action,
    ...staging,
    ...listeners.map((c) => `${name(c)} listens in silence, mouth closed.`),
    `Voice: ${sentence(speaker!.voiceDescription)}`,
    line,
    NO_WRITING,
  ];
}

/** One camera move per cut, from its size (the same rule as a single shot: wide holds still, close pushes in). */
const cutMove = (c: Cut): string => (isWide(c.camera) ? "locked-off camera" : "slow push-in");

/** Who a cut shows, each with their identity cues (every cut, so the face stays the same across the cuts). */
function cutCast(c: Cut, script: Script, name: Naming): string {
  const cast = c.onScreen
    .map((n) => script.characters.find((x) => x.name === n))
    .filter((x): x is Character => x !== undefined);
  if (cast.length === 0) return "";
  const who = cast.map((x) => (isWide(c.camera) ? `${name(x)} small in frame, recognisable by ${cues(x)}` : `${name(x)} (${cues(x)})`));
  return ` On screen: ${who.join("; ")}.`;
}

/**
 * A shot with cuts (F13), Seedance's multi-shot form: `Shot 1: <size>, <move>, <visual>. <staging> Only X speaks; …`
 * per cut (F18), then the dialogue sentence once, after the list. When some cuts don't hold the line, the prompt says
 * which cuts do and that the line has ended before the others (reaction cuts come after the line, never over it).
 */
function cutBody(shot: Shot, cuts: Cut[], script: Script, name: Naming): string[] {
  const { spoken, tags, emoji } = splitDelivery(shot.line);
  const delivery = [oneLine(shot.emotion), ...tags].filter(Boolean).join(", ");
  const list = cuts.map((c, i) =>
    [
      `Shot ${i + 1}: ${c.camera}, ${cutMove(c)}, ${oneLine(c.visual).replace(/[.\s]+$/, "")}.${cutCast(c, script, name)}`,
      ...stagingSentences(c.blocking, script, name),
      ...(c.blocking.subjects.length ? [speakingSentence(c.blocking, script, name)] : []),
    ].join(" "),
  );
  const intro = `${cuts.length} cuts in one continuous scene, same place, light and wardrobe, hard cuts between them.`;
  if (spoken === "") {
    return [intro, ...list, paceSentence(shot), `Emotion: ${delivery}. Nobody speaks; mouths closed.`, NO_WRITING];
  }
  const speaker = speakerOf(script, shot);
  // Which cuts hold the line (F18): reactions (people, nobody speaking) come after it; inserts show no face, so the
  // line may run over them.
  const nums = (pick: (c: Cut) => boolean) => cuts.map((c, i) => (pick(c) ? i + 1 : 0)).filter((i) => i > 0);
  const holding = nums((c) => c.blocking.speaking === speaker.name);
  const reactions = nums((c) => c.blocking.speaking !== speaker.name && c.onScreen.length > 0);
  const inserts = nums((c) => c.blocking.speaking !== speaker.name && c.onScreen.length === 0);
  const when = [
    ...(holding.length && reactions.length ? [`the line is spoken in shot ${holding.join(" and ")} and has ended before shot ${reactions.join(" and ")}`] : []),
    ...(inserts.length ? [`the line continues over the insert in shot ${inserts.join(" and ")}`] : []),
  ]
    .map((x) => `; ${x}`)
    .join("");
  const said = tags.length || emoji ? spoken : shot.line;
  return [
    intro,
    ...list,
    paceSentence(shot),
    `Voice: ${sentence(speaker.voiceDescription)}`,
    `Delivery: ${delivery}${when}. ${name(speaker)} says in English: {${said}}`,
    NO_WRITING,
  ];
}

const assemble = (parts: string[]): string => parts.filter(Boolean).join(" ");

/** Image-to-video prompt (the keyframe is the first frame). */
export function talkingPrompt(shot: Shot, script: Script, opts: VideoPromptOpts = {}): string {
  return assemble([audioPolicy(shot, script), ...body(shot, script, plain), issuesNote(opts.issues ?? []), constraintTail(shot, script)]);
}

export interface TextToVideoOpts extends VideoPromptOpts {
  /**
   * What each reference image is, in upload order: character names (their portraits), then "opening frame" for the
   * keyframe. Absent or empty: no images, the text is all the model gets.
   */
  refs?: string[];
}

/** Label of the keyframe among the references. */
export const OPENING_FRAME = "opening frame";

/**
 * Prompt without a first frame, for when the provider refuses the keyframe (real-face filter). With `refs` the images
 * are references in the official `@Image N (noun)` form, numbered by upload order: portraits (speaker first) for
 * identity, the keyframe for the scene. Without a first frame the look and the setting lead either way.
 */
export function textToVideoPrompt(shot: Shot, script: Script, opts: TextToVideoOpts = {}): string {
  const refs = opts.refs ?? [];
  const tag = (label: string): string => `@Image ${refs.indexOf(label) + 1} (${label})`;
  const name: Naming = (c) => (refs.includes(c.name) ? tag(c.name) : plain(c));
  const cast = castOf(script, shot);
  const portraits = refs.filter((r) => r !== OPENING_FRAME);
  const refLines = [
    ...portraits.map((n) => `${tag(n)} is the face reference for ${n}: keep ${n}'s facial features, hair and outfit from ${tag(n)} exactly.`),
    ...(refs.includes(OPENING_FRAME)
      ? [
          portraits.length
            ? `${tag(OPENING_FRAME)} is the first-frame constraint: start from this composition, setting and outfit.`
            : `${tag(OPENING_FRAME)} shows ${cast.map(plain).join(" and ")} in the scene: keep exactly these faces, hair, outfits and framing.`,
        ]
      : []),
  ];
  return assemble([
    audioPolicy(shot, script),
    `Photoreal vertical 9:16 ${shot.camera} of ${cast.map((c) => `${oneLine(c.name)}, ${oneLine(c.look).replace(/[.\s]+$/, "")}`).join("; with ")}.`,
    `Setting: ${sentence(script.setting)}`,
    ...refLines,
    ...body(shot, script, name),
    issuesNote(opts.issues ?? []),
    constraintTail(shot, script),
  ]);
}

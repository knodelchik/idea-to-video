/**
 * Who says each quoted line, read from the idea's own words ("She says: "…" He looks up and asks: "…""). Code, not
 * the model, so a script that hands both lines to one person (who then calls herself "Mom") is caught (F11).
 *
 * Deliberately conservative: a pronoun and a noun ("the mother" … "she") may be the same person, so they only count
 * as different speakers when their genders differ. A quote with no speech verb before it takes its trailing tag
 * (""…," she says."), else inherits the previous quote's speaker ("He asks "…", then "…""); the first such quote has
 * none.
 */
import { quoteSpans } from "./verbatim.ts";

export type Gender = "female" | "male";

export interface Attribution {
  /** "she", "he", or the noun phrase that speaks ("her son", "the detective"), lowercased. */
  who: string;
  gender?: Gender;
  pronoun: boolean;
}

const VERB =
  /\b(?:says?|said|asks?|asked|answers?|answered|repl(?:y|ies|ied)|whispers?|whispered|shouts?|shouted|calls?|called|announces?|announced|sighs?|sighed|mutters?|muttered|murmurs?|murmured|yells?|yelled|tells?|told|adds?|added|responds?|responded|snaps?|snapped|exclaims?|exclaimed|cries|cried|speaks?|spoke|reads?|blurts?(?: out)?|insists?|insisted|begs?|begged|pleads?|pleaded)\b/gi;

const FEMALE = new Set(
  "she woman girl mother mom mum mama wife daughter sister grandmother grandma granny aunt bride widow queen lady waitress actress niece".split(" "),
);
const MALE = new Set("he man boy father dad papa husband son brother grandfather grandpa uncle groom widower king gentleman nephew".split(" "));
const SKIP = new Set("a an the his her their my our its this that".split(" "));
// Leading adverbs/connectives are not speakers: "Then the suspect answers" is the suspect.
const CONNECTIVE = new Set("then and but so finally now suddenly later quietly softly gently slowly again also still at last".split(" "));
const BREAK = /[.!?;]/;
// A leading subordinate clause up to its comma names a scene, not the speaker: in "As she opens the door, her husband
// asks" the husband speaks. Optional connectives may come first ("Then, while he cooks, the mother says").
const LEADING_SUBORDINATE = new RegExp(
  `^\\s*(?:(?:${[...CONNECTIVE].join("|")})\\b[\\s,]*)*(?:as|when|whenever|while|after|before|once|if|until|since|because|though|although|as soon as)\\b[^,]*,`,
  "i",
);

// A storyboard beat marker before the clause ("Shot 2:", "Кадр 2 —", "2.") is not a speaker (F12; live 2026-10-19:
// "Shot 2: … an old king … says" was read as the speaker "shot").
const BEAT_MARKER = /^\s*(?:(?:shot|scene|кадр)\s*\d+|\d+\s*кадр|\d+\s*[.)])\s*[:.)—–-]?\s*/i;
// A clause may open on where it happens ("In a candlelit throne room an old king … says"): the speaker comes later.
const PREPOSITION = new Set("in at on inside outside by near under across through from into onto within beside behind above below over".split(" "));
const OWNER = new Set("her his their my our its your".split(" "));

const genderOf = (word: string): Gender | undefined => (FEMALE.has(word) ? "female" : MALE.has(word) ? "male" : undefined);
const isPossessive = (t: string): boolean => /'s?$/.test(t);

/** The speaker named in a clause that owns a speech verb, or undefined when it names nobody. */
function subjectOf(clause: string): Attribution | undefined {
  // No comma, no strip: "When she finally speaks" keeps its she.
  const tokens = clause
    .replace(BEAT_MARKER, "")
    .replace(LEADING_SUBORDINATE, "")
    .replace(/[‘’]/g, "'")
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}]+|[^\p{L}'-]+$/gu, ""))
    .filter(Boolean);
  // A she/he anywhere in the clause is its subject ("Then she adds", "Finally, he whispers"); him/her are objects.
  const pronoun = tokens.findLast((t) => t === "she" || t === "he");
  if (pronoun) return { who: pronoun, gender: genderOf(pronoun)!, pronoun: true };
  const start = tokens.findIndex((t) => !CONNECTIVE.has(t));
  if (start < 0) return undefined;
  // Only the subject's own words: "A teenager hugs her dad and says" must not make the speaker male. A possessive
  // only modifies the subject: "The bride's father" is the father, not the bride.
  const head = tokens.slice(start, start + 3).filter((t) => !isPossessive(t));
  const noun = head.find((t) => genderOf(t) !== undefined);
  if (noun) return { who: noun, gender: genderOf(noun)!, pronoun: false };
  // ("at" is also in CONNECTIVE, for "at last", so look at the token before `start` too.)
  if (PREPOSITION.has(tokens[start]!) || PREPOSITION.has(tokens[start - 1] ?? "")) {
    // Past a leading place phrase the speaker is a gendered noun: the first one nobody owns ("an old king"), else the
    // first at all ("In the kitchen her mother says"). A possessive only modifies ("the bride's father").
    const gendered = tokens.map((t, k) => ({ t, k })).filter(({ t, k }) => k >= start && genderOf(t) !== undefined && !isPossessive(tokens[k - 1] ?? ""));
    const pick = gendered.find(({ k }) => !OWNER.has(tokens[k - 1] ?? "")) ?? gendered[0];
    if (pick) return { who: pick.t, gender: genderOf(pick.t)!, pronoun: false };
    return undefined; // a place, not a person: "In the hall says" names nobody
  }
  const word = head.find((t) => !SKIP.has(t) && !CONNECTIVE.has(t));
  return word ? { who: word, pronoun: false } : undefined;
}

/** The speaker of the last speech verb in the lead-in before a quote ("He looks up and asks: "). */
function leadSpeaker(segment: string): Attribution | undefined {
  const verb = [...segment.matchAll(VERB)].at(-1);
  if (!verb) return undefined;
  // The clause that owns the verb starts after the last sentence break before it.
  const before = segment.slice(0, verb.index);
  const breakAt = Math.max(...[".", "!", "?", ";"].map((c) => before.lastIndexOf(c)));
  return subjectOf(before.slice(breakAt + 1));
}

/**
 * A speech tag right after a quote: `"…," she says.`, `"…?" asks her son.`, `"…!" the detective snaps.` It must
 * continue the quote's sentence (starts with a comma/dash or a lowercase word) and reach its verb before any
 * sentence break; a capitalised new sentence is the next quote's lead-in instead. Returns where the tag ends, so the
 * text it used is not read again as the next quote's lead-in.
 */
function tagSpeaker(after: string): { who: Attribution; end: number } | undefined {
  if (!/^\s*(?:[,—–-]|\p{Ll})/u.test(after)) return undefined;
  const verb = new RegExp(VERB.source, "i").exec(after);
  if (!verb || BREAK.test(after.slice(0, verb.index))) return undefined;
  const verbEnd = verb.index + verb[0].length;
  const before = after.slice(0, verb.index);
  if (/\p{L}/u.test(before)) {
    const who = subjectOf(before);
    return who ? { who, end: verbEnd } : undefined;
  }
  // Inverted tag: `"…," says the mother.` The subject follows the verb, up to the next punctuation.
  const rest = after.slice(verbEnd);
  const stop = rest.search(/[.,!?;:—]/);
  const subjectText = stop < 0 ? rest : rest.slice(0, stop);
  const who = subjectOf(subjectText);
  return who ? { who, end: verbEnd + subjectText.length } : undefined;
}

/**
 * One attribution per quoted line (aligned with extractQuotedLines); throws QuoteError like it does. A quote's
 * speaker is its lead-in ("She says: "…""), else its trailing tag (""…," she says."), else the previous quote's.
 */
export function quoteSpeakers(idea: string): (Attribution | undefined)[] {
  const spans = quoteSpans(idea);
  const out: (Attribution | undefined)[] = [];
  let leadStart = 0;
  let current: Attribution | undefined;
  spans.forEach((q, i) => {
    let found = leadSpeaker(idea.slice(leadStart, q.start));
    leadStart = q.end;
    // A quote with its own lead-in keeps it; the text after it then all belongs to the next quote's lead-in
    // (`She says: "Hi," and he replies: "Bye."`).
    if (!found) {
      const tag = tagSpeaker(idea.slice(q.end, spans[i + 1]?.start ?? idea.length));
      if (tag) {
        found = tag.who;
        leadStart = q.end + tag.end;
      }
    }
    if (found) current = found;
    out.push(current);
  });
  return out;
}

/** Two attributions that cannot be the same person. Unknown or pronoun-vs-noun of one gender: maybe the same. */
export function differentSpeakers(a: Attribution | undefined, b: Attribution | undefined): boolean {
  if (!a || !b) return false;
  if (a.gender && b.gender && a.gender !== b.gender) return true;
  if (a.pronoun || b.pronoun) return false;
  return a.who !== b.who;
}

/** How many speaker changes the quotes need, in order: each run of one speaker's lines can share a shot. */
export function speakerRuns(attributions: (Attribution | undefined)[]): number {
  if (attributions.length === 0) return 0;
  let runs = 1;
  for (let i = 1; i < attributions.length; i++) if (differentSpeakers(attributions[i - 1], attributions[i])) runs++;
  return runs;
}

import { describe, expect, it } from "vitest";
import { IdeaRejectedError, writeScript } from "../src/nodes/script.ts";
import { MockLlm, mockScriptResponder } from "../src/providers/index.ts";
import { parseStoryboard, quoteBeats, StoryboardError, TOO_MANY_BEATS } from "../src/storyboard.ts";

export const CASTLE =
  '1 кадр: маленька дівчина в червоному плащі відчиняє величезні двері старого замку. 2 кадр: вона заходить у величезну бальну залу, зала видна вся, дівчина маленька на її фоні, і каже: "Hello? Is anyone still here?"';

describe("parseStoryboard (F12)", () => {
  it("splits the Ukrainian castle storyboard into 2 beats", () => {
    const b = parseStoryboard(CASTLE)!;
    expect(b.beats).toHaveLength(2);
    expect(b.beats[0]).toBe("маленька дівчина в червоному плащі відчиняє величезні двері старого замку.");
    expect(b.beats[1]).toMatch(/^вона заходить у величезну бальну залу/);
    expect(b.beats[1]).toContain('"Hello? Is anyone still here?"');
    expect(b.context).toBe("");
  });

  it("accepts the other Ukrainian marker forms", () => {
    expect(parseStoryboard("Кадр 1: дівчина біля вікна. Кадр 2: вона відкриває лист.")!.beats).toEqual([
      "дівчина біля вікна.",
      "вона відкриває лист.",
    ]);
    expect(parseStoryboard("кадр 1 дівчина біля вікна\nкадр 2 вона відкриває лист")!.beats).toHaveLength(2);
  });

  it("splits Shot 1: … Shot 2: … Shot 3: … into 3 beats, case-insensitive", () => {
    const b = parseStoryboard("Shot 1: a knight rides to the gate. shot 2: he knocks twice. SHOT 3 the gate opens.")!;
    expect(b.beats).toEqual(["a knight rides to the gate.", "he knocks twice.", "the gate opens."]);
  });

  it("splits 1. … 2. … and 1) … 2) …, keeping text before beat 1 as shared context", () => {
    const b = parseStoryboard("A rainy night in Kyiv.\n1. A girl waits at a tram stop.\n2. The tram arrives empty.")!;
    expect(b.beats).toEqual(["A girl waits at a tram stop.", "The tram arrives empty."]);
    expect(b.context).toBe("A rainy night in Kyiv.");
    expect(parseStoryboard("1) He opens the door. 2) He sees the sea.")!.beats).toHaveLength(2);
  });

  it("is null for ordinary numbers", () => {
    expect(parseStoryboard("At 3:15 a.m. in 1987 she buys 2 coffees for $4.50")).toBeNull();
    expect(parseStoryboard("He has 2 dogs. 3 cats sleep on the sofa.")).toBeNull();
    expect(parseStoryboard("A screenshot 1 of 2 shows the alarm.")).toBeNull();
  });

  it("is null for a single beat", () => {
    expect(parseStoryboard("Shot 1: a man on a rooftop calls his brother.")).toBeNull();
    expect(parseStoryboard("1. A man on a rooftop.")).toBeNull();
  });

  it("is null when numbers skip or repeat", () => {
    expect(parseStoryboard("1. A man on a roof. 3. He jumps.")).toBeNull();
    expect(parseStoryboard("Shot 1: roof. Shot 1: street.")).toBeNull();
    expect(parseStoryboard("Shot 2: roof. Shot 3: street.")).toBeNull();
  });

  it("is null for numbers inside a quoted line", () => {
    expect(parseStoryboard('A coach shouts: "1. Run. 2. Breathe. 3. Win."')).toBeNull();
    expect(parseStoryboard('She reads the list aloud: "Shot 1: the hall. Shot 2: the stairs."')).toBeNull();
  });

  it("throws for more than 4 beats", () => {
    const five = "1. a. 2. b. 3. c. 4. d. 5. e.";
    expect(() => parseStoryboard(five)).toThrow(StoryboardError);
    expect(() => parseStoryboard(five)).toThrow(TOO_MANY_BEATS);
    expect(parseStoryboard("1. a. 2. b. 3. c. 4. d.")!.beats).toHaveLength(4);
  });

  it("places each quote in its beat", () => {
    const idea = 'Shot 1: she says "Hi." Shot 2: he says "Bye." Shot 3: silence.';
    expect(quoteBeats(idea, parseStoryboard(idea)!)).toEqual([0, 1]);
    expect(quoteBeats(CASTLE, parseStoryboard(CASTLE)!)).toEqual([1]);
    // A beat may end on a closing quote with no full stop after it.
    const bare = 'Shot 1: she says "Hi there" Shot 2: he says “Bye now” Shot 3: silence';
    expect(parseStoryboard(bare)!.beats).toEqual(['she says "Hi there"', "he says “Bye now”", "silence"]);
  });

  it("rejects 5 beats before any paid call", async () => {
    const llm = new MockLlm({ responder: mockScriptResponder });
    const idea = 'Shot 1: a door. Shot 2: a hall. Shot 3: a stair. Shot 4: a tower. Shot 5: she says "Hello?"';
    const err = await writeScript(idea, { llm }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdeaRejectedError);
    expect((err as Error).message).toContain(TOO_MANY_BEATS);
    expect(llm.calls).toHaveLength(0);
  });
});

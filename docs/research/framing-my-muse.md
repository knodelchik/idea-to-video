# Framing: My Muse and Seedance 2.0 shot sizes (2026-10-19)

- My Muse (HOLYWATER): an AI platform for vertical micro-series, audiobooks and interactive stories. Genres: fantasy, romance, mystery.
  Pipeline: AI script/storyboard → images/animation → human voiceover and sound. VERIFIED: dev.ua 2025-03-20; tech.eu 2025-06-27;
  holywater.tech/llm-info. No public text describes their shot grammar. Their one public sample ("Queen of Hearts", YouTube,
  unlisted) is blocked by a copyright claim.
- App Store "My Muse: Audiobooks & Stories" (id6738098034) is published by Zereli Limited; titles include "The Princess of Ash".
  The link to HOLYWATER is only through dev.ua, so UNCERTAIN.
- Seedance 2.0 (Runway guide, 2026-09-24): use standard shot-size words; one camera move per shot; `{}` marks dialogue;
  give characters 2–3 stable static features; a headshot plus a full-body reference works better than a multi-view sheet.
- Speech on wide shots (Cutout.pro, 2026-04-08): "Wide shots reduce face resolution, making lip movements imprecise".
  Lines over ~8 s get mushier. → On a wide shot the line is heard, not lip-read; the fallback is a voiceover, not lip-sync.
- 9:16 (Kapwing, Adam Sebire): a wide shot needs a vertical reason (tall architecture, the character small in the lower third);
  no fast lateral pans.

## A real My Muse episode (screen recording, 70 s of "First Chosen By The Dragon", ep. 1, my-muse.ai, 2026-10-19)
Measured from a local recording; the recording itself is not stored in the repo.
- **Cutting pace:** 27 cuts in 70 s, so a shot lasts about 2.5 s on average (range 0.4–7 s). Lines often run across a cut
  ("always lost in your daydreams, / you'd actually accomplish something.").
- **Shot sizes (≈30 shots):**
  - about half are medium or medium-full shots, often with 2–3 people in frame;
  - about 6 close-ups, saved for emotional beats (a scream, tears, shock);
  - a few wide shots: a vaulted hall with the figures small, a doorway;
  - over-the-shoulder shots and inserts (a hand with a dragon figurine).
- **Speech is often off-screen:** a line carries on over a reaction shot, an insert or a back view. Lips are not always
  visible.
- **Burned-in subtitles in every shot:** white, bold, lower third, 2–6 words at a time.
- **Look:** photoreal; warm candlelight interiors against blue-dusk exteriors.
- **Identity:** one strong cue per character, held across every shot: white braid, red hair, grey beard with a black
  cloak, matching leather outfits.
- **What this means for us:**
  1. Cut faster: several cuts inside one 4–15 s Seedance clip (multi-shot prompt), or shorter shots.
  2. Burn in subtitles of the verified line, timed by ASR word timestamps; never Seedance's own subtitles.
  3. Allow the line over a reaction or wide shot (F12).
  4. Lead with medium shots and keep close-ups for the emotional peak.

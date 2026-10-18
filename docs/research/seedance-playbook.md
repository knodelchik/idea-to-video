# Seedance 2.0 playbook (research snapshot, 2026-10-19)

How to prompt and call Seedance 2.0 for our pipeline: idea → 1–2 talking shots, 9:16, one exact spoken line, native audio.

Labels: **VERIFIED** means an official source (BytePlus ModelArk docs, the official `sd2-pe` skill, OpenRouter docs or live API, fal model page), read on 2026-10-19. **REPORTED** means a practitioner or reseller write-up. **UNCERTAIN** means my inference, or sources that disagree. Dates are the page's own "last updated" or publish date where it has one.

The BytePlus doc pages render their text from JS, so WebFetch sees an empty page. I pulled them with `curl` and parsed the embedded document JSON. To re-check a page, open it in a browser, not a fetch tool.

Primary sources:
- [S1] BytePlus, *Dreamina Seedance 2.0 series prompt guide*, https://docs.byteplus.com/en/docs/modelark/seedance-2-0-prompt-guide (last updated 2026-09-28)
- [S2] BytePlus, *Dreamina Seedance 2.0 series tutorial*, https://docs.byteplus.com/en/docs/modelark/seedance-2-0 (2026-09-29)
- [S3] BytePlus, *Create portrait videos with Dreamina Seedance models*, https://docs.byteplus.com/en/docs/modelark/seedance-portrait-asset-guide (2026-10-08)
- [S4] BytePlus, *Video generation tutorial* (limits, retention, rate limits, cropping), https://docs.byteplus.com/en/docs/modelark/video-generation-tutorial
- [S5] BytePlus, *Dreamina Seedance 2.5 prompt guide*, https://docs.byteplus.com/en/docs/modelark/seedance-2-5-prompt-guide, and *2.5 tutorial*, https://docs.byteplus.com/en/docs/modelark/seedance-2-5. These are for 2.5; I apply them to 2.0 only where marked.
- [S6] BytePlus, *Add real-human assets to asset library*, https://docs.byteplus.com/en/docs/ModelArk/2315856 (2026-10-13), and *Digital character library*, https://docs.byteplus.com/en/docs/modelark/avatar-library (2026-10-13)
- [S7] Official prompt-optimizer skill `sd2-pe` v0.1.0, listed at https://arkdocs-en.tos-ap-southeast-1.volces.com/skills/.well-known/agent-skills/index.json (zip sha256 `b5fb0455…6ad3`, matches the index)
- [S8] OpenRouter, *Video generation guide*, https://openrouter.ai/docs/guides/overview/multimodal/video-generation.md, and the live `GET https://openrouter.ai/api/v1/videos/models` plus `/api/v1/models/bytedance/seedance-2.0/endpoints` (queried 2026-10-19)
- [S9] fal, *Seedance 2.0 reference-to-video API*, https://fal.ai/models/bytedance/seedance-2.0/reference-to-video/api, and *Seedance 2.0 Prompting Guide*, https://fal.ai/learn/tools/seedance-2-0-prompting-guide (2026-06-18)

---

## 1. Prompting: structure, dialogue, references, shots, negatives

### Structure
- **Recommended shape.** Asset mapping first, then a shot-by-shot storyboard, then quality, style and constraint words. Each shot covers camera movement or transition, subject action and expression, position or space, and audio. **VERIFIED** [S1]. The `sd2-pe` skill asks for three sections: global settings with asset mapping, a time-slice storyboard, and quality/constraints with "anti-distortion" fallbacks. **VERIFIED** [S7]
- **Shot labels.** Use `Shot 1:`, `Shot 2:` in order. Don't force exact timings: "support for precise timing (such as 0–3 seconds) is unstable", and forcing durations "may lead to abnormal generation results". **VERIFIED** [S1, for 2.0]. Seedance 2.5 does accept timestamps in 1 s units [S5]. Cuts inside one generation are written as shot labels or "cut to". **VERIFIED** [S1][S9]
- **Camera.** Use only one camera movement per shot. Push, pull, pan and move together "increase image instability". **VERIFIED** [S1][S7]
- **Action.** Describe body parts, plus range, speed and force. Prefer slow, small, continuous movements. Show emotion through physical behaviour, e.g. joy is "the corners of the mouth rising… brows and eyes relaxing". **VERIFIED** [S1]
- **Keep it short.** "Do not directly use the complete script as the prompt. Overly redundant copy can easily cause confusion." **VERIFIED** [S1]
- **Prompt length.** No hard character limit is documented for 2.0. **UNCERTAIN**

### Dialogue: the official syntax is curly braces
- [S1] has a "Special character standards" table, and the 2.5 tutorial repeats it [S5]. **VERIFIED**:

  | Information | Symbol | Official example |
  |---|---|---|
  | Dialogue | `{}` | `{Hello, world}` |
  | Sound effect | `<>` | `< dog barking can be heard in the distance >` |
  | Music | `（）` (full-width parens; the 2.5 tutorial writes `()`) | `（fast-paced rock music is playing in the background）` |
  | Subtitles / on-screen text | `【】` | `【Chapter One: Departure】` |

- **Speaker attribution.** Write `<Name> says: {line}`, with a delivery note after it if needed. Official examples: `Qin Xiulian says: {一张去大城的票。}`, `Wang Qiang says: {比开业那天还多。}` and `Qin Xiulian (V.O.) says: {…}` for voice-over, where the lips stay closed. **VERIFIED** [S5]. The 2.0 examples also use plain quotes (`says: '…'`, `asks {How did the exam go? Did you pass?}`), so quotes work too. Braces are the documented convention. **VERIFIED** [S1][S3]
- **Language tag.** "If the dialogue is in a less common language (neither Chinese nor English), the language must be marked, such as: says in Japanese {こんにちは}." **VERIFIED** [S1]. English needs no tag, but don't mix languages in a line ("mixing Chinese and English should be avoided, except for proper nouns"). **VERIFIED** [S1]
- **Repeating or annotating the line can cause burned-in subtitles.** "Avoid repeating dialogue words after a line or attaching separate tone, facial-expression, or action instructions to specific words. These descriptions can trigger subtitle generation." **VERIFIED for 2.5** [S5]. The 2.5 guide says subtitles were worse on 2.0, so this almost certainly applies to us. **UNCERTAIN** (inference)
- **Line length.** Keep lines short and split long speeches across shots. Long monologues drift out of sync. **REPORTED**: fal [S9], 2026-06-18; CrePal, https://crepal.ai/blog/aivideo/blog-seedance-2-0-lip-sync-voiceover-fix/, 2026-02-15, which puts sync at "about 7/10" natural for short declaratives.
- **Wording that suppresses extra words.** The official 2.5 constraint is: "Generate audio strictly according to the dialogue; do not add or remove any lines. Voices must be clean and noise-free, with clear, standard pronunciation." Official exclusions: "dialogue from the wrong character, multiple people speaking simultaneously, repeated or missing lines, lip-sync errors". **VERIFIED for 2.5** [S5], **UNCERTAIN** for 2.0.

### Referring to reference images
- **Official form:** `Image N` / `@Image N` (with a space), `Video N`, `Audio N`. N is the asset's order **among assets of the same type** in the request, starting at 1. **VERIFIED** [S1][S3][S5][S7]
  - Bind a subject on every mention: `Zhang San@Image 1`. Or define a label once ("Define the woman wearing a red dress… in Image 1 as Zhang Hong") and reuse the label. **VERIFIED** [S1]
  - `sd2-pe` asks for a noun right after every tag: "`@Image 1 (Lee) stands up…`", not "`@Image 1 runs…`". The tag and a following number or verb can be mis-segmented and produce the wrong number of people. **VERIFIED** [S7]
  - Never put an asset ID in the prompt text. "Correct usage: The beauty influencer in Image 1. Incorrect usage: asset-2026* is a beauty influencer." **VERIFIED** [S3]
- **fal** documents `@Image1`, `@Video1`, `@Audio1` with no space. **VERIFIED** [S9]. BytePlus examples use both `@Image 1` and `Image 1`. Spacing appears not to matter. **UNCERTAIN**
- **Our current wording**, "Reference image 1 is …", is understandable, but it is not the documented form. **UNCERTAIN** whether it costs us anything.

### Negatives
- There is no `negative_prompt` field on BytePlus or OpenRouter for Seedance. OpenRouter passthrough for `seedance-2.0` is only `watermark` and `req_key`. **VERIFIED** [S8]
- **In-prompt constraints.** The official template is "Avoid generating subtitles, Avoid generating a Logo, Avoid generating a watermark". **VERIFIED** [S1]. Seedance 2.5 says to prefer positive descriptions, with negatives supported for subtitles and audio ("no subtitles", "no BGM"). **VERIFIED** [S5]
- **Twin or duplicate character.** Official fixed constraint: "Throughout the video, characters with completely identical appearance, clothing, and accessories are prohibited. Do not generate duplicate avatars or a twin effect." **VERIFIED** [S1]

---

## 2. The real-face / privacy filter

- **Official rule.** "Seedance 2.0 series models do not support direct uploads of reference images or videos containing real human faces." The rule covers **reference images and first frames alike**. **VERIFIED** [S2][S4]. Error code: `InputImageSensitiveContentDetected.PrivacyInformation`, HTTP 400 "input image may contain a real person". **REPORTED** (laozhang.ai, Segmind 2026-04-19, https://blog.segmind.com/seedance-2-0-error-guide-every-error-explained-with-fixes/). The classifier also flags photoreal AI faces. That matches our 2026-10-18 test.
- **Our portrait was accepted as `input_references` but refused as `first_frame`.** That is not documented behaviour. The docs say references with real faces are refused too. Treat the acceptance as classifier luck or a threshold difference, and don't rely on it. **UNCERTAIN**
- **The filter sits upstream at ByteDance.** OpenRouter's only provider for `bytedance/seedance-2.0` is "Seed" (ByteDance), so we get the same filter. **VERIFIED** [S8, endpoints API]. The same applies on fal and other resellers. **REPORTED**: apiyi docs, Adobe community thread.

**The three official legitimate paths** [S3], **VERIFIED**:

1. **Trusted model outputs (the key finding).** On the **same ModelArk account**, these original outputs can be used as Seedance 2.0/2.5 inputs "without triggering input moderation blocking", for 30 days:
   - Face-containing images from **Seedream 5.0 lite/pro/flash text-to-image**, generated from 2026-04-16 on.
   - Face-containing videos from Seedance 2.0/2.5, from 2026-03-11 on.
   - Last-frame images of those videos, from 2026-04-16 on.

   Caveats, all **VERIFIED** [S3]:
   - "Only outputs from the ModelArk platform are trusted; cross-platform use is not supported."
   - "Only outputs under the same account."
   - "Only original model outputs… cannot be used after secondary editing."
   - "Compressing or forwarding files may invalidate trust verification." BytePlus recommends saving originals straight to BytePlus TOS.
   - "Trust applies only to input assets. Output may still fail" output moderation.

   **This explains our refusals.** Our Seedream keyframes come from BytePlus directly (`src/providers/image.ts`), but Seedance runs through OpenRouter, which is a different account and platform. Our last frames also came back via OpenRouter. **UNCERTAIN** (strong inference)

   **Second open question:** our keyframes are Seedream generations *with the portrait as reference*. The docs name "text-to-image" outputs only, so keyframes may not count as trusted even on ModelArk. **UNCERTAIN**. Test this.
2. **Preset digital characters.** ModelArk's Playground has a free "Digital character library" of compliant photoreal faces, filterable by gender, age and nationality. Each character is an asset ID, passed as `asset://<ID>` in `content[].image_url.url` and named `Image N` in the prompt. **VERIFIED** [S3][S6]. You must accept an agreement in the Playground first [S6]. Labels can be "Non-Commercial Use Only", and a free-use period may later turn paid. **VERIFIED**: BytePlus Copyright and Portrait Feature Usage Rules, https://docs.byteplus.com/en/docs/modelark/copyright_and_portrait_feature_usage_rules
3. **Authorized real-person assets.** The actor does a liveness check through a QR invite and uploads photos, video or audio. You get an asset group and IDs, used the same way. **VERIFIED** [S6]. Not relevant to us: our characters are fictional.

**Through OpenRouter**, none of the three paths is documented. The `input_references` schema only takes `image_url`, and there is no `asset://` passthrough. **VERIFIED** [S8] (absence). So: OpenRouter gives us text-to-video, or references that happen to pass the filter. Reliable photoreal identity needs **BytePlus ModelArk direct**. Activation needs a balance of at least USD 30, or an AI Savings Plan / resource pack. **VERIFIED** [S2]

---

## 3. Character consistency across generations

- **Use one headshot plus one full-body image.** "For character references, using a headshot + full-body photo is sufficient. Using multi-view character images is not recommended." Multi-view sheets read as different people and "worsen the ID drift". **VERIFIED** [S1]
- **Headshot spec.** "Close-up face image containing only the character's head… no expression is best; minimize… shoulders, neck, and background" [S1]. The asset-library spec is "front-facing close-up with a neutral expression, framed above the shoulders; the face should occupy about two-thirds of the image", in portrait orientation. The full-body spec is front-facing, full body, portrait orientation [S6]. **VERIFIED**
- **Order and binding.** "The more an asset requires precise reference, the earlier it should be placed." Bind it in the prompt, e.g. "facial features reference image 1 (headshot), makeup and styling reference image 2 (full-body photo)". **VERIFIED** [S1]
- **Fewer assets.** Don't use the full limit of 9 images. Too many make it hard for the model to judge "feature priorities". **VERIFIED** [S1]. Stability drops above 4 referenced people. **VERIFIED** [S1]
- **Multiple characters.** Upload references in the order the characters first appear, so the mapping and the voices don't swap. **VERIFIED for 2.5** [S5]
- **First frame vs reference.** A `first_frame` locks the output aspect ratio to the image. Alternatively, pass the image as a `reference_image` and say in the prompt that it is the first frame: the result will be "similar to… but may not match exactly". **VERIFIED for 2.5** [S5]. `sd2-pe` uses "`@Image 1 as first frame constraint`" for 2.0. **VERIFIED** [S7]. That is our workaround when `first_frame` is refused.
- **Frames and references can't be mixed.** On BytePlus a first/last frame "cannot be mixed with reference media". **REPORTED** (Segmind, 2026-04-19). On OpenRouter, if both are sent, `frame_images` wins and the job becomes image-to-video. **VERIFIED** [S8]
- **Aspect mismatch.** If the input image and output have different aspect ratios, frames can jump or stretch. Crop the input to the exact output pixel size, e.g. 720×1280. **VERIFIED** [S2]
- **Oversized references.** High-resolution AI references can cause "fingerprint-like textures". Resize them to at most the output resolution. **VERIFIED for 2.5** [S5]

---

## 4. Native audio

- **Seedance 2.0 languages.** The 2.0 guide treats Chinese and English as first-class and tags anything else ("says in Japanese {…}") [S1]. It doesn't publish a 2.0 list. **VERIFIED** (no list exists). Seedance 2.5 lists 11 languages: ZH, EN, ES, ID, MS, TH, AR, PT, VI, JA, KO. **No Ukrainian or Russian.** **VERIFIED** [S5]. Third parties claim "8+ languages" for 2.0 without a list. **REPORTED**. Ukrainian via native speech: **UNCERTAIN, assume unsupported**. Keep the TTS + lip-sync fallback.
- **Mispronunciation.** For tricky words, respell with a common homophone. **VERIFIED** [S1] (the doc's case is Chinese).
- **One speaker vs two.** Name each speaker and write `Name says: {…}` per line. Put two-hander exchanges in separate `Shot N:` blocks with a close-up of whoever is speaking. **VERIFIED** [S1][S5]
- **Voice drift.** Describe the voice explicitly: age, gender, timbre, pace, accent. "After adding descriptions of voice characteristics to the prompt, the voice matching accuracy improves significantly." **VERIFIED** [S1]. For the same voice across shots, you can pass an earlier shot's audio as `@Audio 1` with "Reference the timbre in Audio 1". It must be accompanied by an image or video reference, 2–15 s, wav or mp3. **VERIFIED** [S1][S4][S9]
- **Unwanted music.**
  - The model may score the clip anyway, or turn sound effects into music. Fix: "retain character voices only… Enumerate… music, background music, BGM, score, instrumental, melody, synth effects, and ambient pad", and "Repeat the audio constraint at both the beginning and the end of the prompt". **VERIFIED for 2.5** [S5]
  - Unspecified audio "tends to come back scored", so say "no music" explicitly. **REPORTED**: fal [S9]
- **Ambience.** Name the sounds in `< >`, e.g. `<faint café chatter and cup clinks, low and constant>`. **VERIFIED** syntax [S1]
- **Click at the end.** Narrated clips often end with "abrupt clicking sounds and cut-off noise". The official fix is an audio fade-out at the end. **VERIFIED** [S1]
- **Background noise hurts sync.** Music or chatter under dialogue makes lip motion jittery. **REPORTED** (CrePal, 2026-02-15)

---

## 5. Pitfalls and limits

| Item | Fact | Label |
|---|---|---|
| Duration | 4–15 s, integer; BytePlus also accepts `-1` (auto). OpenRouter lists every integer from 4 to 15 for 2.0 and 2.0-fast | VERIFIED [S4][S8] |
| Resolution | 2.0: 480p/720p/1080p/4K. **2.0-fast and mini: 480p/720p only.** fal R2V: up to 4k | VERIFIED [S4][S8][S9] |
| Aspect | 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 (OpenRouter adds 9:21). 9:16 at 720p = 720×1280 | VERIFIED [S8] |
| References (2.0) | Images 1–9, videos ≤3 (2–15 s each, ≤15 s total), audio ≤3 (≤15 s total), ≤12 files total (fal). Images 300–6000 px, <30 MB, request ≤64 MB | VERIFIED [S4][S9] |
| Unwanted subtitles | Can't be fully avoided. "The probability of generating subtitles in landscape is significantly lower than in portrait" | VERIFIED [S1] |
| Text rendering | Common words are OK, avoid rare characters and symbols. For exact spelling, spell the word letter by letter or supply the text as an image reference | VERIFIED [S1][S5] |
| Hands, anatomy | Official fallback constraint: "Hands are anatomically correct… Exclude… extra fingers, fused fingers, malformed hands, collapsed faces" | VERIFIED (2.5) [S5] |
| Glowing eyes | Strong emotion words can make pupils glow. Tone emotion down to physical cues | VERIFIED (2.5) [S5] |
| Moderation | Separate failures: input text sensitive, input image real person, `OutputVideoSensitiveContentDetected`, `OutputAudioSensitiveContentDetected` (avoid songs, artists, catchphrases), copyright PolicyViolation. Failed jobs reportedly not charged. Minors and violence: no specific public rules found | REPORTED (Segmind, 2026-04-19); minors/violence UNCERTAIN |
| Seeds | OpenRouter exposes `seed: true` for 2.0, but "not guaranteed by all providers". Treat seeds as reproducibility hints, not a guarantee | VERIFIED [S8]; determinism UNCERTAIN |
| Output URL | BytePlus video URLs last 24 h (≤100 downloads); task records 7 days. Download at once | VERIFIED [S4] |
| Rate limits (BytePlus) | 2.0: individual accounts 180 RPM and 3 concurrent tasks; enterprise 600 RPM / 10; 4K concurrency 1. Over the limit, extra tasks queue (429 on RPM) | VERIFIED [S2][S4] |
| OpenRouter uptime | The Seed endpoint showed `uptime_last_1d` = 87% on 2026-10-19. Plan for retries | VERIFIED [S8] (one snapshot) |
| Latency | ~3.5–4 min end to end. OpenRouter suggests 30 s polling and a 1 h timeout | REPORTED (Higgsfield); OpenRouter blog 2026-09-24 |
| Cost (OpenRouter) | Token-billed. tokens ≈ W×H×24×s/1024, so 720×1280 is ≈21.6k tokens/s. 2.0 costs $7/M ≈ **$0.151/s**; 2.0-fast $4.2/M ≈ $0.091/s; mini $3.5/M ≈ $0.076/s. Audio on or off costs the same | VERIFIED [S8] (my arithmetic) |
| Cost trap: video refs | Requests with **video input** bill at a lower per-token rate (2.0: $4.3/M), but the input video's seconds are added to the token count [fal formula]. A 15 s reference video can cost more than the output | VERIFIED rates [S8]; input-seconds rule VERIFIED for fal (video-models.md), UNCERTAIN for OpenRouter |
| Cost trap: Playground | The Playground generates **four clips per request by default**. Set it to 1 | VERIFIED [S6] |
| Cheaper path | BytePlus `service_tier: "flex"` (offline) costs 50%, but takes hours. Not on OpenRouter | VERIFIED [S4] |
| Extension chains | Every extension of model output degrades faces ("mottled color blocks"), and joins jump. Trim 6 frames from the end of clip A and 1 frame from the start of clip B | VERIFIED [S1] |
| JPEG decode 400 | Odd chroma subsampling fails with "invalid image". Re-encode with ffmpeg or send PNG | VERIFIED (2.5) [S5] |

---

## 6. Pipelines, cookbooks and code to copy

- **`sd2-pe` official prompt-optimizer skill** [S7]: a 90-line SKILL.md with the three-section structure, eight core elements, `@Image N (name)` disambiguation and one-camera-move rule. Install: `npx --yes skills@latest add "https://arkdocs-en.tos-ap-southeast-1.volces.com/skills/" --skill sd2-pe --yes`. There is also `sd25-pe` v0.1.1 for 2.5. **VERIFIED**. Its rules can go straight into our Gemini script-writer system prompt, so Gemini emits Seedance-shaped prompts.
- **BytePlus quick-start bundle** (Python, ModelArk SDK, polls every 30 s) and **Playground templates** with a "Code" button that copies the REST call [S2][S6]. **VERIFIED**
- **Trusted-output chaining code example** in [S3]: generate, save the original to TOS, then reuse it as input on the same account. **VERIFIED** (the code sits in a tab; I read the prose only).
- **OpenRouter:** webhooks (`callback_url`, `video.generation.completed`, `X-OpenRouter-Signature`) instead of polling; `usage.cost` on completed jobs. **VERIFIED** [S8]
- **Community skills:** OpenMontage `seedance-2-0` skill (https://skills.sh/calesthio/openmontage/seedance-2-0) and Emily2040 `seedance-audio` (tessl registry). **REPORTED**, not reviewed. Lower priority than `sd2-pe`.
- Not checked this pass: Jimeng / Dreamina / CapCut help pages (consumer UIs; the BytePlus docs are their API equivalent).

---

## Changes we should make (ranked)

1. **Move Seedance calls to BytePlus ModelArk direct, on the same account as Seedream, and pass first frames as original ModelArk outputs.** This is the only documented way to get a photoreal AI character in as `first_frame`. Spike plan, about 2 clips, roughly $1.50:
   - (a) Generate the portrait with Seedream 5.0 lite **text-to-image** on ModelArk.
   - (b) Pass its original BytePlus URL, not re-encoded, as `first_frame` to `dreamina-seedance-2-0-260128` on the same account. Expect acceptance.
   - (c) Try a portrait-referenced keyframe the same way. It may fail: the docs only name T2I.
   - (d) For shot 2, request `return_last_frame` and feed shot 1's last frame as shot 2's `first_frame` (trusted since 2026-04-16).
   - Rules: keep originals byte-identical (save to TOS or pass the returned URL), keep everything within 30 days, and hold an account balance of at least $30.
   - Fallback: pick a face from the **digital character library** (`asset://…`) and test the non-commercial label first.
2. **Switch the dialogue syntax to the official braces, and stop repeating or annotating the line.** In `talkingPrompt`, replace

   `${name} looks toward the camera and says, ${emotion}: "${said}" Exactly these words, once, in English, clearly lip-synced.`

   with

   `${name} looks toward the camera and, ${emotion}, says in English: {${said}}`

   Then move the strictness into one global constraint at the end (see 4). The 2.5 guide says text attached right after a line can trigger burned-in subtitles. That matters most for us, because portrait output already has the higher subtitle rate.
3. **Use the official reference syntax and order in `textToVideoPrompt`.**
   - Before: `Reference image 1 is X: keep exactly this face…`
   - After: `@Image 1 (${name}) is the face reference: a head-only close-up. Keep ${name}'s facial features from @Image 1 (${name}) exactly. @Image 2 (opening frame) is the first-frame constraint: start from this composition, setting and outfit.`
   - Every later mention must be written `@Image 1 (${name})` / `${name}@Image 1`, never `@Image 1 runs…`. Put the headshot first.
4. **Add an audio policy at both ends of the prompt.**
   - **Start:** `Audio policy: only ${name}'s spoken line plus quiet natural room tone; no music, background music, BGM, score, instrumental, melody, soundtrack, synth, ambient pad or stinger at any moment.`
   - **End:** `Generate audio strictly according to the dialogue; do not add or remove any words; one speaker only; clean, clear, standard pronunciation. No music of any kind. Avoid generating subtitles, captions, a logo or a watermark.`
   - Name wanted ambience in `< >`, e.g. `<soft kitchen hum, low and constant>`.
5. **Give each character one voice description and repeat it verbatim in every shot,** e.g. `Voice: warm low female voice, mid-30s, neutral American accent, unhurried.` Gemini writes it once in `script.character`. Optional: pass shot 1's audio (2–15 s) as `@Audio 1` with "Reference the timbre in @Audio 1" for shot 2.
6. **Fix the portrait to the official headshot spec, and add a full-body image as the second reference.**
   - `portraitPrompt`: `Front-facing close-up framed above the shoulders, the face filling about two-thirds of the frame, neutral expression, mouth closed, plain light-grey background, even soft light. Vertical portrait.`
   - Add a separate `Front-facing full-body photo, same person, same outfit, plain background` render.
   - Never use multi-view turnaround sheets as references.
7. **Add the official constraint tail to every video prompt:** `The character's face remains stable and consistent with @Image 1 (${name}) throughout, without deformation; hands anatomically correct; natural, smooth movement with no stutter or flicker. Only one ${name} in frame; no duplicate or twin.` Use only one camera move per shot; our "locked-off, at most a slow push-in" already complies.
8. **Two-shot generations: use `Shot 1:` / `Shot 2:` blocks without seconds,** with a `Name says: {…}` line per shot. Put timestamps only on 2.5.
9. **Post-processing.** Apply a 150–250 ms audio fade-out on every clip (official fix for the end click). Crop or resize input images to exactly 720×1280 before sending, and re-encode JPEGs to PNG. Download outputs right away (24 h URLs).
10. **Retries and cost guards.**
    - On `PrivacyInformation`, don't retry the same image. Switch path (trusted output → digital character → text-to-video).
    - On `Output*SensitiveContentDetected`, rephrase once.
    - Budget about 15% retries (87% daily uptime on the OpenRouter Seed endpoint).
    - Use `seedance-2.0-fast` (~$0.09/s at 720p) for drafts and 2.0 for finals.
    - Avoid video references unless needed: they add input seconds.
11. **Ukrainian:** there is no evidence of native support. Keep it on the TTS + lip-sync route. When we do try native speech in a non-English language, tag it (`says in Spanish: {…}`) and never mix languages within a line.
12. **Optional:** put the `sd2-pe` rules (three sections, `@Image N (name)`, one camera move, constraint fallback) into the Gemini script prompt, so the generated shot fields already match Seedance's expected shape.

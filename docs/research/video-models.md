# AI video models for 9:16 talking micro-drama shots (research snapshot, 2026-10-16)

Purpose: pick API video models that can turn one keyframe (or a set of character/location references) plus one spoken line into a 5-8 s vertical clip.

Legend: **[V]** = verified on the cited page during this research (fetched 2026-10-16). **[U]** = uncertain: from third-party sources only, sources disagree, or not checked against an official page. Prices are USD.

> **Act now:** the Gemini API **shuts down `veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview` and `veo-3.1-lite-generate-preview` on 2026-10-22** (6 days from now). Google names `gemini-omni-1.1-flash` as the replacement [V: https://ai.google.dev/gemini-api/docs/deprecations]. fal's `fal-ai/veo3.1` endpoints say "will be deprecated on November 17, 2026" [V: https://fal.ai/models/fal-ai/veo3.1]. OpenAI shut down **Sora 2 / the Videos API on 2026-09-24** and named no replacement [V: https://developers.openai.com/api/docs/deprecations].

---

## 1. Comparison table

All prices are per second of output with audio on, unless the cell says otherwise. 9:16 = native vertical output.

| Model (latest) | Released | Native speech | T2V / I2V / Ref / F+L / Extend | Max clip | 9:16 | Official API price | fal.ai price + endpoint | AA arena rank (T2V / I2V, with audio) |
|---|---|---|---|---|---|---|---|---|
| **Google Gemini Omni Flash 1.1** | GA 2026-08-27 [V] | Yes. Dialogue in quotes; only English is evaluated [V] | Y / Y / Y (multiple images + up to 3 short video refs) / Y / Y (to 40 s) [V] | ~10 s per generation [U] | Yes [V] | Token-billed; about $0.10/s at 720p [V] | $0.03 (360p), $0.10 (720p), $0.15 (1080p), $0.30 (4K) on `google/gemini-omni-flash/v1.1/reference-to-video` and `.../image-to-video` [V] | #8 / #3 [V] |
| **Google Veo 3.1** (standard/fast/lite) | 2025-10-15 (preview); the version tables say updated Jan 2026 [V] | Yes. Dialogue in quotes; English only evaluated [V] | Y / Y / Y (3 refs, 8 s only) / Y / Y (+7 s ×20) [V] | 8 s [V] | Yes [V] | $0.40 std, $0.10-0.12 fast, $0.05-0.08 lite [V]. **Gemini API shutdown 2026-10-22** | $0.40 std, $0.15 fast; `fal-ai/veo3.1`, `/image-to-video`, `/reference-to-video`, `/first-last-frame-to-video`, `/extend-video`, `/fast/...` [V]. Deprecated on fal 2026-11-17 | #19 / #13 [V] |
| **ByteDance Dreamina Seedance 2.5** | Launched ~2026-07-31 [U]. On fal by 2026-08-12 [V] | Yes. Dialogue in double quotes, lip-synced. 11 languages, **no Ukrainian** [V] | Y / Y / Y (up to 30 img + 10 video + 10 audio refs) / ? / edit+extend [U] | 30 s [V] | Yes [V] | BytePlus: about $0.231/s at 720p, $0.569/s at 1080p (token-billed) [V] | About $0.473/s at 720p (≈2× BytePlus); `bytedance/seedance-2.5/{text,image,reference}-to-video` [V] | #3 / #2 [V] |
| **ByteDance Seedance 2.0** (+Fast, Mini) | Mar 2026 [V, AA] | Yes [V] | Y / Y / Y (9 img + 3 vid + 3 aud) / Y [U] / – | 15 s [V] | Yes [U] | BytePlus: $0.15/s at 720p, Fast $0.12/s, Mini $0.08/s [V] | About $0.30/s at 720p; `bytedance/seedance-2.0/{image,reference}-to-video` [V] | #7 / #6 [V] |
| **Kling 3.0 / 3.0 Omni ("O3")** (Kuaishou) | 2026-02-05 [U, press] / Feb 2026 [V, AA] | Yes. Chinese and English native; other languages are auto-translated to English [V, fal]. Third parties list 5 languages (ZH/EN/JA/KO/ES) [U] | Y / Y / Y (Elements: frontal + refs + video + voice id) / Y / multi-shot up to 6 [V] | 15 s [V] | Yes (Omni: 16:9, 9:16, 1:1) [V, Replicate] | Kling direct: not verified [U]. Runway router: O3 Pro 17 credits/s = $0.17 [V] | v3 Pro I2V $0.168 (audio) / $0.196 (voice control) `fal-ai/kling-video/v3/pro/image-to-video`. O3 Pro ref $0.14 `fal-ai/kling-video/o3/pro/reference-to-video`. O3 Std I2V $0.112 [V] | O3 Pro #15 / #17; v3 Pro is the Elo-1000 anchor [V] |
| **Kling AI Avatar v2** (audio-driven talking head) | 2025-26 [U] | Lip-syncs to **your** audio, so any language works | image + audio → video | Length of the audio [V] | Follows the image [U] | – | $0.0562/s Std, $0.115/s Pro; `fal-ai/kling-video/ai-avatar/v2/{standard,pro}` [V] | n/a |
| **MiniMax H3** ("Hailuo 03") | 2026-07-31 [U]; on fal by 2026-07-30 [V] | Yes, stereo. Can be driven by a reference audio clip. 11 languages including Russian, **no Ukrainian** [U] | Y / Y / Y (9 img + 3 vid + 3 aud) / Y / edit [V] | 15 s [V] | Yes [V] | $0.08/s at 768p, $0.13/s at 2K [U] | $0.26/s at 2K; `minimax/h3/{text,image,reference}-to-video` [V] | #4 / **#1** [V] |
| **fal "H3 Max"** (fal's post-train of H3) | Aug 2026 [V, AA] | Yes. Separate **lip-sync** endpoint (image + audio) [V] | I2V / ref / director / turbo [V] | ? | ? | – | Lip-sync $0.08/s at 768p, $0.16/s at 1080p; `minimax/h3-max/lip-sync/image-to-video`, `minimax/h3-max/{image,reference}-to-video`, `minimax/h3-max-turbo/image-to-video` [V] | #5 / #5 [V] |
| **Alibaba Wan 3.0** | Public beta 2026-08-06 [U]; AA lists Aug 2026 [V] | Yes, generated in the same pass. Lip sync and language list not confirmed [U] | Y / Y / Y (10 img + 5 vid + 5 aud) / Y (end image) / – [U]. "Thinking" mode [U] | 30 s [U] | Probably; "adaptive" by default [U] | Model Studio $0.10/s at 720p list price (30% promo ran to Sep 24) [U] | $0.05 (480p), $0.10 (720p), $0.20 (1080p); `alibaba/wan-3.0/{text,image}-to-video` [V] | **#1** / #4 [V] |
| Alibaba **Wan 2.2** (open weights) | 2025 | No (Wan 2.5+ added audio, closed) [U] | T2V/I2V, Animate | ~5 s | Yes | Self-host (Apache 2.0) [U] | `wan-video/wan-2.2-i2v-fast` on Replicate [V] | n/a |
| **Alibaba-ATH HappyHorse 1.1** | 2026-06-24 [U] | Yes, 7 languages [U] | Y / Y / Y (2-9 images) | 15 s [U] | ? | From about $0.099/s at 720p [U] | not checked | #11 / #9 [V] |
| **Runway** (Gen-4.5, Aleph 2.0, Act-Two) | – | Gen-4.5: no native audio [U] | Gen-4.5 T2V/I2V. Aleph = video edit. Act-Two = performance transfer | – | Yes [U] | $0.01 per credit. gen4.5 12 cr/s, aleph2 28 cr/s, act_two 5 cr/s [V] | not on fal | not in top 20 |
| **OpenAI Sora 2 / 2 Pro** | – | – | **API shut down 2026-09-24** [V] | – | – | – | – | – |
| **Luma Ray 3.2** | 2026-06-09 [U] | **No native audio** [U] | T2V/I2V/keyframes/extend/reframe. **No character reference** (Ray3 has it) [U] | 10 s [U] | Yes [U] | $0.30 per 5 s at 720p, $1.20 per 5 s at 1080p [U] | – | not in top 20 |
| **Pika 2.5** | – | Separate audio models (Pika Speech TTS, Soundtrack) [U] | T2V/I2V, 5 s [U] | 5 s | ? | dev.pika.art, $10/month membership [U] | Older `fal-ai/pika/v2.2/...` [U] | not ranked |
| **Lightricks LTX-2.5** (Fast/Pro, open weights) | 2026-08-11 [U] | Yes, joint audio+video [U] | T2V/I2V/audio-to-video, multi-shot [U] | 5-20 s [U] | ? | Fast $0.09/s, Pro $0.12/s at 720p [U] | not checked | Fast #19 on I2V [V] |
| **Tencent HunyuanVideo 1.5** (open) | Nov 2025 [U]. No 2026 release found | No [U] | T2V/I2V. HunyuanCustom/Avatar are separate models | ~5-10 s | Yes | Self-host | – | not ranked |
| **xAI Grok Imagine Video 1.5** | Jun/Jul 2026 [U] | Yes; face and voice references [U] | T2V/I2V/ref/extension | 15 s [U] | Yes [U] | About $0.147/s at 720p via Krea [U]. Runway: 16 cr/s at 720p [V] | `xai/grok-imagine-video/image-to-video` [V, slug only] | #10 / #8 [V] |
| **BFL FLUX 3 (video)** | Aug 2026 [U] | Yes, with lip sync [U] | T2V/I2V/continuation | 20 s [U] | ? | $0.25-0.42/s via resellers [U] | not checked | #6 / #7 [V] |
| **Utopai X** (post-train of MiniMax H3) | 2026-09-30 [U] | Yes | – | – | – | **No public API**. Only inside the PAI app [V, AA "No API"] | – | #2 T2V [V] |
| Others on AA boards: PixVerse V6, Vidu Q3, Sand.ai MAGI-2 (preview, no price), Agnes-Video-2.5 | | | | | | | | |

Leaderboard source: Artificial Analysis AA-Video-T2V v2.1 (https://artificialanalysis.ai/video/leaderboard/text-to-video) and AA-Video-I2V v1.1 (https://artificialanalysis.ai/video/leaderboard/image-to-video), fetched 2026-10-16. The pages show no "last updated" date; the newest entries are from Sep 2026. The default view is "with audio". Ranks 1-5 have overlapping 95% CIs (about ±15 Elo), so treat them as statistically tied. Top Elo values: T2V Wan 3.0 1174, Utopai X 1169, Seedance 2.5 1160, H3 1159. I2V H3 1141, Seedance 2.5 1139, Omni Flash 1.1 1134, Wan 3.0 1127.

---

## 2. Per-model notes

### Google: Gemini Omni Flash 1.1 (successor to Veo)
- `gemini-omni-1.1-flash` reached GA on 2026-08-27. `gemini-omni-flash-preview` (2026-06-30) shuts down on 2026-10-22 [V deprecations page]. It was announced at Google I/O on 2026-05-19 [U].
- **Modes** [V https://ai.google.dev/gemini-api/docs/omni.md.txt]:
  - Text-to-video and image-to-video (one image; the model decides how to use it).
  - First+last-frame interpolation.
  - Subject reference with multiple images (examples use 2-6 images, no stated maximum).
  - Up to 3 reference video clips of ≤3 s each, which work best for likeness; their audio is ignored.
  - Extension of 3-10 s per step, up to 40 s total.
  - Multi-turn conversational editing via `previous_interaction_id`.
- It uses the **Interactions API, not `generateVideos`**, so migrating from Veo means code changes [U].
- **Output** [V]: 360p, 720p, and 1080p/4K (both upscaled). 16:9 and 9:16. FPS not stated.
- **Audio** [V]: on by default. English is fully supported, other languages are "unevaluated". **Audio references are unsupported.** Dialogue can't be added when extending uploaded videos. The docs describe no way to force an exact line; quoting the line in the prompt is the convention.
- **Region limits** [V]: no editing or extension of uploaded videos in the EEA, CH or UK. No uploads of minors there, and no uploads of "certain recognizable people".
- **Price** [V]: $17.50 per 1M video output tokens, 5,792 tokens per second at 720p, so about $0.10/s. fal charges $0.10/s at 720p and $0.15/s at 1080p. Runway charges 10 credits/s at 720p.
- Latency is not published.

### Google: Veo 3.1 (legacy as of this month)
- [V https://ai.google.dev/gemini-api/docs/veo]:
  - Clips are 4/6/8 s. 8 s is required for 1080p, 4K, reference images and extension.
  - 24 fps, 16:9 or 9:16.
  - Up to 3 reference images (standard and fast only).
  - Extension adds 7 s per step, at 720p only.
  - Latency is 11 s minimum and up to 6 min at peak.
  - English only for audio.
- A forum thread about 10 months old reported that reference images only worked at 16:9. The current docs no longer list that restriction [U].
- Vertex AI GA `veo-3.1-generate-001` exists. A retirement of "Nov 17, 2026 or later" is reported but not verified [U]. **Don't build new pipeline code on Veo.**

### ByteDance: Seedance 2.5 / 2.0
- **2.5** [V https://fal.ai/learn/tools/what-is-seedance-2-5, https://fal.ai/models/bytedance/seedance-2.5/reference-to-video]:
  - 4-30 s, 480p/720p on fal (1080p priced on BytePlus).
  - Aspect ratios: auto/21:9/16:9/4:3/1:1/3:4/9:16.
  - Up to 50 references (30 image / 10 video / 10 audio). Prompts refer to them as `[Image1]`, `[Image2]`, ...
  - Audio references set "rhythm, timing, and voice".
  - Dialogue goes in double quotes and is lip-synced.
  - Dialogue languages: ZH, EN, ES, ID, MS, TH, AR, PT, VI, JA, KO. **No Ukrainian.**
- **Pricing** [V]:
  - fal is token-billed: tokens = h × w × (input video s + output s) × 24 / 1024, at $0.0214 per 1k tokens. A 9:16 720p clip has the same pixel count as 16:9, so it costs about $0.473/s.
  - When you pass video references, the price is multiplied by 0.6.
  - BytePlus direct is about $0.231/s at 720p (https://ai.byteplus.com/ark/region:ap-southeast-1/docs/ModelArk/1544106), roughly half of fal.
  - Third parties report that BytePlus needs a prepaid pack (7 × $4.30 minimum, 90-day expiry) [U]. The BytePlus pricing page itself shows only pay-as-you-go [V].
- **Main risk: real-face filter.** BytePlus does not accept reference images or videos containing real human faces. The classifier also flags photoreal AI faces, returning a 400 "input may contain a real person" [U, multiple sources plus the BytePlus "private virtual portrait library" doc]. **A photoreal AI-generated actor keyframe may be rejected.** Test this first. Workarounds: BytePlus's virtual-portrait library, or more stylized faces.
- Latency: a third-party benchmark puts Seedance at about 3.5-4 min end to end, the slowest of the big models [U, Higgsfield].

### Kling (Kuaishou): 3.0, 3.0 Omni (O3), Avatar v2
- Kling 3.0 series (Video 3.0 + Omni) was announced in Feb 2026 [U: Kuaishou IR page returned 403; AA lists Feb 2026].
- I found no official 3.1 or 3.5. "Kling 3.5" and "3.0 Turbo" appear only on SEO and affiliate sites [U].
- **fal endpoints and prices** [V]:

  | Endpoint | Audio off | Audio on | Voice control |
  |---|---|---|---|
  | `fal-ai/kling-video/v3/pro/image-to-video` | $0.112/s | $0.168/s | $0.196/s |
  | `fal-ai/kling-video/o3/standard/image-to-video` | $0.084/s | $0.112/s | – |
  | `fal-ai/kling-video/o3/pro/reference-to-video` | $0.112/s | $0.14/s | – |

  Other endpoints: `fal-ai/kling-video/v3/standard/{text,image}-to-video`, `fal-ai/kling-video/v3/pro/image-to-video/4k`, `fal-ai/kling-video/o3/pro/image-to-video` (start+end frame), `fal-ai/kling-video/o3/standard/text-to-video`.
- **Features** [V fal]:
  - Clips are 3-15 s. In I2V the aspect ratio comes from the start image. `end_image_url` sets an end frame.
  - Multi-shot via `multi_prompt` with `shot_type: "customize"`.
  - **Elements**: each has a frontal image, extra reference images, an optional video and a `voice_id`. Prompts refer to them as `@Element1`. Voice binding only works with *video* elements.
  - Elements are Pro only (O3 Standard has none).
  - Omni accepts up to 7 reference images, or 4 when a reference video is also used [V Replicate].
- **Speech**: Chinese and English are native; other languages are auto-translated to English [V fal]. **Ukrainian will not be spoken.**
- **Kling AI Avatar v2** takes a portrait image plus an audio file, and the output length matches the audio. It costs $0.0562/s on Standard and $0.115/s on Pro [V https://fal.ai/models/fal-ai/kling-video/ai-avatar/v2/pro]. This route works for Ukrainian with external TTS.
- **Replicate**: `kwaivgi/kling-v3-video` and `kwaivgi/kling-v3-omni-video` exist [V]. Prices could not be read from the page [U]; third parties quote $0.168-0.336/s.
- **Runway router**: kling3.0_pro costs 17 credits/s with audio; klingO3_pro costs 17 credits/s [V].
- Latency is about 1.5 min end to end [U].

### MiniMax: H3 (Hailuo 03) and fal's H3 Max
- **H3 on fal** [V https://fal.ai/learn/tools/minimax-h3-explained]:
  - Open-weight multimodal model. 5-15 s, 24 fps, 2K.
  - Aspect ratios: 21:9 to 9:16 (9:16 has a 1440 px short edge).
  - Up to 9 images, 3 videos and 3 audio clips (12 files maximum).
  - Native stereo audio and dialogue.
  - $0.26/s at 2K. The first 5 reference images are free; then $0.08 each.
- **Weights**: reportedly a 33B-parameter model published on Hugging Face on 2026-08-03 [U]. The license is unclear; one source mentions a "license catch for US creators" [U].
- **Official MiniMax API**: $0.08/s at 768p and $0.13/s at 2K [U, third party citing platform.minimax.io].
- **Dialogue languages**: AR, ZH, EN, FR, DE, IT, JA, KO, PT, RU, ES [U]. No Ukrainian.
- **H3 Max** is fal's own post-train, not an official MiniMax tier [U]. Its **lip-sync** endpoint `minimax/h3-max/lip-sync/image-to-video` takes an image plus audio. It costs $0.05/s at 480p, $0.08/s at 768p, $0.16/s at 1080p and $0.32/s at 2K [V]. This is a strong, cheap option for audio-driven Ukrainian dialogue.
- Backend inference for H3 Max is reportedly ~2.5 s per 5 s clip (Turbo ~1.5 s), excluding queue time [U].
- It ranks #1 on AA I2V [V].

### Alibaba: Wan 3.0 / 2.x
- **Wan 3.0** is a commercial API, **not open weights**. The newest official open weights are still Wan 2.2 (Apache 2.0) [U, consistent across several sources]. Sites claiming open Wan 3.0 or 2.7 weights look like SEO content.
- **fal endpoints** [V https://fal.ai/models/alibaba/wan-3.0/image-to-video]:
  - `alibaba/wan-3.0/image-to-video` with start image and optional end image.
  - `alibaba/wan-3.0/text-to-video`.
  - $0.05/s (480p), $0.10/s (720p), $0.20/s (1080p).
  - The sample output was 30 fps.
- **Unverified features** [U]:
  - Clips of 2-30 s.
  - Up to 10 image, 5 video and 5 audio references.
  - "Thinking" mode and document-to-video.
  - A "Prime" tier at about $0.14/s for 720p.
- **Runway router**: wan3 costs 10 credits/s at 720p and wan3_prime 14 credits/s [V]. **Replicate**: `alibaba/wan-3` [V].
- Lip sync and dialogue languages are not documented on the pages I could fetch [U].
- It ranks #1 on AA T2V with audio [V].

### Runway
- The Runway API is now a **model router** with its own models plus third-party ones (Kling, Wan 3, Seedance, H3, Veo, Omni, Grok, HappyHorse). Credits cost $0.01 [V https://docs.dev.runwayml.com/guides/pricing/].
- Runway's own models: gen4.5 at 12 cr/s, gen4_turbo at 5, aleph2 (video edit) at 28 with a 56-credit minimum, act_two (performance capture: drive a character with an actor video) at 5 cr/s, and gwm1_avatars (real-time avatars) [V].
- No Gen-5 is listed. I found no confirmation of native audio on Gen-4.5 [U].
- Act-Two is relevant if you film a human performing the line, including in Ukrainian, and transfer the performance to the character.

### OpenAI Sora
- The Videos API and all `sora-2` / `sora-2-pro` snapshots were announced as deprecated on 2026-03-24 and **shut down on 2026-09-24**, with no replacement [V]. Not usable.

### Luma Ray 3.2
- Released 2026-06-09 [U]. No native audio, and no character reference (Ray3 has it) [U, Luma field guide via search].
- Six aspect ratios including 9:16 [U, Luma FAQ via search].
- $0.30 per 5 s at 720p and $1.20 per 5 s at 1080p (SDR). Luma says prices may change before GA [U].
- Not a fit for talking shots.

### Pika
- Pika 2.5 (5 s, 720p/1080p) is on dev.pika.art, which is a $10/month membership covering many providers' models [U]. Pika Speech (TTS with voice cloning) is a separate model [U].
- On fal, the older `fal-ai/pika/v2.2/*` endpoints are what I could find [U].
- Not on the AA leaderboards. Low priority.

### Lightricks LTX-2.5
- Open weights, released 2026-08-11 [U]. Hugging Face: https://huggingface.co/Lightricks/LTX-2.5.
- Joint audio+video, up to 4K/50 fps [U, fal landing page via search].
- License: LTX-2.x Community License, free under $10M annual revenue [U].
- API: Fast $0.09/s, Pro $0.12/s at 720p [U].
- **Supports LoRA fine-tuning**, which helps lock a recurring character. Ranks #19 on AA I2V (LTX-2.5 Fast) [V]. Also the best open-weights option after H3.

### Tencent HunyuanVideo
- I found no 2026 release. The latest is HunyuanVideo 1.5 (Nov 2025), which has open weights and no native audio [U].
- Related models: HunyuanVideo-Avatar (audio-driven) and HunyuanCustom (subject consistency) [U].
- Not competitive for this use case in Oct 2026.

### Notable 2026 entrants
- **Utopai X**: #2 on AA T2V. A post-train of MiniMax H3 with **no public API** [V AA "No API"].
- **xAI Grok Imagine Video 1.5**: 1-15 s with audio, face and voice references [U]. #10 T2V / #8 I2V [V].
- **BFL FLUX 3 video**: up to 20 s with audio and lip sync [U]. #6 / #7 [V].
- **Alibaba-ATH HappyHorse 1.1**: up to 9 references, 7-language lip sync [U]. #11 / #9 [V].
- Also on the boards: **Sand.ai MAGI-2** (preview, no price), **PixVerse V6**, **Vidu Q3**.
- **ByteDance OmniHuman v1.5** is on fal as `bytedance/omnihuman/v1.5`, an audio-driven human animation model. I could not read its price [U].

---

## 3. Ukrainian dialogue: the key constraint

- **No major model officially lists Ukrainian for native speech:**
  - Veo and Omni: English only evaluated [V].
  - Seedance 2.5: 11 languages, no Ukrainian [V].
  - Kling: ZH/EN, everything else is translated to English [V].
  - H3: 11 languages including RU, no UK [U].
- Asking these models to speak a Ukrainian line will likely give wrong pronunciation, Russian-accented speech, or translation to English. Treat this as UNTESTED.
- **Workable pipeline for Ukrainian:**
  1. Generate the Ukrainian line with a TTS that supports Ukrainian.
  2. Then do one of the following:
     - **(a)** Feed the audio into an **audio-driven** model: H3 Max lip-sync, Kling AI Avatar v2, OmniHuman 1.5, Runway Act-Two (from an actor video), or audio references in Seedance 2.5, H3 or Wan 3.0.
     - **(b)** Generate the shot with native audio in English (or silent, with mouth motion), then re-lip-sync the Ukrainian audio with a lip-sync model such as `fal-ai/sync-lipsync/v2`.
- For English lines, native speech from Omni, Seedance 2.5, Kling and H3 is viable. Quote the line exactly in the prompt; none of them guarantees verbatim output.

## 4. Character identity consistency across shots

- **Best-in-class reference systems (Oct 2026):**
  - **Seedance 2.5**: 30 image refs plus video and audio refs. Strongest on paper, but blocked by the real-face filter.
  - **Kling 3.0 Omni Elements**: frontal + refs + video + bound voice id, called as `@Element1`. Designed for recurring characters, and the bound voice also keeps the timbre consistent.
  - **MiniMax H3**: 9 images + 3 videos + 3 audio, "holds subjects, motion, and audio consistent".
  - **Gemini Omni Flash 1.1**: multi-image subject refs plus ≤3 s video refs, which work best for likeness, plus multi-turn editing.
  - **Wan 3.0**: 10 images + 5 videos [U].
  - **HappyHorse 1.1**: 9 images [U].
- **Techniques:**
  1. **First-frame conditioning** (most robust and works with every model). Render each shot's keyframe with a consistent image model and character sheet, then run image-to-video. Identity drift then only happens within a single clip.
  2. **Multi-image reference-to-video** (Elements and refs), for when the shot is not keyframed.
  3. **Video references or voice binding** (Kling Elements with video, H3 or Seedance audio refs), so the voice stays consistent too.
  4. **First+last frame** (Kling, Omni, Veo, Wan) to pin the end pose for cuts.
  5. **LoRA fine-tuning** on open weights (LTX-2.5, Wan 2.2, MiniMax H3). Highest control, but needs GPUs and ops.
  6. **Audio-driven lip-sync** on a fixed portrait (Avatar v2, H3 Max lip-sync). Identity stays near-perfect because the face is the input image.

---

## 5. Shortlist for a head-to-head benchmark

Test setup: the same 9:16 keyframe (photoreal AI character), one English line plus the same line in Ukrainian, 8 s, 720p, audio on. Measure lip-sync accuracy, verbatim line fidelity, identity drift against the keyframe, artifacts, and wall-clock latency (queue and render separately). Prices are fal list prices unless noted.

| # | Model / endpoint | Why | Est. cost, one 8 s 720p clip |
|---|---|---|---|
| 1 | **Gemini Omni Flash 1.1**: `google/gemini-omni-flash/v1.1/image-to-video` (or the Gemini API `gemini-omni-1.1-flash` directly) | Google's current flagship (Veo replacement). #3 on I2V and cheap. 9:16 supported | **~$0.80** (if 8 s is allowed; else 10 s ≈ $1.00) |
| 2 | **Seedance 2.5**: `bytedance/seedance-2.5/image-to-video` | #2 on I2V and #3 on T2V. Best dialogue/lip-sync reputation. Test the real-face filter first | **~$3.78** on fal (~$1.85 via BytePlus direct) |
| 3 | **Kling 3.0 Omni Pro**: `fal-ai/kling-video/o3/pro/reference-to-video` (Elements), plus `fal-ai/kling-video/v3/pro/image-to-video` as the I2V control | Best character-consistency tooling (Elements + bound voice). Cheap | **~$1.12** (O3 ref, audio on); v3 Pro I2V ~$1.34 |
| 4 | **MiniMax H3**: `minimax/h3/image-to-video` | #1 on I2V. Open weights (future LoRA path). Accepts audio refs | **~$2.08** on fal at 2K (~$0.64 at 768p via the official API [U]) |
| 5 | **Wan 3.0**: `alibaba/wan-3.0/image-to-video` | #1 on T2V. Cheap. Up to 30 s | **~$0.80** |
| 6 | **Audio-driven Ukrainian baseline**: `minimax/h3-max/lip-sync/image-to-video` (or `fal-ai/kling-video/ai-avatar/v2/standard`) + Ukrainian TTS | The only route that guarantees the exact Ukrainian line | **~$0.64** at 768p (Avatar v2 Std ~$0.45), plus TTS |

- **Total for one pass of all 6** is about **$9-10** on fal (English line), plus about the same again for the Ukrainian-line pass on models 1-5. About **$20** in total for a 2-language × 6-model matrix.
- Dropped from the shortlist:
  - Veo 3.1: Gemini API shutdown 2026-10-22, fal deprecation 2026-11-17.
  - Sora: API dead.
  - Luma Ray 3.2 and Runway Gen-4.5: no native speech.
  - Utopai X: no API.
  - LTX-2.5: keep as an open-weights/LoRA fallback.

---

## 6. What I could not verify (be careful)

- Official Kling direct API pricing. The Kuaishou IR page returned 403 and kling.ai's changelog did not render.
- Replicate per-second prices for every video model. Model pages don't show them and the third-party figures conflict.
- Official MiniMax H3 pricing and the H3 dialogue language list. The H3 weights license.
- Wan 3.0 aspect-ratio list, lip sync and languages, and the Model Studio model id.
- Gemini Omni Flash maximum base-clip length (third parties say 10 s) and fps.
- Seedance 2.5 handling of a 1080p setting on fal, and whether the reference-to-video ×0.6 discount applies without video refs (the two fal pages word it differently).
- Latency numbers for all models. Only third-party, non-comparable figures exist.
- Release dates marked [U], and the specs of Luma, Pika, LTX-2.5, Grok, FLUX 3 and HappyHorse (secondary sources only).
- The Artificial Analysis pages carry no explicit update date.

## 7. Sources

Official / primary (fetched 2026-10-16):
- Gemini API pricing (updated 2026-10-15): https://ai.google.dev/gemini-api/docs/pricing
- Gemini API Veo docs: https://ai.google.dev/gemini-api/docs/veo
- Gemini API Omni docs: https://ai.google.dev/gemini-api/docs/omni.md.txt
- Gemini API deprecations: https://ai.google.dev/gemini-api/docs/deprecations
- OpenAI deprecations: https://developers.openai.com/api/docs/deprecations
- Runway API pricing: https://docs.dev.runwayml.com/guides/pricing/
- BytePlus ModelArk pricing: https://ai.byteplus.com/ark/region:ap-southeast-1/docs/ModelArk/1544106
- Artificial Analysis T2V: https://artificialanalysis.ai/video/leaderboard/text-to-video
- Artificial Analysis I2V: https://artificialanalysis.ai/video/leaderboard/image-to-video
- fal model pages:
  - https://fal.ai/models/fal-ai/veo3.1
  - https://fal.ai/models/fal-ai/veo3.1/reference-to-video
  - https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video
  - https://fal.ai/models/fal-ai/kling-video/o3/standard/image-to-video
  - https://fal.ai/models/fal-ai/kling-video/o3/pro/reference-to-video
  - https://fal.ai/models/fal-ai/kling-video/ai-avatar/v2/pro
  - https://fal.ai/models/google/gemini-omni-flash/v1.1/reference-to-video
  - https://fal.ai/models/minimax/h3-max/lip-sync/image-to-video
  - https://fal.ai/models/alibaba/wan-3.0/image-to-video
  - https://fal.ai/models/bytedance/seedance-2.5/reference-to-video
  - https://fal.ai/explore/image-to-video-apis
- fal articles:
  - https://fal.ai/learn/tools/what-is-seedance-2-5
  - https://fal.ai/learn/tools/minimax-h3-explained
- Replicate:
  - https://replicate.com/collections/text-to-video
  - https://replicate.com/google/veo-3.1
  - https://replicate.com/kwaivgi/kling-v3-omni-video

Secondary (used for [U] items):
- Wan 3.0 on fal vs Alibaba pricing: https://magica.com/news/alibaba-wan-3-fal-30-second-video and https://llm-stats.com/blog/research/wan-3.0-launch
- Wan open weights stopped at 2.2: https://howaiworks.ai/blog/alibaba-wan-open-weights-stopped-at-2-2
- MiniMax H3 pricing and languages: https://www.atlascloud.ai/blog/tips/minimax-h3-api-pricing, https://modelpick.dev/media-pricing/minimax-h3/, https://morphic.com/resources/models/minimax-h3-max
- Seedance real-face rules: https://docs.byteplus.com/en/docs/ModelArk/2333565, https://aividpipeline.com/blog/seedance-real-human-face-rules-2026
- Kling 3.0 launch: https://ir.kuaishou.com/news-releases/news-release-details/kling-ai-launches-30-model-ushering-era-where-everyone-can-be (403 on fetch)
- Utopai X: https://www.orcarouter.ai/blog/utopai-x-debut, https://www.tmcnet.com/usubmit/2026/09/30/10455051.htm
- Luma Ray 3.2: https://docs.agents.lumalabs.ai/guides/pricing/, https://lumalabs.ai/learning-center/articles/luma-video-models-field-guide
- LTX-2.5: https://huggingface.co/Lightricks/LTX-2.5, https://llm-stats.com/blog/research/ltx-2.5-launch
- Pika: https://apiframe.ai/guides/pika-labs-api-guide, https://pika.art/blog
- Grok Imagine 1.5: https://www.krea.ai/docs/api-reference/video/grok-imagine-15.md
- FLUX 3 video: https://runtimewire.com/article/black-forest-labs-flux-3-video-api-native-audio
- HappyHorse 1.1: https://openrouter.ai/alibaba/happyhorse-1.1
- HunyuanVideo 1.5: https://www.thundercompute.com/blog/best-open-source-ai-video-generation-models
- Latency: https://higgsfield.ai/blog/how-long-ai-video-generation-takes, https://programminginsider.com/top-5-fastest-ai-video-generators-in-2026/
- Gemini Omni launch context: https://app.cinevva.com/news/2026-05-19-google-io-gemini-omni

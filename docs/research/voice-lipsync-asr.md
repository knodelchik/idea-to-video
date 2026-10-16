# Verbatim dialogue pipeline: lip-sync, TTS, ASR (research as of 2026-10-16)

Goal: a character in a short vertical (9:16) micro-drama clip says an EXACT line, Ukrainian or English, with no paraphrasing.

Legend: **V** = VERIFIED against the linked page (official page unless noted "3p" = third-party/reseller page), **U** = UNCERTAIN (secondary source, conflicting sources, or not checked).
Prices are list prices seen on 2026-10-15/16 and change often.

---

## TL;DR

- The only way to *guarantee* the words is to make the audio yourself (TTS or a recording), check it with ASR, then drive the mouth from that audio (lip-sync or audio-driven avatar). If a video model generates its own audio, you are sampling, and you need an ASR gate plus retries.
- Recommended default: **ElevenLabs v3 (UA+EN, audio tags) -> ASR gate (ElevenLabs Scribe v2 or Groq Whisper large-v3) -> lip-sync with sync.so (lipsync-2-pro / sync-3) on a Flow/Veo-generated clip, or OmniHuman 1.5 / Kling Avatar v2 from a still frame -> final ASR gate on the rendered mp4.**
- Native-audio video models (Veo 3.1, Kling 3.0, Seedance 2.0, Gemini Omni Flash) are fine for English one-liners if they sit behind an ASR gate. They are risky for Ukrainian: no official Ukrainian dialogue support was found for any of them.

---

## 1. Lip-sync / audio-driven talking video

Two families:
- **Video-to-video re-sync** (keeps the existing shot and replaces the mouth): sync.so, Kling Lip-Sync, LatentSync, MuseTalk, InfiniteTalk v2v. This fits well with Flow/Veo clips, where you generate the acting shot first and then re-sync it.
- **Image(+audio)-to-video avatar** (generates the whole performance from one frame): OmniHuman 1.5, Kling Avatar v2, Hedra Character-3, HeyGen Avatar IV, Captions Mirage Avatar X, InfiniteTalk i2v, Wan 2.2 S2V.

Language-agnostic: every audio-driven lip-sync model here works from phonetic/acoustic features, not text, so Ukrainian audio should work the same as English (**U**, an inference from how the models work; no vendor publishes per-language lip-sync scores. Hedra says "supports multiple languages", **V**).

| Model | Type / inputs | Max length | Price (official) | API endpoint / reseller price | Quality / notes | Status |
|---|---|---|---|---|---|---|
| **sync.so sync-3** | video + audio (v2v); can open closed lips, but generically | plan-dependent: 1 min (Hobbyist) to 30 min (Scale+) | $0.107–0.133/s @25fps | sync.so API | Current flagship; handles occlusions, profiles, close-ups, up to 4K output; "fast" | **V** [sync docs](https://sync.so/docs/models/lipsync) |
| **sync.so lipsync-2-pro** | video + audio; needs a source with natural speaking motion (a still face won't sync) | same plan limit; processed in 30–40 s chunks | $0.067–0.083/s | fal `fal-ai/sync-lipsync/v2` (model=lipsync-2-pro): $5/min; lipsync-2: $3/min | Best for teeth/beard detail; 1.5–2x slower than lipsync-2; human faces only | **V** [sync docs](https://sync.so/docs/models/lipsync), **V(3p)** [fal](https://fal.ai/models/fal-ai/sync-lipsync/v2) |
| sync.so lipsync-2 | video + audio | as above | $0.04–0.05/s | fal as above | Cheap, fast default | **V** |
| sync.so react-1 | video + audio, rewrites expression/emotion | – | $0.133–0.167/s, paid sub only | – | Emotional re-performance | **V** |
| **Kling Lip-Sync** | video (2–10 s, 720p/1080p, 720–1920 px) + audio (2–60 s, ≤5 MB) | 10 s video on fal | Kling API: about $0.07 per 5 s (0.5 units) | fal `fal-ai/kling-video/lipsync/audio-to-video`: **$0.014/s of input video, rounded up to 5 s** | Cheapest re-sync option. Note that 9:16 at 720 px wide = 720x1280, which is inside the limits | **V(3p)** [fal](https://fal.ai/models/fal-ai/kling-video/lipsync/audio-to-video); Kling official price **U** (from search snippet of [kling.ai/dev/pricing](https://kling.ai/dev/pricing); the page didn't render) |
| **Kling AI Avatar v2** | 1 image + audio | – (kie.ai says up to 5 min, **U**) | Kling API: 720p ~$0.056/s, 1080p ~$0.112/s (**U**) | fal `fal-ai/kling-video/ai-avatar/v2/standard` $0.0562/s; `.../v2/pro` $0.115/s | Works on humans, animals, and cartoons | **V(3p)** [fal std](https://fal.ai/models/fal-ai/kling-video/ai-avatar/v2/standard) |
| **ByteDance OmniHuman 1.5** | 1 image + audio (+ text prompt) | audio <60 s @720p, <30 s @1080p | – | fal `fal-ai/bytedance/omnihuman/v1.5`: $0.16/s (billed by audio duration) | Strong reputation for full-body/gesture acting and emotion following audio | **V(3p)** [fal llms.txt](https://fal.ai/models/fal-ai/bytedance/omnihuman/v1.5/llms.txt), [fal guide](https://fal.ai/learn/devs/omnihuman-15-user-guide) |
| **Hedra Character-3** | start image + 0.5–600 s audio (up to 4 audio inputs, multi-speaker via [x,y] points) | 600 s | 540p 2.5¢/s, 720p 5¢/s, 1080p 6.25¢/s | Hedra API | Retries reportedly common (**U**); aspect ratios shown are only 1:1 (9:16 unconfirmed, **U**) | **V** [hedra](https://www.hedra.com/develop/models/video/hedra-character-3) |
| HeyGen Avatar IV | photo + audio or script; 9:16 supported | – | ~$0.05/s ($3/min) | OpenRouter `heygen/avatar-iv` | Presenter style, less "drama" | **U** [openrouter](https://openrouter.ai/heygen/avatar-iv), [heygen blog](https://www.heygen.com/blog/ai-video-generator-pricing) |
| Captions Mirage Avatar X | video or image + audio | – | $0.15/s, billed in 6 s increments | Captions API | Expensive | **V** (search snippet of official [pricing](https://captions.ai/help/docs/api/pricing)) |
| Tavus (Phoenix-4/4.5) | replica-based, conversational | – | plans + ~$0.90–1/min generated video overage | – | Built for real-time agents; poor fit for drama | **U** [tavus pricing](https://www.tavus.io/pricing) |
| **InfiniteTalk** (open, MeiGen) | image or video + audio; drives lips, head, and body | long-form (sparse-frame dubbing) | free locally | fal `fal-ai/infinitalk` $0.20/s (720p ×2); WaveSpeed $0.03/s 480p, $0.06/s 720p | Good open-source v2v dubbing that also moves head and body | **U** (search snippets) [fal](https://fal.ai/models/fal-ai/infinitalk), [wavespeed](https://wavespeed.ai/models/wavespeed-ai/infinitetalk) |
| Wan 2.2 S2V 14B (open) | image + audio (+prompt) | – | Alibaba Model Studio: 480p $0.072/s, 720p $0.129/s | fal `fal-ai/wan/v2.2-14b/speech-to-video` $0.10–0.20/s | Cinematic, but older than Wan 2.6 | **U** [fal](https://fal.ai/models/fal-ai/wan/v2.2-14b/speech-to-video), [alibaba](https://www.alibabacloud.com/help/en/model-studio/wan-s2v-overview/) |
| LatentSync 1.6 (open, ByteDance, Apache-2.0) | video + audio (v2v) | – | free; 18 GB VRAM for v1.6 | – | Best open-source mouth fidelity (sharp teeth); slow | **U** [instavar](https://instavar.com/research/ai-video/open-source-lip-sync-models), [paper](https://arxiv.org/pdf/2412.09262) |
| MuseTalk 1.5 (open, MIT) | video + audio | – | free; real-time on a V100 | – | 256x256 face crop (needs face restore); weaker identity | **U** [paper](https://arxiv.org/pdf/2410.10122) |
| Hallo/Hallo3, Sonic, MultiTalk | image + audio | – | free | various on fal/Replicate | Superseded in practice by InfiniteTalk/OmniHuman | **U** (not re-checked) |

### Video models that take audio as INPUT (an alternative to separate lip-sync)
| Model | Audio input? | Notes | Status |
|---|---|---|---|
| Veo 3.1 (Gemini API/Vertex/Flow) | **No** audio upload found; dialogue is generated from the prompt | $0.40/s standard, $0.10–0.12/s Fast, $0.05–0.08/s Lite (with audio) | **V** pricing [gemini pricing](https://ai.google.dev/gemini-api/docs/pricing); no audio input **V** (absent from [video docs](https://ai.google.dev/gemini-api/docs/video)) |
| Gemini Omni Flash (I/O 2026) | Model card lists audio as an input; product surfaces are Gemini app/Flow/YouTube; ~$0.10/s on the API | Lip-sync to *provided* audio is not documented; "editing people's speech" is restricted | **V** [model card](https://deepmind.google/models/model-cards/gemini-omni-flash/); behavior **U** |
| Wan 2.6 i2v | Optional audio input (Venice/OpenRouter) | Unofficial docs | **U** [openrouter](https://openrouter.ai/alibaba/wan-2.6) |
| Seedance 2.0 | Audio reference is a "timing map"; the output **regenerates** audio rather than playing your file | Not verbatim-safe | **U** [seedance2pro blog](https://seedance2pro.io/blog/does-seedance-2-accept-voice-reference) |
| Kling 3.0 (Omni) | Native dialogue in zh/en/ja/ko/es only; voice binding from a 5–30 s sample | **No Ukrainian** | **U** (3p) [kling blog](https://kling.ai/blog/kling-3-subject-binding-character-consistency) |

---

## 2. TTS (Ukrainian + English, emotional)

| Engine | Ukrainian | Emotion control | Cloning / design | Price | Free tier | Status |
|---|---|---|---|---|---|---|
| **ElevenLabs Eleven v3** (also v4 now listed) | Yes, "uk" listed for v3 (70+ langs) | Inline audio tags ([whispers], [angry], [laughs]…); best-known drama delivery | Instant + Pro cloning, Voice Design | **$0.08 / 1k chars** (v4, v3, v2 Multilingual); Flash/Turbo $0.04 | Free plan exists (about 10k credits/mo, **U**) | **V** price [el api pricing](https://elevenlabs.io/pricing/api); UA **V** [el models](https://elevenlabs.io/docs/overview/models); v3 has a 5,000-char cap per request (**U**) |
| Gemini TTS (3.8 Flash / Flash-Lite / 3.1 Flash preview / 2.5 Pro preview) | **Conflicting**: the Gemini API supported-language table does NOT list uk; Cloud TTS Gemini-TTS lists uk-UA GA | `style` metadata per turn + inline tags (`<laugh>`, `<sigh>`); natural-language prompts on Cloud | 30 voices + extended library; up to 2 speakers; no cloning in the API | 3.8 Flash TTS $0.50 in / **$9 per 1M audio tokens** (doubles on 2027-01-01); 3.8 Flash-Lite $6 | **Free tier available** on the Gemini API | **V** [gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), [speech-gen docs](https://ai.google.dev/gemini-api/docs/speech-generation); uk on Cloud **U** [cloud gemini-tts](https://docs.cloud.google.com/text-to-speech/docs/gemini-tts) |
| OpenAI gpt-4o-mini-tts | Not confirmed (Whisper-language coverage suggests yes; **U**); accent tends to be anglicized (**U**) | `instructions` param (tone, emotion) | Preset voices only | $0.60/1M text in, $12/1M audio out (~$0.015/min) | none | **V** price [openai pricing](https://developers.openai.com/api/docs/pricing); no new 2026 TTS endpoint found (GPT-Live/realtime only) |
| Azure Neural TTS | uk-UA-PolinaNeural, uk-UA-OstapNeural (since 2021) | SSML; no `mstts:express-as` styles for uk (**U**) | Custom Neural Voice (gated) | ~$15–16 per 1M chars (**U**) | 0.5M chars/mo F0 (**U**) | voices **V** [ms blog](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/eleven-more-languages-are-generally-available-for-azure-neural-text-to-speech/2236871); the rest **U** |
| Cartesia Sonic 3 / 3.6 | Yes (uk) | Emotion/speed controls, [laughter] tag | Instant cloning (paid plans only) | ~$38–65 per 1M credits (1 credit = 1 char) | 20k credits/mo | **V** [cartesia pricing](https://www.cartesia.ai/pricing); UA **U** (search snippet of [cartesia docs](https://docs.cartesia.ai/build-with-cartesia/tts-models/latest)) |
| Fish Audio S2 / S2.1-Pro (API) | S2 lists Ukrainian with "strong performance"; S2 tech report: **UA WER 2.30%** vs S1 14.49% | Word-level inline tags ([whisper], [excited]) | Strong cloning | **U** | **U** | **U** [S2 report](https://arxiv.org/html/2603.08823v2); S1 deprecated 2026-12-31 |
| Fish S2-Pro / Drama 3 (open weights) | ~100 langs claimed | inline tags | cloning | free; "Fish Audio Research License" (commercial use unclear) | – | **V** [github](https://github.com/fishaudio/fish-speech) |
| Chatterbox Multilingual (MIT) | **No Ukrainian** (23 langs, incl. ru/pl) | exaggeration knob | zero-shot clone | free | – | **U** [resemble](https://resemble.ai/introducing-chatterbox-multilingual-open-source-tts-for-23-languages) |
| XTTS-v2 / Qwen3-TTS / OpenVoice v2 | Ukrainian not supported or unconfirmed | – | – | – | – | **U** |

Verdict: **ElevenLabs v3 is the safe default for UA+EN drama** (verified UA, tags, cloning, $0.08/1k chars, so a 100-char line costs about $0.008). Cartesia Sonic 3.x is a cheap, fast backup for UA. Gemini TTS is cheapest and has a free tier, but Ukrainian is unconfirmed on the Gemini API, so run a test before relying on it. Whatever engine you use, an ASR gate is still needed, because TTS can skip or mangle words, especially with v3 audio tags. Strip tags from the reference text before scoring.

---

## 3. ASR gate (verbatim verification, word timestamps)

| ASR | Ukrainian | Word timestamps | Price | Free tier | Status |
|---|---|---|---|---|---|
| **ElevenLabs Scribe v2** | Yes, in the **"Excellent (≤5% WER)"** tier | Yes (word/spacing/audio_event items) | **$0.22/hr** (realtime $0.39/hr) | via the free plan (**U**) | **V** [el stt docs](https://elevenlabs.io/docs/overview/capabilities/speech-to-text), [el pricing](https://elevenlabs.io/pricing/api) |
| ElevenLabs Forced Alignment | Yes (uk listed) | aligns KNOWN text to audio, giving word/char times | same as STT | – | **V** [el forced alignment](https://elevenlabs.io/docs/overview/capabilities/forced-alignment); fal `fal-ai/elevenlabs/forced-alignment` $0.22/hr rounded up to 1 hr (**U**) |
| **Groq whisper-large-v3** | Yes (Whisper multilingual) | Yes: `timestamp_granularities[]=word` with `response_format=verbose_json` | **$0.111/hr**; turbo $0.04/hr | **Free tier: 20 RPM, 2k RPD, 7.2k audio-s/hr, 28.8k audio-s/day**, 25 MB files | **V** [groq stt](https://console.groq.com/docs/speech-to-text), [groq limits](https://console.groq.com/docs/rate-limits) |
| Whisper large-v3 local (faster-whisper / whisper.cpp / mlx-whisper on Mac) | FLEURS-uk WER ~12.5% (vs Parakeet-v3 5.1%) | Yes (word_timestamps=True; WhisperX for better alignment) | free | – | WER **U** [canary/parakeet paper](https://arxiv.org/pdf/2509.14128) |
| NVIDIA Parakeet-TDT-0.6B-v3 (open, local) | FLEURS-uk **5.10%** | Yes (TDT timestamps) | free | – | **U** (same paper) |
| Deepgram Nova-3 | Yes (`uk` on nova-3 and nova-2) | Yes, standard in the response (**U**) | ~$0.0043/min batch (**U**) | $200 signup credit (**U**) | UA **V** [deepgram langs](https://developers.deepgram.com/docs/models-languages-overview) |
| AssemblyAI Universal-2 / 3.5 Pro | Universal-2 covers 99 langs (uk likely); 3.5 Pro launched with 18 langs | Yes (in the base rate) | $0.15/hr (U-2), $0.21/hr (3.5 Pro) | $50 credit (**U**) | **U** [aai](https://www.assemblyai.com/blog/speech-to-text-api-pricing) |
| OpenAI gpt-4o-transcribe / gpt-transcribe | Yes (**U**) | **No word timestamps** (json/text only); whisper-1 is OpenAI's only timestamp option | $0.006/min; gpt-transcribe $0.0045/min; mini $0.003/min | none | price **V** [openai pricing](https://developers.openai.com/api/docs/pricing); timestamps **V** [openai guide](https://developers.openai.com/api/docs/guides/transcription) |
| Gemini (3.5 Transcribe / Flash audio input) | Yes (**U**) | Timestamps only when prompted; not reliable at word level (**U**) | 3.5 Transcribe ~$0.003/min; Flash audio input from $0.30/1M tokens | **Free tier** | price **V** [gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) |

Caution: modern LLM-style ASR (gpt-4o-transcribe, Gemini) tends to "clean up" speech, which can **hide** a TTS mistake by snapping back to the intended text. A strict gate should use an acoustic ASR (Whisper/Scribe/Parakeet) and should **not** pass the reference line as a prompt or context.

### WER with normalization (implementation recipe)

```python
# pip install jiwer num2words regex
import unicodedata, regex as re, jiwer
from num2words import num2words   # supports lang="uk" and "en"

APOS = "’ʼ`´'"           # Ukrainian apostrophe variants
TAG = re.compile(r"\[[^\]]*\]|<[^>]*>")      # strip v3 / Gemini audio tags

def norm(s: str, lang: str) -> str:
    s = TAG.sub(" ", s)
    s = unicodedata.normalize("NFKC", s).lower()
    s = re.sub(f"[{APOS}]", "'", s)           # unify apostrophes (м'ята)
    s = s.replace("ё", "е")                   # rare noise
    s = re.sub(r"\d+([.,]\d+)?", lambda m: " " + num2words(m.group().replace(",", "."), lang=lang) + " ", s)
    s = re.sub(r"[^\p{L}\p{N}' ]+", " ", s)   # drop punctuation, keep letters/apostrophe
    s = s.replace("-", " ")
    return re.sub(r"\s+", " ", s).strip()

def gate(ref, hyp, lang="uk"):
    r, h = norm(ref, lang), norm(hyp, lang)
    out = jiwer.process_words(r, h)
    return {"wer": out.wer, "cer": jiwer.cer(r, h),
            "subs": out.substitutions, "dels": out.deletions, "ins": out.insertions,
            "pass": out.wer == 0 or (out.wer <= 0.05 and out.deletions == 0 and out.insertions == 0)}
```
- Notes: 1) Numbers: either spell them out in the script before TTS (recommended, since that also controls how they are pronounced) or expand both sides with num2words; Ukrainian case inflection (e.g. "двох" vs "два") makes number expansion lossy, so prefer spelled-out scripts. 2) Whisper's `BasicTextNormalizer` (from `whisper_normalizer`) is fine for non-English but strips apostrophes; `EnglishTextNormalizer` handles EN spellings and numbers. 3) Also compute **CER**: Ukrainian is highly inflected, so a single wrong ending counts as a full word error. 4) For short lines (3–15 words) WER is coarse, so gate on **zero deletions/insertions** plus a substitution check against a small allowlist of homophones (e.g. ASR choosing "щo"/"що" spelling variants). 5) Word timestamps from the same ASR give the subtitle timing (karaoke captions) and the speech window used to trim TTS leading/trailing silence before lip-sync. (num2words `uk` support and the `whisper_normalizer` behavior are from known library behavior, not re-checked: **U**.)

---

## 4. Recommended architecture: "verbatim line guaranteed"

### A. Primary: TTS-first + lip-sync (deterministic words)
```
script line (spell out numbers, stress marks if needed)
  -> TTS (ElevenLabs v3, cloned/designed voice per character, audio tags for emotion)
  -> trim silence, loudness-normalize (-16 LUFS)
  -> ASR GATE #1 (Groq whisper-large-v3 free tier, or Scribe v2; word timestamps)
       fail -> regenerate TTS (new seed / remove tag / rephrase stress) up to N=3
  -> picture:
       (a) acting shot from Flow/Veo 3.1 (silent or with dummy speech, mouth moving, face >~ 1/4 frame)
           -> sync.so lipsync-2-pro (quality) / sync-3 (occlusion, profile) / Kling lipsync on fal (cheapest, $0.014/s)
       (b) or still keyframe -> OmniHuman 1.5 ($0.16/s, best acting) or Kling Avatar v2 ($0.056/s)
  -> mux the ORIGINAL TTS wav (do not trust the re-encoded audio track)
  -> ASR GATE #2 on the final mp4 audio (sanity check) + optional lip-sync score (SyncNet LSE-C/LSE-D, open source) to catch bad mouths
  -> captions from gate word timestamps
```
- The words are deterministic because the audio file is the line. Lip-sync can only fail visually, which you review by eye or with a SyncNet score.
- Cost per 5 s line: TTS ~$0.008 + ASR ~$0 (Groq free) + lip-sync $0.07 (Kling) to $0.40 (sync-2-pro) to $0.80 (OmniHuman). Before spending, dry-run with cached/mock audio (project rule: code first, spend quota last).
- Re-sync requirement: lipsync-2/2-pro need a source clip with visible speaking motion. So prompt Veo/Flow for "character speaking" (any words) so the mouth moves, then re-sync. sync-3 can open closed lips, with generic results.

### B. Alternative: native-audio video model + ASR gate (sampling)
```
Veo 3.1 / Kling 3.0 / Omni Flash prompt with the line in quotes
  -> extract audio -> ASR gate (strict: 0 del/ins, WER<=5%)
  -> fail -> retry (each retry costs $0.40/s on Veo standard, $0.10/s Fast)
```
- Pros: best audiovisual coherence (breath, body, acting) in a single pass. Cons: no guarantee of the words; retries burn credits; **Ukrainian is not officially supported** (Kling 3.0: 5 languages; Seedance: no UA; Veo: no UA evidence found), so expect accent drift.
- Hybrid fallback: if the native clip fails the gate but the acting is good, keep the video, **replace the audio with the gated TTS**, and run it through lip-sync (A.a). This "B, then A on failure" path is a good fit for English lines.

### C. Fully local / zero-spend
Parakeet-v3 or whisper-large-v3 (mlx) for the ASR gate; LatentSync 1.6 or MuseTalk for lip-sync (needs a CUDA GPU; on Mac the speed is impractical, **U**); TTS still needs a cloud engine for good Ukrainian (no verified open-source TTS has strong UA + emotion and a commercial license).

### Decision
- Ukrainian lines: **always A**.
- English lines: B with a gate is acceptable for wide/medium shots, falling back to A.
- Close-up hero lines: A with sync-3 or lipsync-2-pro.

---

## Sources
- sync.so model docs: https://sync.so/docs/models/lipsync ; pricing https://sync.so/pricing
- fal sync lipsync v2: https://fal.ai/models/fal-ai/sync-lipsync/v2
- fal Kling lipsync: https://fal.ai/models/fal-ai/kling-video/lipsync/audio-to-video
- fal Kling Avatar v2: https://fal.ai/models/fal-ai/kling-video/ai-avatar/v2/standard , https://fal.ai/models/fal-ai/kling-video/ai-avatar/v2/pro
- Kling API pricing (didn't render; search snippet): https://kling.ai/dev/pricing
- Kling 3.0 voice binding: https://kling.ai/blog/kling-3-subject-binding-character-consistency
- OmniHuman 1.5 on fal: https://fal.ai/models/fal-ai/bytedance/omnihuman/v1.5/llms.txt , https://fal.ai/learn/devs/omnihuman-15-user-guide
- Hedra Character-3: https://www.hedra.com/develop/models/video/hedra-character-3
- HeyGen Avatar IV: https://openrouter.ai/heygen/avatar-iv
- Captions API pricing: https://captions.ai/help/docs/api/pricing
- Tavus pricing: https://www.tavus.io/pricing
- InfiniteTalk: https://fal.ai/models/fal-ai/infinitalk , https://wavespeed.ai/models/wavespeed-ai/infinitetalk
- Wan S2V: https://fal.ai/models/fal-ai/wan/v2.2-14b/speech-to-video , https://www.alibabacloud.com/help/en/model-studio/wan-s2v-overview/
- Open-source lip-sync comparison: https://instavar.com/research/ai-video/open-source-lip-sync-models ; LatentSync https://arxiv.org/pdf/2412.09262 ; MuseTalk https://arxiv.org/pdf/2410.10122
- Seedance audio reference: https://seedance2pro.io/blog/does-seedance-2-accept-voice-reference
- Gemini/Veo pricing: https://ai.google.dev/gemini-api/docs/pricing ; Veo docs https://ai.google.dev/gemini-api/docs/video
- Gemini Omni Flash model card: https://deepmind.google/models/model-cards/gemini-omni-flash/
- Gemini TTS: https://ai.google.dev/gemini-api/docs/speech-generation ; Cloud Gemini-TTS https://docs.cloud.google.com/text-to-speech/docs/gemini-tts
- ElevenLabs API pricing: https://elevenlabs.io/pricing/api ; models https://elevenlabs.io/docs/overview/models ; STT https://elevenlabs.io/docs/overview/capabilities/speech-to-text ; forced alignment https://elevenlabs.io/docs/overview/capabilities/forced-alignment
- OpenAI pricing: https://developers.openai.com/api/docs/pricing ; transcription guide https://developers.openai.com/api/docs/guides/transcription
- Cartesia pricing: https://www.cartesia.ai/pricing ; models https://docs.cartesia.ai/build-with-cartesia/tts-models/latest
- Fish Audio S2 report: https://arxiv.org/html/2603.08823v2 ; repo https://github.com/fishaudio/fish-speech
- Chatterbox Multilingual: https://resemble.ai/introducing-chatterbox-multilingual-open-source-tts-for-23-languages
- Azure uk-UA voices: https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/eleven-more-languages-are-generally-available-for-azure-neural-text-to-speech/2236871
- Groq STT: https://console.groq.com/docs/speech-to-text ; limits https://console.groq.com/docs/rate-limits
- Deepgram languages: https://developers.deepgram.com/docs/models-languages-overview
- AssemblyAI pricing: https://www.assemblyai.com/blog/speech-to-text-api-pricing
- Ukrainian FLEURS WER (Whisper v3 vs Parakeet v3): https://arxiv.org/pdf/2509.14128

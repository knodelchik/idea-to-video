# AI vertical micro-drama pipelines, video evals and harness engineering (research, 2026-10-16)

Context: test task for HOLYWATER TECH (AI Product Engineer / AI Engineer, agentic pipeline from script to edited video).
Legend: **VERIFIED** = I read the claim on the cited page (or in a search excerpt quoting it). **UNCERTAIN** = secondary source, vendor claim, inference, or page could not be fetched.

---

## 1. What HOLYWATER says publicly about its AI pipeline

| Claim | Status | Source |
|---|---|---|
| The Google Cloud case study says HOLYWATER produces video series "8x faster" with **Gemini, Veo and Nano Banana**. It also claims **10x ARR growth for My Muse** and a 91% completion rate on a two-hour film made with Veo. The agent setup runs on Gemini Enterprise Agent Platform. | VERIFIED via search excerpt (the page is JS-rendered and the full text did not load). The numbers are vendor marketing. | https://cloud.google.com/customers/holywater |
| Vitalii Reshetnyk (Head of My Muse) says early experiments struggled with **consistency and audio sync**, and Veo's native audio was the turning point. | VERIFIED (search excerpt) | same |
| The case study describes a "full-cycle production pipeline" in one workflow, from script analysis to final video. In pre-production, agents read books and build **production bibles** (characters, outfits, locations) and suggest visual details the text leaves out. | UNCERTAIN: the search summary reported it, but the page text was truncated | same |
| The Google AI Studio case study says My Drama used **Veo 3** for generation and **Gemini 2.5 Pro** to produce structured inputs and to extract structured insights from video. The 1M-token context lets Gemini take in whole book series. First pipelines ran within days, and full adoption took under 2 weeks. It claims AI series get up to 22% higher completion than filmed ones and 4-6 new titles per month. | VERIFIED (search excerpt), vendor marketing | https://aistudio.google.com/case-studies/holywater |
| The My Muse launch (Mar 2025) describes the workflow as pre-production → shooting → post. Stories come from My Passion (books) and become scripts and storyboards. Images and animation come from **Midjourney, Flux, Runway, Kling AI**. "AI motion designers" assemble the episode and add VO, sound and VFX. An **in-house tool flags inconsistencies in characters, voices and plot**. | VERIFIED | https://dev.ua/en/news/ukrainska-media-tech-kompaniia-holywater-zapuskaie-platformu-shi-kontentu-yak-my-muse-mozhe-dopomohty-kreatoram-1742483543 |
| TechCrunch (2024) reports that My Drama uses ElevenLabs, Stable Diffusion, OpenAI and Llama 3. This was for AI companions. | VERIFIED (search excerpt), dated | https://techcrunch.com/2024/09/04/short-series-app-my-drama-launching-ai-companions/ |
| In Feb 2026 HOLYWATER acquired **Jeynix**, an AI VFX studio working on face matching/replacement, facial animation, de-aging and **lip-sync**, then rebranded as HOLYWATER TECH. The stated goals are cinematic quality, faster iteration, and localization with dubbing that matches facial expressions. | VERIFIED | https://dev.ua/en/news/holywater-became-holywater-tech-and-acquired-ai-studio-jeynix-to-create-hyper-realistic-effects ; https://www.hollywoodreporter.com/business/business-news/holywater-buys-jeynix-vfx-in-rebranding-ai-microdramas-1236500446/ |
| The job post (AI Product Engineer, Sep 2026) asks for **TypeScript, Nest.js, Next.js, Postgres, Redis, Docker, observability**, with agents built in **LangGraph.js or Mastra**. Other requirements: MCP, tool calling, structured outputs, evals, guardrails, recovery, GraphRAG/Neo4j/vector DB with entity resolution and a shared human+agent knowledge base, and LLM + VLM + video-model orchestration with **automated quality evaluation, visual consistency, iterative regeneration, human-in-the-loop**, async media pipelines, **FFmpeg**. Nice to have: Python, LoRA, PyTorch, GPU, CV, lip-sync, character consistency. The role must integrate new models "on release day" and deliver "idea → finished episode with no manual handoffs". | VERIFIED | https://freehire.me/jobs/ai-engineer-holywater-tech-ajwbp264 ; https://jobgether.com/offer/6ac5cb558a27695aea35f76b-ai-product-engineer |
| The phrase "harness in which agents write code themselves" does not appear in the listings I fetched. It probably comes from the test-task text or another post. | UNCERTAIN | n/a |
| ElevenLabs or ComfyUI in the current pipeline | UNCERTAIN (no current source) | n/a |
| The State of Microdrama 2026 report (with Owl & Co, Jul 2026) says 89% of My Muse users want more AI stories, and paid conversion is 23.6% on My Muse vs 23.9% on My Drama. | VERIFIED (search excerpt), company data | https://www.holywater.tech/blog/holywater-tech-and-owl-co-publish-first-industry-report-on-the-vertical-series-audience |

**Takeaway for the test task.** The public stack is Google-centric: Gemini for script, bible and structured analysis, Veo 3/3.1 for video with native audio, Nano Banana for images and keyframes. It is orchestrated in TypeScript with LangGraph.js or Mastra, and an explicit consistency/QA layer keeps coming up. A submission that mirrors this (bible → shot list → keyframes → i2v → QA → FFmpeg assembly) and swaps vendors behind an adapter matches what they describe.

---

## 2. Other AI micro-drama players

- **ReelShort (Crazy Maple)**: The head of content has said AI stays out of the writers' room, and AI is used for VFX and post. Production is mostly live-action in LA. UNCERTAIN (secondary: https://filmustage.com/blog/short-drama-apps-compared-reelshort-vs-dramabox-in-2026/).
- **DramaBox**: Described as AI-integrated. One claim says the cost per episode of a motion-comic line fell from about $8k to $2k, and a vendor (Storyverse) says it delivered 67 episodes. UNCERTAIN (vendor and secondary).
- **FlexTV / Chinese studios**: MIT Technology Review (May 2026) reports studios mixing **Nano Banana, Seedance, Kling**. New roles include "AI directors" and "**AI asset curators**", who turn scripts into prompts and build **reference images for characters, costumes and scenes**. Teams are about 10 people, and FlexTV estimates an 80-90% cost cut vs a $200k live-action NA drama. VERIFIED: https://www.technologyreview.com/2026/05/15/1137326/chinese-short-dramas-ai/
- **China scale**: CNSA says >95% of 128k ultrashort dramas in Q1 2026 were AI-generated, with production taking under 5 days at about 10% of live-action cost. UNCERTAIN (search summary of Caixin/Sixth Tone/Fortune: https://www.caixinglobal.com/2026-03-17/chinas-short-drama-makers-rush-to-ride-ai-boom-as-production-costs-plunge-102423944.html , https://fortune.com/2026/10/07/ai-entertainment-china-technology/).
- **Model roles reported in practitioner and market maps**: Seedance 2.0 is the most integrated in China, Kling is used for action and fantasy, and Hailuo for character consistency and dialogue. Vidu is also used. UNCERTAIN (https://beginnersinai.org/ai-short-drama-market-map/).
- **Fable / Showrunner**: An Amazon Alexa Fund investment (Jul 2025). Its proprietary **SHOW-2** model (after SHOW-1 and the South Park demo) produces animated episodes only. Users prompt scenes or episodes inside story worlds. VERIFIED: https://variety.com/2025/digital/news/netflix-of-ai-amazon-invests-fable-showrunner-launch-1236471989/
- **Character.AI**: Video quality eval was distilled into a fast Qwen-based VLM (see section 4). VERIFIED: https://www.zenml.io/llmops-database/distilling-video-quality-evaluation-from-committee-of-experts-into-fast-vlm

Common workflow (industry consensus, partly vendor-sourced): **series bible → lock character, outfit and location references → shot list/storyboard → keyframes (image model) → image-to-video per shot (5-10 s) → TTS/native audio + lip-sync → subtitles → 9:16 edit → QA → localization.**

---

## 3. Agentic video-generation frameworks and patterns

| Project | What it is | Key pattern |
|---|---|---|
| **ViMax** (HKUDS), https://github.com/HKUDS/ViMax , arXiv 2606.07649 | A multi-agent system covering director, screenwriter, producer, storyboard and character designer roles | RAG for long scripts. Character and environment state tracked across scene boundaries for visual consistency. **VLM quality control with best-of-k selection**. VERIFIED (search excerpt of paper) |
| **MovieAgent** (showlab), https://github.com/showlab/MovieAgent | Multi-agent CoT planning with director, screenwriter, storyboard artist and location manager | Input is a script plus a **character bank**. Output is multi-scene, multi-shot video with subtitles and audio. Uses Mix-of-Show and LoRA for character identity. VERIFIED |
| **FilmAgent** (HITsz-TMG, SIGGRAPH Asia 2024), https://arxiv.org/pdf/2501.12909 | LLM agents producing film in Unity-like 3D sets | Critique-and-revise loops between roles cut hallucinations. Human eval scored 3.98/5. VERIFIED |
| **"Lights, Camera, Consistency"**, https://arxiv.org/html/2512.16954 | A Gemini → T2I → I2I → Veo pipeline | JSON **blueprint** (style, character sheets, scenes) → character refs → **seed keyframe** per scene (I2I conditioned on refs and the previous scene's last frame) → Veo i2v 8 s clips → concat. Ablations: consistency score 7.99 for the full pipeline, 5.78 without character images, **0.55 without the seed frame**. Metrics are DINO similarity on masked characters, an MLLM judge scoring 0-10, CoTracker, and optical-flow dynamic degree. VERIFIED |
| **LTX Studio** | Commercial storyboard-first studio | "Elements": reusable characters, objects and locations tagged with @Name in shot prompts. Supports LTX-2.x plus partner models (Kling, Veo). VERIFIED (reviews, e.g. https://dupple.com/reviews/ltx-studio) |
| **Google Flow** | Filmmaking UI on Veo | "Ingredients" (reusable subjects and scenes) and **Scenebuilder** to extend shots with consistent characters. VERIFIED: https://blog.google/innovation-and-ai/products/google-flow-veo-ai-filmmaking-tool/ |
| Mora | Earlier multi-agent Sora-style framework | Not re-checked. UNCERTAIN |
| Lists | https://github.com/dg314/awesome-video-agents | |

**Patterns worth copying:**
1. Use a **structured artifact chain** of typed JSON (bible → episode script → shot list with shot_id, duration, camera, characters[], location, dialogue, refs).
2. **Asset-first consistency**: lock reference images before any video and pass them as image conditioning. Text alone is not enough.
3. Generate a **keyframe first, then i2v**. The keyframe anchors identity, and the last frame can seed the next shot.
4. Run **per-shot QA with best-of-k and bounded regeneration**, and escalate to a human after N failures.
5. Keep a **state/continuity tracker** (wardrobe, props, injuries, time of day) across shots and episodes.
6. Put a **provider adapter** between the pipeline and each model so new models can be integrated on release day.

---

## 4. Evaluating AI video quality: what is practical

| Method | What it measures | Practical for a small pipeline? |
|---|---|---|
| **VBench** (16 dims) / **VBench-2.0** (Human Fidelity, Controllability, Creativity, Physics, Commonsense), https://arxiv.org/abs/2503.21755 | Model-level benchmark suites | Not as a full suite. Use them for model selection. Single dimensions are cheap to reuse per clip: subject consistency (DINO), motion smoothness, dynamic degree, aesthetic and imaging quality. Caveat: consistency scores reward static videos, so pair them with dynamic degree. |
| **EvalCrafter** | T2V alignment, motion and quality metrics | Same as VBench: a benchmark, not production QA. |
| **Artificial Analysis Video Arena**, https://artificialanalysis.ai/text-to-video/arena | Human-preference Elo, with T2V, I2V and with-audio boards | Use it to choose models (Veo, Seedance, Kling, Hailuo, etc.), not for per-clip QA. Leaders change month to month. |
| **ArcFace cosine** (insightface) | Face identity vs the character reference, averaged over about 5 sampled frames | **Yes**. Cheap and deterministic. Set a threshold per character. Caveat: weak on stylized or animated faces and blind to copy-paste failures. |
| **DINOv2 / CLIP similarity** on character crops | Identity and costume consistency for non-face cases | Yes |
| **SyncNet LSE-C / LSE-D** | Lip-sync (higher C and lower D are better) | Yes for dialogue shots. Fix the crop and the codec, because scores move by about 0.4 with audio container changes. AV-HuBERT-based alternatives are more robust. |
| **ASR WER** (Whisper) on generated audio vs script line | Dialogue correctness when using native-audio models such as Veo | **Yes**. Cheap and catches wrong or garbled lines. (Standard practice. I found no single canonical paper.) |
| **VLM-as-judge** (Gemini/Claude/Qwen-VL on sampled frames or a clip) | Prompt and shot adherence, continuity, artifacts, anatomy, story beats | **Yes**, with rubric, structured JSON output, deterministic decoding, and calibration against human labels. Prefer **pairwise / best-of-k ranking** over absolute scores (Character.AI lesson). |
| Technical checks (ffprobe) | Duration, resolution 1080x1920, fps, audio present, loudness (EBU R128), black or frozen frames | **Yes**. Cost is near zero and these checks should run first. |

Sources: Character.AI distilled VLM judge (https://www.zenml.io/llmops-database/distilling-video-quality-evaluation-from-committee-of-experts-into-fast-vlm). It scores storytelling, physics, character consistency, pacing and A/V sync, takes about 3 s per 15 s clip, uses **pairwise training** ("go relative, not absolute"), and runs inside the generation loop. SyncNet caveats: https://arxiv.org/html/2405.04327 . Identity leakage metrics: https://arxiv.org/html/2511.08613 . THEval talking-head framework: https://arxiv.org/pdf/2511.04520 . Stanford AI Index 2026 warns that arena ranks partly reflect adaptation to the platform.

**Recommended small QA gate, in order:** ffprobe tech checks → ArcFace/DINO identity vs bible refs → WER on dialogue → (optional) SyncNet on talking shots → VLM rubric judge (shot adherence, continuity, artifacts) → aggregate pass/fail with reasons → regenerate up to k times → human review queue.

---

## 5. Harness engineering / AI-first development

**OpenAI, "Harness engineering: leveraging Codex in an agent-first world"** (Ryan Lopopolo, 2026-02-11, https://openai.com/index/harness-engineering/ ; the page returned 403 to me, so these points come from summaries such as https://businessdatasolutions.github.io/ai-wiki/sources/2026-02-11-lopopolo-codex-harness-engineering and https://www.infoq.com/news/2026/02/openai-harness-engineering-codex ). UNCERTAIN on exact numbers, VERIFIED on the main ideas across several summaries.
- Over about 5 months, roughly 1M LOC and about 1,500 PRs were produced with **0 hand-written lines**, by 3-7 engineers at about 3.5 PRs per engineer per day.
- The **repo is the system of record**. Anything that lives outside it (Docs, Slack, people's heads) does not exist for the agent.
- **AGENTS.md is a ~100-line map**, not an encyclopedia, and points to structured docs (progressive disclosure). A doc-gardening agent fixes stale docs.
- **Legibility**: each worktree runs its own app instance, and the agent reads the UI through Chrome DevTools along with logs, metrics and traces.
- **Mechanically enforced architecture**: layered domains with dependency-direction linters and structural tests, and the linters were themselves written by Codex.
- **Human taste becomes rules**: review comments turn into docs or lint rules. Background "garbage collection" agents open cleanup PRs.
- Merge gates stay light, and agent-to-agent review is the norm. Background: Latent Space interview at https://www.latent.space/p/harness-eng

**Anthropic**
- "Effective harnesses for long-running agents" (Nov 2025), https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents : an **initializer agent** sets up the environment, writes a JSON **feature list** with all items failing, an init script and a progress file. A **coding agent** then does one feature per session, verifies it end to end (browser automation), and commits with a progress note. VERIFIED via summaries.
- "Harness design for long-running application development" (Prithvi Rajasekaran, 2026-03-24), https://www.anthropic.com/engineering/harness-design-long-running-apps . VERIFIED (fetched). It uses **planner → generator → evaluator** roles, GAN-inspired. Before each sprint, the generator and evaluator negotiate a **sprint contract** that defines "done". The evaluator uses Playwright against the running app, grades on criteria with **hard thresholds**, and is calibrated with few-shot examples. Raw models make poor QA agents: they find bugs and then approve the work anyway. Each harness component encodes an assumption about what the model can't do alone, so remove components when a new model ships. In the retro-game example, a solo run (20 min, $9) produced a broken game, and the harness run (6 h, $200) produced a working one.
- Claude Code practices: **CLAUDE.md** for project memory and conventions, **hooks** (PreToolUse/PostToolUse/Stop) for deterministic enforcement such as lint, tests, and blocking edits, subagents for separate review, plan mode and spec files, and headless `claude -p` for CI. Docs: https://code.claude.com/docs/en/hooks , https://www.anthropic.com/engineering/claude-code-best-practices . VERIFIED from general knowledge of the docs; the specific pages were not re-fetched.
- Other sources: https://github.com/ai-boost/awesome-harness-engineering ; Marmelab, "State of AI harness engineering 2026", https://marmelab.com/blog/2026/09/24/the-state-of-ai-harness-engineering-2026.html ; long-running agent loops misjudge stagnation as progress, so verification has to be externally grounded: https://arxiv.org/pdf/2607.25152

**How this applies to the test task (demonstrate both levels):**
1. *Product harness* (the video pipeline). Typed stage contracts (Zod schemas), deterministic orchestration (a LangGraph.js or Mastra-style state graph), idempotent cached steps, a provider adapter, an eval gate per shot with bounded regeneration and human-in-the-loop, and observability (per-step cost, latency, scores).
2. *Dev harness* (how the code was written). A short CLAUDE.md/AGENTS.md map, specs per milestone, hooks running typecheck, lint and tests, dry-run/mock providers so agents can iterate without spending generation credits, golden-file tests on JSON artifacts, an evaluator subagent separate from the writer, and a progress log.

---

## Sources (all accessed 2026-10-16)
- https://cloud.google.com/customers/holywater
- https://aistudio.google.com/case-studies/holywater
- https://dev.ua/en/news/ukrainska-media-tech-kompaniia-holywater-zapuskaie-platformu-shi-kontentu-yak-my-muse-mozhe-dopomohty-kreatoram-1742483543
- https://dev.ua/en/news/holywater-became-holywater-tech-and-acquired-ai-studio-jeynix-to-create-hyper-realistic-effects
- https://www.hollywoodreporter.com/business/business-news/holywater-buys-jeynix-vfx-in-rebranding-ai-microdramas-1236500446/
- https://techcrunch.com/2024/09/04/short-series-app-my-drama-launching-ai-companions/
- https://freehire.me/jobs/ai-engineer-holywater-tech-ajwbp264
- https://jobgether.com/offer/6ac5cb558a27695aea35f76b-ai-product-engineer
- https://www.holywater.tech/blog/holywater-tech-and-owl-co-publish-first-industry-report-on-the-vertical-series-audience
- https://www.tvbizzmagazine.com/holywater-tech-the-rising-star-of-the-vertical-entertainment-industry
- https://www.technologyreview.com/2026/05/15/1137326/chinese-short-dramas-ai/
- https://fortune.com/2026/10/07/ai-entertainment-china-technology/
- https://www.caixinglobal.com/2026-03-17/chinas-short-drama-makers-rush-to-ride-ai-boom-as-production-costs-plunge-102423944.html
- https://filmustage.com/blog/short-drama-apps-compared-reelshort-vs-dramabox-in-2026/
- https://beginnersinai.org/ai-short-drama-market-map/
- https://variety.com/2025/digital/news/netflix-of-ai-amazon-invests-fable-showrunner-launch-1236471989/
- https://github.com/HKUDS/ViMax ; https://arxiv.org/html/2606.07649v1
- https://github.com/showlab/MovieAgent
- https://arxiv.org/pdf/2501.12909 (FilmAgent)
- https://arxiv.org/html/2512.16954 (Lights, Camera, Consistency)
- https://github.com/dg314/awesome-video-agents
- https://blog.google/innovation-and-ai/products/google-flow-veo-ai-filmmaking-tool/
- https://dupple.com/reviews/ltx-studio
- https://arxiv.org/abs/2503.21755 (VBench-2.0)
- https://artificialanalysis.ai/text-to-video/arena
- https://hai.stanford.edu/assets/files/ai_index_report_2026_chapter_2_technical.pdf
- https://www.zenml.io/llmops-database/distilling-video-quality-evaluation-from-committee-of-experts-into-fast-vlm
- https://arxiv.org/html/2405.04327 ; https://arxiv.org/html/2511.08613 ; https://arxiv.org/pdf/2511.04520
- https://openai.com/index/harness-engineering/ ; https://businessdatasolutions.github.io/ai-wiki/sources/2026-02-11-lopopolo-codex-harness-engineering ; https://www.infoq.com/news/2026/02/openai-harness-engineering-codex ; https://www.latent.space/p/harness-eng
- https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- https://www.anthropic.com/engineering/harness-design-long-running-apps
- https://www.anthropic.com/engineering/claude-code-best-practices ; https://code.claude.com/docs/en/hooks
- https://github.com/ai-boost/awesome-harness-engineering
- https://marmelab.com/blog/2026/09/24/the-state-of-ai-harness-engineering-2026.html
- https://arxiv.org/pdf/2607.25152

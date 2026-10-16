2026-10-16 15:45:17 ### F01-contracts start (specs/F01-contracts.md)
2026-10-16 15:45:17 F01-contracts attempt 1: implementer
2026-10-16 15:50:29 F01-contracts attempt 1: gate
2026-10-16 15:50:30 F01-contracts attempt 1: reviewer
2026-10-16 15:52:46 F01-contracts attempt 1: REVIEW FAIL
    - src/verbatim.ts:94 — normalize() removes all Unicode symbols (&, $, %, +, @, #, €, £), not just punctuation. So compareWords("You & me","you me"), compareWords("It's $20","it's twenty") and compareWords("50% off","fifty off") all pass even though a spoken word is missing. This breaks the spec constraint 'a word-level difference must never pass'. Fix: spell these symbols out as words (& → and, $N → N dollars, N% → N percent, ...) or keep them as tokens so a mismatch fails. Add tests for these cases in tests/verbatim.test.ts and record the choice in the specs/F01-contracts.md Decisions section, which now says only that punctuation is dropped.
2026-10-16 15:52:46 F01-contracts attempt 2: implementer
2026-10-16 15:55:43 F01-contracts attempt 2: gate
2026-10-16 15:55:44 F01-contracts attempt 2: reviewer
2026-10-16 15:59:27 F01-contracts PASSED on attempt 2 -> 15856fa
2026-10-16 15:59:27 all requested features passing
2026-10-16 16:04:34 ### F02-mocks-media start (specs/F02-mocks-media.md)
2026-10-16 16:04:34 F02-mocks-media attempt 1: implementer
2026-10-16 16:10:58 F02-mocks-media attempt 1: gate
2026-10-16 16:11:05 F02-mocks-media attempt 1: reviewer
2026-10-16 16:12:18 F02-mocks-media attempt 1: REVIEW FAIL
    - src/providers/mock.ts:219 and :233 — MockLipsync/MockTalking call copyTranscript (plain copyFile of <audio>.transcript.json), so they throw ENOENT when the audio carries only a linkSource `.source.json` or no sidecar (documented as silence). This contradicts the documented sidecar design that MockAsr honours via readTranscript. Fix: `const t = await readTranscript(audio); if (t) await writeTranscript(out, t);` and add a test that lipsyncs linked-source audio.
2026-10-16 16:12:18 F02-mocks-media attempt 2: implementer
2026-10-16 16:18:22 F02-mocks-media attempt 2: gate
2026-10-16 16:18:31 F02-mocks-media attempt 2: reviewer

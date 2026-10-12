# FluidAudio 0.17.5 (vendored)

[FluidAudio](https://github.com/FluidInference/FluidAudio) by FluidInference, Apache-2.0 (LICENSE in this folder),
copied from tag `v0.17.5` (`Sources/` and `Package.swift`; the CLI, tests and the Swift 6.2 manifest are not
vendored, so NeMo text processing is always linked, as the 6.2 manifest's default trait did).

## Changes by TachiNovel (Pocket TTS only)

Marked "TachiNovel" in the code.

- `PocketTtsSynthesizer.AudioFrame.latent`: each session frame also carries the 32-value latent the flow decoder
  produced (before Mimi).
- `PocketTtsSession.setDecodesAudio(_:)`: a session can skip its own Mimi decode and yield latents only.
- `PocketTtsLatentDecoder` (new, `Pipeline/PocketTtsLatentDecoder.swift`) and `PocketTtsManager.makeLatentDecoder()`:
  one Mimi decoder with persistent state, so the latents of several sessions decode as one continuous stream.
- `PocketTtsSynthesizer.EndGuard` and `ChunkEnd` (new, `Pipeline/PocketTtsEndGuard.swift`),
  `PocketTtsSession.setEndGuard(_:levelProbe:)` and `chunkEnds`, `SynthesisResult.chunkEnds`, and an `endGuard:`
  parameter on the synthesize/stream calls (default `.off`: FluidAudio's own stop, unchanged). `.audibleTail` lets a
  chunk still above -40 dBFS at its usual stop run on until it has died away (at most 6 latents) and ignores an
  end-of-speech signal before step 6; a latents-only session gets the levels from a `TailLevelProbe`
  (`PocketTtsSynthesizer.levelProbe(decoder:)`). Every chunk's end is recorded either way.
- `PocketTtsSession.setKeepsPunctuationRuns(_:)`, `PocketTtsManager.plannedChunks(…, keepsPunctuationRuns:)`,
  `chunkTextWithMetadata(…, keepsPunctuationRuns:)` and `splitSentences(…, keepsRuns:)` (default off: FluidAudio's own
  split, unchanged): a run of sentence marks ("...", "?!") ends one sentence, as in Kyutai's pocket_tts
  (text_chunking.py). FluidAudio ends one at every mark, so "Hah... hahh" came back as "Hah. . . hahh" (or a chunk of
  dots) once regrouped. Nephis packs that read the text as written (chain "text": "raw") turn it on.

Why: the Nephis narrator reads each paragraph in its own session (its voice prompt carries the last seconds she
said), and its joins, pauses and clean-ups are done on the latents before any audio exists; decoded per session, every
paragraph started with a cold decoder (an audible thump) and joins could only be spliced as audio.

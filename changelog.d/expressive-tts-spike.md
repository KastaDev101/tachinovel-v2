### Added

- Settings › Voices › "Expressive voices (experimental)" (also in the Voice Lab): expressive voices that act (emotions, laughs and sighs, character
  voices) running on the iPhone, as a test. Chatterbox Nano (Resemble AI, MIT) and NeuTTS-2E (Neuphonic,
  NeuTTS Open License) through FluidAudio's Core ML ports. The models (0.75 GB / 1.37 GB) are never
  bundled: the app downloads one on demand (Wi-Fi only, size shown, two taps, deletable), pinned by
  Hugging Face revision and SHA-256 per file (`ios/expressive-models.lock.json`). Play a sample (calm
  narration, emotional dialogue, a 3-minute passage or pasted text with guessed emotions and speakers)
  with an engine and with Kokoro for an A/B, or run a speed test (load, time to first audio, × real time,
  memory, thermal). Kokoro reads any sentence an expressive engine can't deliver in time, and every
  sentence while the app is in the background (these engines use the GPU). A crash inside an
  experimental engine turns them off after two in a row. Narration itself is unchanged.
- CI: `expressive-bench` (manual, or the `expressive-bench` label on a pull request): the expressive
  engines on the macOS runner with an ASR check and listening samples. docs/expressive-tts.md has the
  research, the numbers and a 5-minute phone checklist.

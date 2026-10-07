import XCTest
@testable import HDVoiceCore

/// Natural delivery, native side: settings, script parsing and clamping, mood refinement, the governor, tempo and
/// varispeed, the clean-warm chain, breaths, speech shaping (gaps, ellipses, sentence timing, rate, roughness),
/// non-verbal packs and the per-unit finish.
final class DeliveryTests: XCTestCase {
    let fs = 24_000

    func sine(_ f: Double, amplitude: Double, seconds: Double) -> [Float] {
        let n = Int(seconds * Double(fs))
        return (0..<n).map { Float(amplitude * sin(2 * Double.pi * f * Double($0) / Double(fs))) }
    }

    func silence(_ seconds: Double) -> [Float] { [Float](repeating: 0, count: Int(seconds * Double(fs))) }

    /// Voiced-speech-like: a buzz with harmonics at `f0`, in syllable-sized bursts.
    func voiced(seconds: Double, level: Double, f0: Double = 150) -> [Float] {
        let n = Int(seconds * Double(fs))
        return (0..<n).map { i in
            let t = Double(i) / Double(fs)
            var s = 0.0
            for h in 1...12 { s += sin(2 * Double.pi * f0 * Double(h) * t) / Double(h) }
            let syllable = 0.55 + 0.45 * sin(2 * Double.pi * 4 * t)
            return Float(level * 0.4 * s * syllable)
        }
    }

    func noise(seconds: Double, level: Float, seed: UInt64) -> [Float] {
        var r = SeededRandom(seed: seed)
        return (0..<Int(seconds * Double(fs))).map { _ in Float(r.unit() * 2 - 1) * level }
    }

    func db(_ x: Double) -> Double { 20 * log10(max(x, 1e-12)) }

    func toneGain(_ make: () -> Biquad, _ f: Double) -> Double {
        var q = make()
        var x = sine(f, amplitude: 0.5, seconds: 1)
        q.process(&x)
        return db(Double(PCM.rms(Array(x[(x.count / 2)...]))) / (0.5 / 2.0.squareRoot()))
    }

    /// Zero crossings per second (2 × the frequency of a sine).
    func zeroCrossingRate(_ x: [Float]) -> Double {
        var n = 0
        for i in 1..<x.count where (x[i - 1] < 0) != (x[i] < 0) { n += 1 }
        return Double(n) / (Double(x.count) / Double(fs))
    }

    // MARK: - Settings and script

    func testSettingsDefaultsAndTolerantDecoding() throws {
        let d = DeliverySettings()
        XCTAssertEqual(d.listenEngine, DeliverySettings.pocketTts, "the Narrator voice (Pocket TTS) reads chapters by default (once downloaded)")
        XCTAssertTrue(d.natural)
        XCTAssertEqual(d.director, DeliverySettings.rules)
        XCTAssertTrue(d.breaths)
        XCTAssertTrue(d.studioSound, "clean-warm is the default chain")
        XCTAssertTrue(d.sounds)
        XCTAssertTrue(d.usesChunks, "breath-group chunks by default, sentences as the fallback")
        let decoded = try JSONDecoder().decode(DeliverySettings.self, from: Data(#"{"version":2,"listenEngine":"chatterbox-nano","director":"rules+ai","natural":false,"unit":"sentences","x":1}"#.utf8))
        XCTAssertEqual(decoded.listenEngine, DeliverySettings.chatterboxNano, "Nano stays an option")
        let v1 = try JSONDecoder().decode(DeliverySettings.self, from: Data(#"{"version":1,"listenEngine":"chatterbox-nano"}"#.utf8))
        XCTAssertEqual(v1.listenEngine, DeliverySettings.pocketTts, "version 1 saved Nano as the default: it moves to Pocket")
        let kokoro = try JSONDecoder().decode(DeliverySettings.self, from: JSONEncoder().encode(DeliverySettings(listenEngine: nil)))
        XCTAssertNil(kokoro.listenEngine, "choosing Kokoro survives a save")
        let pocket = try JSONDecoder().decode(DeliverySettings.self, from: JSONEncoder().encode(DeliverySettings()))
        XCTAssertEqual(pocket, DeliverySettings())
        XCTAssertFalse(decoded.natural)
        XCTAssertFalse(decoded.usesAI, "no director without natural delivery")
        XCTAssertFalse(decoded.usesChunks)
        let junk = try JSONDecoder().decode(DeliverySettings.self, from: Data(#"{"listenEngine":"neutts-2e","director":"llm","unit":"words"}"#.utf8))
        XCTAssertNil(junk.listenEngine)
        XCTAssertEqual(junk.director, DeliverySettings.rules)
        XCTAssertEqual(junk.unit, DeliverySettings.chunks)
        let prefs = try JSONDecoder().decode(VoicePreferences.self, from: Data(#"{"defaultVoice":"am_michael"}"#.utf8))
        XCTAssertEqual(prefs.delivery, DeliverySettings())
        XCTAssertEqual(prefs.defaultVoice, "am_michael")
        XCTAssertTrue(prefs.expressiveListen, "the Narrator voice reads chapters by default (once downloaded)")
    }

    func testParamsParseAndClamp() throws {
        let p = try XCTUnwrap(DeliveryParams.parse(["t": 0.85, "g": 0.6, "s": 0.98, "c": -40, "pre": 150, "nv": "chuckle", "say": "Hi… there.",
                                                    "syl": 3, "ell": [0.4], "pun": [0.4, 1.5]]))
        XCTAssertEqual(p.temperature, 0.85, accuracy: 1e-6)
        XCTAssertEqual(p.gainDB, 0.6)
        XCTAssertEqual(p.tempo, 0.98)
        XCTAssertEqual(p.cents, -40)
        XCTAssertEqual(p.preSeconds, 0.15, accuracy: 1e-9)
        XCTAssertEqual(p.nonVerbal, .chuckle)
        XCTAssertEqual(p.say, "Hi… there.")
        XCTAssertEqual(p.syllables, 3)
        XCTAssertEqual(p.ellipses, [0.4])
        XCTAssertEqual(p.punctuation, [0.4], "shares outside 0…1 are dropped")
        let wild = try XCTUnwrap(DeliveryParams.parse(["t": 3, "g": -40, "s": 0.2, "c": 900, "pre": 5000, "nv": "[laugh]"]))
        XCTAssertEqual(wild.temperature, 1.0)
        XCTAssertEqual(wild.gainDB, -3)
        XCTAssertEqual(wild.tempo, 0.9)
        XCTAssertEqual(wild.cents, 150)
        XCTAssertEqual(wild.preSeconds, 0.5)
        XCTAssertNil(wild.nonVerbal)
        XCTAssertNil(DeliveryParams.parse(["g": 1]), "no temperature: not a delivery object")
        XCTAssertNil(DeliveryParams.parse("x"))
    }

    func testSentenceFromScriptItem() throws {
        let item: [String: Any] = ["text": "Kneel.", "mood": "calm", "line": "commanding", "breath": "paragraph", "role": "dialogue", "chunk": 4,
                                   "delivery": ["t": 0.75, "g": -1, "s": 1, "c": -60]]
        let s = try XCTUnwrap(NaturalSentence.parse(item: item))
        XCTAssertEqual(s.mood, .calm)
        XCTAssertEqual(s.line, "commanding")
        XCTAssertEqual(s.breath, .paragraph)
        XCTAssertEqual(s.chunk, 4)
        XCTAssertTrue(s.speaks)
        XCTAssertNil(NaturalSentence.parse(item: ["text": "x"]), "a script from an older web bundle")
        XCTAssertNil(NaturalSentence.parse(item: ["delivery": ["t": 0.7], "line": "sultry"])?.line)
        let lab = try XCTUnwrap(NaturalSentence.parse(line: ["mood": "whisper", "dialogue": true, "pauseMs": 650, "delivery": ["t": 0.7, "g": -0.7, "s": 0.98]]))
        XCTAssertEqual(lab.sentence.mood, .whisper)
        XCTAssertEqual(lab.pauseSeconds, 0.65, accuracy: 1e-9)
    }

    func testMoodRefinementKeepsTheScriptsAdjustments() {
        let table = MoodTable.standard
        let p = DeliveryParams(temperature: 0.75, gainDB: 0.5, tempo: 1)
        let r = table.refine(p, from: .calm, to: .playful)
        XCTAssertEqual(r.temperature, 0.9, accuracy: 1e-6)
        XCTAssertEqual(r.gainDB, 1.1, accuracy: 1e-9)
        XCTAssertEqual(r.tempo, 1.01, accuracy: 1e-9)
        XCTAssertEqual(table.refine(p, from: .calm, to: .calm), p)
        let custom = MoodTable.parse(["playful": ["t": 0.8, "g": 0, "s": 1]])
        XCTAssertEqual(custom?.entries[.playful]?.temperature, 0.8)
        XCTAssertEqual(custom?.entries[.calm], MoodTable.standard.entries[.calm])
        XCTAssertEqual(Set(MoodTable.standard.entries.keys), Set(DeliveryMood.allCases))
    }

    func testAudioTunablesFromTheScript() {
        let a = DeliveryAudio.parse(["breathDb": -26, "breathEverySec": [5, 9], "breathStartMs": [100, 180], "breathEndMs": [90, 140], "fadeMs": 6,
                                     "speechRmsDb": -19, "rateCap": 0.3, "microGapMs": 100, "ellipsisPauseMs": [300, 400], "nonVerbalGapMs": [90, 210]])
        XCTAssertEqual(a.breathDB, -26)
        XCTAssertEqual(a.breathEverySec, 5...9)
        XCTAssertEqual(a.breathStart.lowerBound, 0.1, accuracy: 1e-9)
        XCTAssertEqual(a.breathEnd.upperBound, 0.14, accuracy: 1e-9)
        XCTAssertEqual(a.fade, 0.006, accuracy: 1e-9)
        XCTAssertEqual(a.speechRmsDB, -19)
        XCTAssertEqual(a.rateCap, 0.1, "never more than ±10 % rate leveling")
        XCTAssertEqual(a.microGap, 0.1, accuracy: 1e-9)
        XCTAssertEqual(a.ellipsisPause.upperBound, 0.4, accuracy: 1e-9)
        XCTAssertEqual(a.nonVerbalGap.lowerBound, 0.09, accuracy: 1e-9)
        let d = DeliveryAudio.parse(nil)
        XCTAssertEqual(d.breathDB, -22, "approved: −22 dB everywhere")
        XCTAssertEqual(DeliveryAudio.parse(["breathDb": 10]).breathDB, -6, "clamped")
    }

    func testGovernorKeepsPlaybackFed() {
        var g = ExpressiveGovernor()
        XCTAssertTrue(g.useExpressive(characters: 60, cushion: nil), "a first sentence is worth a short wait")
        XCTAssertFalse(g.useExpressive(characters: 60, cushion: 1), "not enough audio queued for a 1.5× model")
        XCTAssertTrue(g.useExpressive(characters: 60, cushion: 8))
        XCTAssertTrue(g.chunksKeepUp)
        for _ in 0..<10 { g.record(audioSeconds: 4, synthSeconds: 8) }
        XCTAssertEqual(g.realtime, 0.5, accuracy: 0.05)
        XCTAssertFalse(g.useExpressive(characters: 60, cushion: 8))
        XCTAssertTrue(g.useExpressive(characters: 60, cushion: 30))
        XCTAssertFalse(g.chunksKeepUp, "too slow for chunks: sentence by sentence")
        g.record(audioSeconds: .nan, synthSeconds: 1)
        XCTAssertEqual(g.realtime, 0.5, accuracy: 0.05)
    }

    // MARK: - Tempo and varispeed

    func testWSOLAKeepsPitchAndChangesLength() {
        let x = sine(200, amplitude: 0.3, seconds: 2)
        XCTAssertEqual(TimeStretch.wsola(x, tempo: 1, sampleRate: fs), x, "identity")
        for tempo in [0.9, 0.96, 1.04, 1.1, 1.5] {
            let y = TimeStretch.wsola(x, tempo: tempo, sampleRate: fs)
            XCTAssertEqual(Double(y.count), Double(x.count) / tempo, accuracy: 2, "length at \(tempo)")
            let mid = Array(y[(y.count / 4)..<(3 * y.count / 4)])
            XCTAssertEqual(zeroCrossingRate(mid), 400, accuracy: 12, "pitch kept at \(tempo)")
            XCTAssertEqual(Double(PCM.rms(mid)), 0.3 / 2.0.squareRoot(), accuracy: 0.03, "level kept at \(tempo)")
        }
    }

    func testVarispeedMovesPitchAndPaceTogether() {
        let x = sine(200, amplitude: 0.3, seconds: 2)
        let down = TimeStretch.varispeed(x, cents: -60)
        let ratio = pow(2, -60.0 / 1200)
        XCTAssertEqual(Double(down.count), Double(x.count) / ratio, accuracy: 2, "≈ 3.5 % longer")
        XCTAssertEqual(zeroCrossingRate(Array(down[(down.count / 4)..<(3 * down.count / 4)])), 400 * ratio, accuracy: 6)
        XCTAssertEqual(TimeStretch.varispeed(x, cents: 0), x)
        let both = TimeStretch.apply(x, tempo: 0.98, varispeedCents: -40, sampleRate: fs)
        XCTAssertEqual(Double(both.count), Double(x.count) / 0.98 / pow(2, -40.0 / 1200), accuracy: 4)
    }

    // MARK: - The clean-warm chain

    func testCleanWarmFilters() {
        let f = Double(fs)
        XCTAssertLessThan(toneGain({ .highPass(frequency: 65, q: 0.707, sampleRate: f) }, 20), -15)
        XCTAssertEqual(toneGain({ .lowShelf(frequency: 180, q: 0.707, gainDB: 1.75, sampleRate: f) }, 40), 1.75, accuracy: 0.2)
        XCTAssertEqual(toneGain({ .lowShelf(frequency: 180, q: 0.707, gainDB: 1.75, sampleRate: f) }, 4_000), 0, accuracy: 0.1)
        XCTAssertEqual(toneGain({ .peaking(frequency: 2_500, q: 1, gainDB: 1.5, sampleRate: f) }, 2_500), 1.5, accuracy: 0.1)
        XCTAssertEqual(toneGain({ .lowPass(frequency: 7_000, q: 0.707, sampleRate: f) }, 1_000), 0, accuracy: 0.1)
        XCTAssertLessThan(toneGain({ .lowPass(frequency: 7_000, q: 0.707, sampleRate: f) }, 11_000), -6)
    }

    func testEveryStageCanBeBypassed() {
        var x = voiced(seconds: 0.5, level: 0.2)
        let before = x
        StudioSound.process(&x, params: .bypass, sampleRate: fs)
        XCTAssertEqual(x, before)
    }

    func testLevelMatchingPutsEveryUnitAtTheSameSpeechRMS() {
        for level in [0.04, 0.1, 0.6] {
            var x = voiced(seconds: 1, level: level) + silence(0.5)
            StudioSound.process(&x, params: .levelOnly, sampleRate: fs)
            XCTAssertEqual(db(Double(StudioSound.speechRMS(x, sampleRate: fs))), -20, accuracy: 0.3, "input level \(level)")
        }
        XCTAssertEqual(StudioSound.speechRMS(silence(0.05), sampleRate: fs), 0)
    }

    func testDeEsserTurnsDownLoudSibilanceOnlyAndAtMost4dB() {
        var p = StudioSoundParams.bypass
        p.deess = StudioSoundParams.DeEsser()
        var hiss = sine(7_000, amplitude: 0.5, seconds: 1)
        StudioSound.process(&hiss, params: p, sampleRate: fs)
        let reduction = db(Double(PCM.rms(Array(hiss[(fs / 2)...]))) / (0.5 / 2.0.squareRoot()))
        XCTAssertLessThan(reduction, -2.5)
        XCTAssertGreaterThan(reduction, -4.3)
        var low = sine(300, amplitude: 0.5, seconds: 1)
        StudioSound.process(&low, params: p, sampleRate: fs)
        XCTAssertEqual(db(Double(PCM.rms(Array(low[(fs / 2)...]))) / (0.5 / 2.0.squareRoot())), 0, accuracy: 0.1)
    }

    func testFizzCutIsVoicedOnly() {
        var p = StudioSoundParams.bypass
        p.fizz = StudioSoundParams.Fizz()
        let vowel = zip(sine(300, amplitude: 0.4, seconds: 1), sine(6_000, amplitude: 0.05, seconds: 1)).map { $0 + $1 }
        var cut = vowel
        StudioSound.process(&cut, params: p, sampleRate: fs)
        XCTAssertLessThan(bandLevel(cut, 6_000) - bandLevel(vowel, 6_000), -2)
        var fricative = sine(6_000, amplitude: 0.2, seconds: 1)
        let original = fricative
        StudioSound.process(&fricative, params: p, sampleRate: fs)
        XCTAssertEqual(bandLevel(fricative, 6_000) - bandLevel(original, 6_000), 0, accuracy: 0.3)
    }

    func bandLevel(_ x: [Float], _ f: Double) -> Double {
        var hp = Biquad.highPass(frequency: f * 0.7, q: 0.707, sampleRate: Double(fs))
        var y = Array(x[(x.count / 2)...])
        hp.process(&y)
        return db(Double(PCM.rms(y)))
    }

    func testExpanderOnlyTouchesLowLevels() {
        var p = StudioSoundParams.bypass
        p.expander = StudioSoundParams.Expander()
        var quiet = sine(500, amplitude: pow(10, -62.0 / 20) * 2.0.squareRoot(), seconds: 1) // −62 dBFS RMS
        let q0 = PCM.rms(quiet)
        StudioSound.process(&quiet, params: p, sampleRate: fs)
        let qr = db(Double(PCM.rms(Array(quiet[(fs / 2)...]))) / Double(q0))
        XCTAssertLessThan(qr, -4)
        XCTAssertGreaterThanOrEqual(qr, -6.2, "at most 6 dB")
        var loud = sine(500, amplitude: 0.2, seconds: 1)
        let l0 = PCM.rms(loud)
        StudioSound.process(&loud, params: p, sampleRate: fs)
        XCTAssertEqual(db(Double(PCM.rms(Array(loud[(fs / 2)...]))) / Double(l0)), 0, accuracy: 0.05)
    }

    // MARK: - Breaths

    func testProceduralBreathIsDeterministicShapedAndAsymmetric() {
        let src = ProceduralBreath()
        let a = src.breath(seconds: 0.35, seed: 7, sampleRate: fs)
        XCTAssertEqual(a, src.breath(seconds: 0.35, seed: 7, sampleRate: fs))
        XCTAssertNotEqual(a, src.breath(seconds: 0.35, seed: 8, sampleRate: fs), "randomized per breath")
        XCTAssertEqual(a.count, Int(0.35 * Double(fs)))
        XCTAssertEqual(Double(PCM.rms(a)), 1, accuracy: 0.01, "unit RMS")
        XCTAssertLessThan(abs(a[0]), 0.01)
        XCTAssertLessThan(abs(a[a.count - 1]), 0.01, "smooth edges")
        let q = a.count / 4
        XCTAssertGreaterThan(PCM.rms(Array(a[(2 * q)..<(3 * q)])), PCM.rms(Array(a[0..<q])), "swells, then falls away")
        var lowOnly = a
        var lp = Biquad.lowPass(frequency: 150, q: 0.707, sampleRate: Double(fs))
        lp.process(&lowOnly)
        XCTAssertLessThan(PCM.rms(lowOnly), 0.15, "band-limited")
        XCTAssertTrue((0.28...0.42).contains(src.naturalLength(seed: 3)))
    }

    func testPlannerFollowsTheLungBudgetAndNeverAddsTime() {
        let audio = DeliveryAudio()
        var p = BreathPlanner(audio: audio, seed: 1)
        XCTAssertNil(p.plan(speech: 3, pause: 0.8, point: .sentence, natural: 0.35), "only 3 s of speech")
        let b = p.plan(speech: 6, pause: 0.8, point: .sentence, natural: 0.35)
        XCTAssertNotNil(b)
        if let b {
            XCTAssertGreaterThanOrEqual(b.start, 0.12 - 1e-9)
            XCTAssertGreaterThanOrEqual(0.8 - (b.start + b.length), 0.08 - 1e-9)
            XCTAssertLessThanOrEqual(0.8 - (b.start + b.length), 0.15 + 1e-9)
        }
        XCTAssertEqual(p.sinceBreath, 0)
        XCTAssertNotNil(p.plan(speech: 4.5, pause: 1.0, point: .paragraph, natural: 0.35), "a paragraph start needs only 4 s")
        XCTAssertNil(p.plan(speech: 20, pause: 1.0, point: nil, natural: 0.35), "not a boundary")
        XCTAssertNil(p.plan(speech: 1, pause: 0.3, point: .paragraph, natural: 0.35), "too short a pause: skipped, never stretched")
        var q = BreathPlanner(audio: audio, seed: 2)
        let short = q.plan(speech: 10, pause: 0.5, point: .paragraph, natural: 0.42)
        XCTAssertNotNil(short)
        XCTAssertLessThan(short?.length ?? 1, 0.42, "shortened to fit")
    }

    // MARK: - Speech shaping

    func testBlipsAreDroppedAndMicroGapsOffPunctuationClosed() {
        var x = voiced(seconds: 0.6, level: 0.3) + silence(0.2) + noise(seconds: 0.03, level: 0.3, seed: 1) + silence(0.2) + voiced(seconds: 0.6, level: 0.3)
        SpeechShape.dropBlips(&x, sampleRate: fs, blip: 0.07)
        let start = Int(0.8 * Double(fs))
        XCTAssertTrue(x[start..<(start + Int(0.03 * Double(fs)))].allSatisfy { $0 == 0 }, "the isolated 30 ms blip is gone")
        // A 60 ms gap in the middle of a phrase (no punctuation there) is closed; one at a comma stays.
        var phrase = voiced(seconds: 0.5, level: 0.3) + silence(0.06) + voiced(seconds: 0.5, level: 0.3)
        let before = phrase.count
        XCTAssertEqual(SpeechShape.closeMicroGaps(&phrase, sampleRate: fs, microGap: 0.11, punctuation: [], letters: 20), 1)
        XCTAssertLessThan(phrase.count, before - Int(0.03 * Double(fs)))
        var comma = voiced(seconds: 0.5, level: 0.3) + silence(0.06) + voiced(seconds: 0.5, level: 0.3)
        XCTAssertEqual(SpeechShape.closeMicroGaps(&comma, sampleRate: fs, microGap: 0.11, punctuation: [0.5], letters: 20), 0)
    }

    func testDramaticEllipsisPauseIsStretchedNotSplit() {
        var x = voiced(seconds: 0.8, level: 0.3) + silence(0.12) + voiced(seconds: 0.8, level: 0.3)
        let before = x.count
        XCTAssertEqual(SpeechShape.padEllipses(&x, sampleRate: fs, ellipses: [0.5], target: 0.4), 1)
        XCTAssertEqual(Double(x.count - before) / Double(fs), 0.28, accuracy: 0.02, "the 120 ms pause becomes 400 ms")
        var long = voiced(seconds: 0.8, level: 0.3) + silence(0.6) + voiced(seconds: 0.8, level: 0.3)
        let n = long.count
        SpeechShape.padEllipses(&long, sampleRate: fs, ellipses: [0.5], target: 0.4)
        XCTAssertEqual(long.count, n, "never shortened")
    }

    func testChunkTimingFindsTheSentenceEnds() {
        // Three sentences of 1.0, 0.5 and 1.5 s of speech (letters in the same proportion), with 350 ms pauses and a
        // 60 ms breath gap inside the last one.
        let s1 = voiced(seconds: 1.0, level: 0.3)
        let s2 = voiced(seconds: 0.5, level: 0.3)
        let s3 = voiced(seconds: 0.7, level: 0.3) + silence(0.06) + voiced(seconds: 0.8, level: 0.3)
        let x = s1 + silence(0.35) + s2 + silence(0.35) + s3
        let t = ChunkAligner.align(x, sampleRate: fs, ends: [1.0 / 3.0, 1.5 / 3.0])
        XCTAssertTrue(t.confident)
        XCTAssertEqual(t.cuts.count, 2)
        XCTAssertEqual(Double(t.cuts[0]) / Double(fs), 1.175, accuracy: 0.03)
        XCTAssertEqual(Double(t.cuts[1]) / Double(fs), 2.025, accuracy: 0.03)
        // No pauses at all: proportional cuts, not confident.
        let run = voiced(seconds: 3, level: 0.3)
        let p = ChunkAligner.align(run, sampleRate: fs, ends: [0.5])
        XCTAssertFalse(p.confident)
        XCTAssertEqual(Double(p.cuts[0]) / Double(fs), 1.5, accuracy: 0.1)
        XCTAssertTrue(ChunkAligner.align(run, sampleRate: fs, ends: []).cuts.isEmpty)
    }

    func testRateLevelingTowardTheRunningMedian() {
        var r = RateLeveler(window: 5, band: 0.04, cap: 0.1)
        XCTAssertEqual(r.tempo(syllables: 12, voicedSeconds: 3), 1, "nothing to compare with yet")
        for _ in 0..<4 { _ = r.tempo(syllables: 12, voicedSeconds: 3) } // 4 syllables/s
        XCTAssertEqual(r.target ?? 0, 4, accuracy: 1e-9)
        XCTAssertEqual(r.tempo(syllables: 12, voicedSeconds: 2.95), 1, "inside ±4 %")
        // 4.5 syllables/s: slowed to the band's edge (4.16/s).
        XCTAssertEqual(r.tempo(syllables: 27, voicedSeconds: 6), 4.16 / 4.5, accuracy: 1e-6)
        // 6 syllables/s: slowed, but never more than 10 %.
        XCTAssertEqual(r.tempo(syllables: 18, voicedSeconds: 3), 0.9, accuracy: 1e-9)
        // 2.2 syllables/s: sped up, but never more than 10 %.
        XCTAssertEqual(r.tempo(syllables: 11, voicedSeconds: 5), 1.1, accuracy: 1e-9)
        XCTAssertEqual(r.tempo(syllables: 1, voicedSeconds: 5), 1, "too little to measure")
    }

    func testRoughnessGuardCatchesARoughStretch() {
        let clean = voiced(seconds: 1.5, level: 0.3)
        let r = Roughness.measure(clean, sampleRate: fs)
        XCTAssertGreaterThan(r.median ?? 0, 0.8, "a clean buzz is periodic")
        let rough = voiced(seconds: 0.6, level: 0.3) + noise(seconds: 0.5, level: 0.15, seed: 4) + voiced(seconds: 0.6, level: 0.3)
        let rr = Roughness.measure(rough, sampleRate: fs)
        var g = RoughnessGuard(drop: 0.12)
        XCTAssertFalse(g.isRough(rr), "no history yet")
        for _ in 0..<5 { g.record(r) }
        XCTAssertTrue(g.isRough(rr))
        XCTAssertFalse(g.isRough(r))
        XCTAssertTrue(g.preferRetry(first: rr, retry: r))
    }

    // MARK: - Non-verbals

    func testWAVReaderAndPack() throws {
        let tone = sine(440, amplitude: 0.5, seconds: 0.3)
        let wav = WAV.pcm16(tone, sampleRate: 48_000)
        let read = try XCTUnwrap(WAVReader.read(wav))
        XCTAssertEqual(read.sampleRate, 48_000)
        XCTAssertEqual(read.samples.count, tone.count)
        let resampled = try XCTUnwrap(WAVReader.read(wav, sampleRate: 24_000))
        XCTAssertEqual(resampled.count, tone.count / 2, accuracy: 2)
        XCTAssertNil(WAVReader.read(Data("not a wav file at all, just some text that is long enough".utf8)))

        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("nv-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try WAV.pcm16(voiced(seconds: 0.5, level: 0.2), sampleRate: fs).write(to: dir.appendingPathComponent("chuckle-1.wav"))
        try WAV.pcm16(voiced(seconds: 0.4, level: 0.2, f0: 180), sampleRate: fs).write(to: dir.appendingPathComponent("chuckle-2.wav"))
        try WAV.pcm16(noise(seconds: 0.3, level: 0.05, seed: 2), sampleRate: fs).write(to: dir.appendingPathComponent("breath-1.wav"))
        let manifest: [String: Any] = ["format": "tachinovel-nonverbals", "version": 1, "items": [
            ["file": "chuckle-1.wav", "type": "chuckle"], ["file": "chuckle-2.wav", "type": "chuckle"],
            ["file": "breath-1.wav", "type": "breath"], ["file": "../evil.wav", "type": "laugh"], ["file": "x.wav", "type": "scream"],
        ]]
        try JSONSerialization.data(withJSONObject: manifest).write(to: dir.appendingPathComponent("manifest.json"))
        let pack = try XCTUnwrap(NonVerbalPack.load(directory: dir, sampleRate: fs))
        XCTAssertEqual(pack.items.count, 3, "unsafe names and unknown types are skipped")
        XCTAssertTrue(pack.has(.chuckle))
        XCTAssertFalse(pack.has(.laugh))
        XCTAssertNotNil(pack.breaths)
        // Never the same snippet twice in a row when there's another.
        let first = try XCTUnwrap(pack.pick(.chuckle, seed: 1, avoiding: nil))
        for seed in 0..<10 { XCTAssertNotEqual(pack.pick(.chuckle, seed: UInt64(seed), avoiding: first.index)?.index, first.index) }
        XCTAssertNil(pack.pick(.mm, seed: 1, avoiding: nil))
    }

    func testSpliceMatchesLoudnessWithAGapAndFades() throws {
        let item = NonVerbalPack.Item(type: "chuckle", samples: voiced(seconds: 0.4, level: 0.05), levelDB: 20 * log10(Double(StudioSound.speechRMS(voiced(seconds: 0.4, level: 0.05), sampleRate: fs))))
        let line = voiced(seconds: 1, level: 0.3)
        let out = NonVerbalSplice.splice(item, before: line, sampleRate: fs, gap: 0.12, fade: 0.01, relativeDB: -3)
        let n = item.samples.count
        XCTAssertEqual(out.count, n + Int(0.12 * Double(fs)) + line.count)
        XCTAssertLessThan(abs(out[0]), 1e-3)
        XCTAssertTrue(out[n..<(n + Int(0.12 * Double(fs)))].allSatisfy { $0 == 0 })
        let snippetLevel = db(Double(StudioSound.speechRMS(Array(out[0..<n]), sampleRate: fs)))
        let lineLevel = db(Double(StudioSound.speechRMS(line, sampleRate: fs)))
        XCTAssertEqual(snippetLevel - lineLevel, -3, accuracy: 0.7)
    }

    // MARK: - The finish

    func line(_ params: DeliveryParams? = DeliveryParams(), letters: Int = 30, pause: Double = 0.3, breath: BreathPoint? = nil, seed: UInt64 = 0) -> NaturalFinish.Line {
        NaturalFinish.Line(params: params, letters: letters, pause: pause, breath: breath, seed: seed)
    }

    func testFinishMatchesLevelsAndAddsTheDirectorsGainOnTop() {
        var finish = NaturalFinish(audio: DeliveryAudio(), studioSound: true, breaths: nil, sampleRate: fs)
        let quiet = finish.render(.init(samples: voiced(seconds: 1.2, level: 0.03), lines: [line(nil)], expressive: false))[0].frames
        let loud = finish.render(.init(samples: voiced(seconds: 1.2, level: 0.8), lines: [line(nil)], expressive: false))[0].frames
        let lq = db(Double(StudioSound.speechRMS(quiet, sampleRate: fs)))
        XCTAssertEqual(lq, db(Double(StudioSound.speechRMS(loud, sampleRate: fs))), accuracy: 0.5, "no level jumps between units")
        let lifted = finish.render(.init(samples: voiced(seconds: 1.2, level: 0.03), lines: [line(DeliveryParams(gainDB: 1.2))], expressive: true))[0].frames
        XCTAssertEqual(db(Double(StudioSound.speechRMS(lifted, sampleRate: fs))) - lq, 1.2, accuracy: 0.3)
        XCTAssertLessThanOrEqual(PCM.peak(loud), NaturalFinish.peakCeiling + 1e-6)
    }

    func testAChunkSplitsIntoOneBufferPerSentenceAtItsPauses() {
        var finish = NaturalFinish(audio: DeliveryAudio(), studioSound: false, breaths: nil, sampleRate: fs)
        let x = voiced(seconds: 1.0, level: 0.3) + silence(0.4) + voiced(seconds: 2.0, level: 0.3)
        let pieces = finish.render(.init(samples: x, lines: [line(letters: 10), line(letters: 20, pause: 0.5)], expressive: true))
        XCTAssertEqual(pieces.count, 2)
        XCTAssertTrue(finish.lastReport.confident)
        XCTAssertEqual(pieces[0].speechSeconds, 1.2, accuracy: 0.1, "cut in the middle of the 400 ms pause")
        // The unit's pause comes after the last piece only.
        XCTAssertTrue(pieces[1].frames.suffix(Int(0.49 * Double(fs))).allSatisfy { $0 == 0 })
        for p in pieces {
            XCTAssertLessThan(abs(p.frames.first ?? 1), 1e-3)
            XCTAssertLessThan(abs(p.frames.last ?? 1), 1e-3)
        }
    }

    func testFinishNeverClicksAtModelCallJoins() {
        var finish = NaturalFinish(audio: DeliveryAudio(), studioSound: false, breaths: nil, sampleRate: fs)
        let a = sine(220, amplitude: 0.5, seconds: 0.6)
        let b = sine(330, amplitude: 0.5, seconds: 0.6)
        let out = finish.render(.init(samples: a + b, chunkEnds: [a.count], lines: [line(DeliveryParams(preSeconds: 0.15))], expressive: true))[0].frames
        var maxJump: Float = 0
        for i in 1..<out.count { maxJump = max(maxJump, abs(out[i] - out[i - 1])) }
        XCTAssertLessThan(maxJump, 0.2, "no discontinuities at joins or edges")
        XCTAssertTrue(out[0..<Int(0.15 * Double(fs))].allSatisfy { $0 == 0 }, "the director's silence before a sound effect")
    }

    func testBreathsSitInsideThePauseAtTheirLevel() {
        var finish = NaturalFinish(audio: DeliveryAudio(), studioSound: true, breaths: ProceduralBreath(), sampleRate: fs, seed: 9)
        var placed = 0
        for k in 0..<6 {
            let pauseSeconds = 0.9
            let pieces = finish.render(.init(samples: voiced(seconds: 2.5, level: 0.2), lines: [line(nil, pause: pauseSeconds, breath: .sentence, seed: UInt64(k))],
                                             expressive: false))
            let out = pieces[0].frames
            let pauseFrames = Int(pauseSeconds * Double(fs))
            let tail = Array(out.suffix(pauseFrames))
            let speechPart = Array(out.prefix(out.count - pauseFrames))
            if PCM.peak(tail) > 0 {
                placed += 1
                XCTAssertTrue(tail.prefix(Int(0.119 * Double(fs))).allSatisfy { $0 == 0 }, "not right after the release")
                XCTAssertTrue(tail.suffix(Int(0.079 * Double(fs))).allSatisfy { $0 == 0 }, "not right before the next onset")
                let rel = db(Double(PCM.rms(tail.filter { $0 != 0 })) / Double(StudioSound.speechRMS(speechPart, sampleRate: fs)))
                XCTAssertEqual(rel, -22, accuracy: 4, "about 22 dB under the speech")
            }
        }
        XCTAssertGreaterThanOrEqual(placed, 1)
        XCTAssertLessThanOrEqual(placed, 3, "a breath every few units, not every pause")
        XCTAssertEqual(finish.breathsPlaced, placed)
    }

    func testANonVerbalGoesInFrontOfItsLine() {
        var finish = NaturalFinish(audio: DeliveryAudio(), studioSound: false, breaths: nil, sampleRate: fs)
        let snippet = NonVerbalPack.Item(type: "chuckle", samples: voiced(seconds: 0.4, level: 0.1, f0: 220), levelDB: -24)
        let plain = finish.render(.init(samples: voiced(seconds: 1, level: 0.3), lines: [line()], expressive: true))[0].frames
        let with = finish.render(.init(samples: voiced(seconds: 1, level: 0.3), lines: [line()], expressive: true, nonVerbals: [0: snippet]))[0].frames
        XCTAssertGreaterThan(with.count - plain.count, Int(0.4 * Double(fs) + 0.07 * Double(fs)))
    }
}

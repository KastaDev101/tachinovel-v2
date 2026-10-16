import CoreML
import ExpressiveCore
import XCTest

/// The crash plan's guards that need no model (NephisGuards.swift; 2026-10-12, build 321 closed by iOS for memory during
/// the Voice test): how much free memory each load needs and the refusal in words, the wait after a memory warning, the
/// release a load still running must see, model outputs read whatever their type and layout, the blueprint's shape.
final class NephisGuardsTests: XCTestCase {
    // MARK: - Free memory (crash plan a1, a4, b1)

    func testRefusalThresholds() {
        // Build 321 before the test: 226 MB free. The studio test needs ~1,000 MB.
        XCTAssertTrue(NephisMemory.short(.studioTest, freeMB: 226))
        XCTAssertTrue(NephisMemory.short(.studioTest, freeMB: 999))
        XCTAssertFalse(NephisMemory.short(.studioTest, freeMB: 1_000))
        // Nephis (Pocket): ~700 MB, studio or not (her studio's models load behind hers with their own check).
        XCTAssertFalse(NephisMemory.short(.nephis, freeMB: 1_100))
        XCTAssertTrue(NephisMemory.short(.nephis, freeMB: 650))
        XCTAssertFalse(NephisMemory.short(.nephis, freeMB: 2_400))
        // Her studio on a call: loads with ~1,000 MB free, dropped under ~500 MB.
        XCTAssertTrue(NephisMemory.short(.studioLoad, freeMB: 900))
        XCTAssertFalse(NephisMemory.short(.studioLoad, freeMB: 1_500))
        XCTAssertTrue(NephisMemory.short(.studioKeep, freeMB: 480))
        XCTAssertFalse(NephisMemory.short(.studioKeep, freeMB: 520))
        // Unknown free memory (the simulator, a Mac: os_proc_available_memory says 0) never refuses.
        for need in [NephisMemory.Need.studioTest, .nephis, .studioLoad, .studioKeep] {
            XCTAssertFalse(NephisMemory.short(need, freeMB: nil))
            XCTAssertFalse(NephisMemory.short(need, freeMB: 0))
        }
    }

    func testRefusalsInPlainWords() {
        XCTAssertEqual(NephisMemory.refusal(.studioTest, freeMB: 226.4),
                       "Not enough memory for the studio test: 226 MB free, it needs about 1,000 MB. Swipe TachiNovel away, open it again and run the test.")
        XCTAssertEqual(NephisMemory.refusal(.nephis, freeMB: 640),
                       "Not enough memory to load Nephis: 640 MB free, she needs about 700 MB. Another voice reads meanwhile.")
        XCTAssertTrue(NephisMemory.refusal(.nephis, freeMB: 1_049.6).hasPrefix("Not enough memory to load Nephis: 1,050 MB free"))
        // Her studio's own go into her call log as bypass reasons, counted under "memory".
        XCTAssertEqual(NephisMemory.refusal(.studioKeep, freeMB: 480), "memory: 480 MB free")
        XCTAssertEqual(NephisMemory.refusal(.studioLoad, freeMB: 812), "memory: 812 MB free, her studio needs about 1,000 MB")
        XCTAssertTrue(NephisMemory.refusal(.studioKeep, freeMB: 3_376).hasPrefix("memory: 3,376 MB"))
    }

    // MARK: - The wait after a memory warning (crash plan a4)

    func testTheWaitAfterAMemoryWarningBacksOff() {
        var hold = MemoryHold(base: 60, cap: 300)
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertFalse(hold.holds(at: t0), "nothing released yet")
        XCTAssertEqual(hold.remaining(at: t0), 0)
        XCTAssertEqual(hold.release(at: t0), 60)
        XCTAssertTrue(hold.holds(at: t0.addingTimeInterval(59)))
        XCTAssertEqual(hold.remaining(at: t0.addingTimeInterval(20)), 40, accuracy: 0.001)
        XCTAssertFalse(hold.holds(at: t0.addingTimeInterval(60)), "over by itself, even if its timer is late")
        // Again before she worked: twice as long each time, at most the cap.
        XCTAssertEqual(hold.release(at: t0), 120)
        XCTAssertEqual(hold.release(at: t0), 240)
        XCTAssertEqual(hold.release(at: t0), 300)
        XCTAssertEqual(hold.release(at: t0), 300)
        XCTAssertEqual(hold.releases, 5)
        // The timer fired: she may load at once.
        hold.lift()
        XCTAssertFalse(hold.holds(at: t0))
        // Started over at once: the next release waits the shortest time.
        hold.reset()
        XCTAssertEqual(hold.release(at: t0), 60)
        // The defaults mirror Kokoro's ReloadBackoff: 60 s, up to 10 minutes.
        var kokoroLike = MemoryHold()
        XCTAssertEqual(kokoroLike.release(at: t0), 60)
        for _ in 0..<40 { kokoroLike.release(at: t0) }
        XCTAssertEqual(kokoroLike.release(at: t0), 600, "capped, never overflowing")
    }

    func testTheCountStartsOverOnlyAfterSheWorkedAWhile() {
        var hold = MemoryHold(base: 60, cap: 600, calm: 300)
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        hold.worked(at: t0)
        XCTAssertEqual(hold.releases, 0, "nothing to start over")
        XCTAssertEqual(hold.release(at: t0), 60)
        // Reloaded after the wait and reading again: her first calls don't start the count over, so a warning soon
        // after waits twice as long (a phone near its limit isn't reloaded every minute).
        hold.lift()
        hold.worked(at: t0.addingTimeInterval(70))
        hold.worked(at: t0.addingTimeInterval(299))
        XCTAssertEqual(hold.releases, 1)
        XCTAssertEqual(hold.release(at: t0.addingTimeInterval(299)), 120)
        XCTAssertEqual(hold.lastRelease, t0.addingTimeInterval(299))
        // Five minutes of work since the last release: the next one waits the shortest time again.
        hold.lift()
        hold.worked(at: t0.addingTimeInterval(299 + 300))
        XCTAssertEqual(hold.releases, 0)
        XCTAssertEqual(hold.release(at: t0.addingTimeInterval(700)), 60)
        // The default: five minutes.
        XCTAssertEqual(MemoryHold().calm, 300)
    }

    // MARK: - A release during a load (crash plan a3)

    func testALoadThatOutlivesAReleaseKeepsNothing() {
        var generation = LoadGeneration()
        // A load starts, nothing happens: it keeps what it made.
        let first = generation.ticket
        XCTAssertTrue(generation.current(first))
        // Released while it loads: it keeps nothing, whenever it finishes.
        generation.release()
        XCTAssertFalse(generation.current(first))
        // The next load is wanted; a second release drops it too, and never brings the first back.
        let second = generation.ticket
        XCTAssertNotEqual(first, second)
        XCTAssertTrue(generation.current(second))
        generation.release()
        XCTAssertFalse(generation.current(second))
        XCTAssertFalse(generation.current(first))
        // Two loads started between the same releases share the ticket (the second waits for the first's load).
        let a = generation.ticket, b = generation.ticket
        XCTAssertEqual(a, b)
    }

    // MARK: - Model outputs (crash plan a5)

    func testFloatsFromAFloat16Output() throws {
        // Her studio's models output Float16.
        let a = try MLMultiArray(shape: [1, 2, 3], dataType: .float16)
        for i in 0..<6 { a[i] = NSNumber(value: Float(i) * 0.5 - 1) }
        XCTAssertEqual(ModelOutput.floats(a), [-1, -0.5, 0, 0.5, 1, 1.5])
    }

    func testFloatsFromFloat32AndDoubleOutputs() throws {
        let f = try MLMultiArray(shape: [4], dataType: .float32)
        let d = try MLMultiArray(shape: [2, 2], dataType: .double)
        for i in 0..<4 {
            f[i] = NSNumber(value: Float(i) + 0.25)
            d[i] = NSNumber(value: Double(i) - 0.75)
        }
        XCTAssertEqual(ModelOutput.floats(f), [0.25, 1.25, 2.25, 3.25])
        XCTAssertEqual(ModelOutput.floats(d), [-0.75, 0.25, 1.25, 2.25])
    }

    func testFloatsFollowTheOutputsStrides() throws {
        // Rows padded to 4 (as the Neural Engine lays some outputs out): the padding is never read as audio.
        let p = UnsafeMutablePointer<Float>.allocate(capacity: 8)
        p.initialize(from: [1, 2, 3, -99, 4, 5, 6, -99], count: 8)
        let a = try MLMultiArray(dataPointer: p, shape: [2, 3], dataType: .float32, strides: [4, 1]) { $0.deallocate() }
        XCTAssertEqual(ModelOutput.floats(a), [1, 2, 3, 4, 5, 6])
    }

    // MARK: - The blueprint's output shape (crash plan a5)

    func testTheBlueprintsMelShapeIsChecked() {
        // [1, bands, frames]; its own framing may be a frame or two off ours (re-packed then).
        XCTAssertEqual(NephisFlow.studioMelFrames(shape: [1, 128, 200], count: 128 * 200, bands: 128, frames: 200), 200)
        XCTAssertEqual(NephisFlow.studioMelFrames(shape: [1, 128, 201], count: 128 * 201, bands: 128, frames: 200), 201)
        XCTAssertEqual(NephisFlow.studioMelFrames(shape: [128, 199], count: 128 * 199, bands: 128, frames: 200), 199)
        // Anything else would be read past or as the wrong numbers: refused (the call plays her plain sound).
        XCTAssertNil(NephisFlow.studioMelFrames(shape: [1, 128, 0], count: 0, bands: 128, frames: 200), "no frames")
        XCTAssertNil(NephisFlow.studioMelFrames(shape: [1, 200, 128], count: 128 * 200, bands: 128, frames: 200), "transposed")
        XCTAssertNil(NephisFlow.studioMelFrames(shape: [1, 128, 120], count: 128 * 120, bands: 128, frames: 200), "far too short")
        XCTAssertNil(NephisFlow.studioMelFrames(shape: [1, 128, 200], count: 128 * 199, bands: 128, frames: 200), "fewer numbers than the shape")
        XCTAssertNil(NephisFlow.studioMelFrames(shape: [2, 128, 200], count: 2 * 128 * 200, bands: 128, frames: 200), "a batch of two")
        XCTAssertNil(NephisFlow.studioMelFrames(shape: [25_600], count: 25_600, bands: 128, frames: 200), "flat")
        XCTAssertNil(NephisFlow.studioMelFrames(shape: [1, 128, 200], count: 128 * 200, bands: 128, frames: 0), "nothing asked for")
    }

    // MARK: - Her studio against the clock (2026-10-13: a studio Voice test played nothing for over a minute)

    func testACallsPaceIsProjectedFromItsPiecesSoFar() {
        // 10 s of audio, 1 s before the vocoder, 2 of 8 pieces in 3 s: 1 + 3 + 9 = 13 s for 10 s of audio.
        XCTAssertEqual(StudioPace.projected(audioMs: 10_000, fixedMs: 1_000, piecesMs: 3_000, done: 2, pieces: 8), 10.0 / 13, accuracy: 1e-9)
        // Before any piece only the work so far counts (the best the call can still do).
        XCTAssertEqual(StudioPace.projected(audioMs: 4_000, fixedMs: 8_000, piecesMs: 0, done: 0, pieces: 6), 0.5, accuracy: 1e-9)
        // Every piece done: what it took.
        XCTAssertEqual(StudioPace.projected(audioMs: 6_000, fixedMs: 500, piecesMs: 2_500, done: 5, pieces: 5), 2, accuracy: 1e-9)
        // Nothing measured yet never divides by zero.
        XCTAssertEqual(StudioPace.projected(audioMs: 3_000, fixedMs: 0, piecesMs: 0, done: 0, pieces: 4), 3_000)
        // Under real time is too slow for Listen; real time itself keeps up.
        XCTAssertTrue(StudioPace.tooSlow(0.99))
        XCTAssertFalse(StudioPace.tooSlow(1.0))
        XCTAssertFalse(StudioPace.tooSlow(4.2))
    }

    func testThreeSlowCallsInARowSwitchTheStudioOffForTheSession() {
        var pace = StudioPace()
        XCTAssertNil(pace.record(0.4))
        XCTAssertNil(pace.record(0.6))
        // A call that kept up starts the count over.
        XCTAssertNil(pace.record(1.3))
        XCTAssertEqual(pace.slowInARow, 0)
        XCTAssertNil(pace.record(0.5))
        XCTAssertNil(pace.record(0.45))
        XCTAssertEqual(pace.record(0.4), "studio too slow: 0.4x real time")
        XCTAssertEqual(pace.slowInARow, StudioPace.dropAfter)
        XCTAssertEqual(StudioPace.words(0.04), "0.04x real time")
        XCTAssertEqual(StudioPace.words(2.26), "2.3x real time")
    }

    // MARK: - Her studio on every call it can afford (2026-10-15: build 363 skipped it on 3 of 6 calls at 23-47x)

    func testAFastStudioIsUsedOnTheFirstCallAndWithLittleBuffered() {
        var budget = StudioBudget()
        budget.record(23.2)  // build 363's slowest studio call on the iPhone 16
        XCTAssertEqual(budget.estimateX, 23.2)
        // The first call of a read (nothing buffered): one sentence, ~3.3 s of audio, ~0.14 s of studio work.
        XCTAssertEqual(budget.cost(characters: 40), 40.0 / 12 / 23.2, accuracy: 1e-9)
        XCTAssertTrue(budget.use(characters: 40, ahead: 0, throttled: false))
        // 2 s buffered, a ~12.5 s call: ~0.54 s of studio, within half of the 2 s.
        XCTAssertTrue(budget.use(characters: 150, ahead: 2, throttled: false))
        // The same call with almost nothing buffered would hold playback longer than allowed: her plain sound, as before.
        XCTAssertFalse(budget.use(characters: 150, ahead: 0.3, throttled: false))
        // A cushion: the studio whatever it costs (the rule before).
        XCTAssertTrue(budget.use(characters: 400, ahead: StudioBudget.cushion, throttled: false))
        // Faster calls raise the estimate a share of the way; a slower one sets it at once.
        budget.record(46.5)
        XCTAssertEqual(budget.estimateX, 23.2 + (46.5 - 23.2) * StudioBudget.riseShare, accuracy: 1e-9)
        budget.record(9)
        XCTAssertEqual(budget.estimateX, 9)
        // Nonsense measurements are ignored.
        budget.record(0)
        budget.record(.nan)
        budget.record(.infinity)
        XCTAssertEqual(budget.estimateX, 9)
    }

    func testBeforeAnyMeasurementTheConservativeGuessStillTakesAShortFirstCall() {
        let budget = StudioBudget()
        XCTAssertNil(budget.measuredX)
        XCTAssertEqual(budget.estimateX, StudioBudget.seedX)
        // ~3.3 s of audio at the guessed 8x: ~0.42 s, within the first call's 0.5 s.
        XCTAssertTrue(budget.use(characters: 40, ahead: 0, throttled: false))
        // ~6.7 s at 8x is ~0.83 s: too long a wait before her first audio...
        XCTAssertFalse(budget.use(characters: 80, ahead: 0, throttled: false))
        // ...but fine with 5 s buffered.
        XCTAssertTrue(budget.use(characters: 80, ahead: 5, throttled: false))
        XCTAssertEqual(StudioBudget(rememberedX: 0).estimateX, StudioBudget.seedX)
        XCTAssertEqual(StudioBudget(rememberedX: .nan).estimateX, StudioBudget.seedX)
        XCTAssertEqual(StudioBudget(rememberedX: .nan).source, .guess)
    }

    // MARK: - Her studio on the first calls of a fresh pack (2026-10-16: build 375 skipped calls 1 and 2 as "hurry")

    func testAFreshPackGetsItsStudioOnCalls1And2WithTheSpeedMeasuredAtLoad() {
        // Build 375: a fresh pack planned with the 8x guess, so call 1 (99 characters) cost ~1.0 s and call 2 (146) ~1.5 s,
        // both over the 0.5 s allowed with nothing buffered.
        let old = StudioBudget()
        XCTAssertFalse(old.use(characters: 99, ahead: 0, throttled: false))
        XCTAssertFalse(old.use(characters: 146, ahead: 0, throttled: false))
        // Now: the first call of a read always gets it (the phone not throttled, the studio not slow)...
        XCTAssertTrue(old.use(characters: 99, ahead: 0, throttled: false, first: true))
        // ...and the speed measured as the studio loaded plans call 2 (~12 s of audio at 31x: ~0.39 s).
        var budget = StudioBudget(fastVocoder: true)
        XCTAssertEqual(budget.source, .guess)
        budget.measuredAtLoad(31.2)
        XCTAssertEqual(budget.source, .measuredAtLoad)
        XCTAssertEqual(budget.estimateX, 31.2)
        XCTAssertTrue(budget.use(characters: 99, ahead: 0, throttled: false, first: true))
        XCTAssertTrue(budget.use(characters: 146, ahead: 0, throttled: false))
        // Her calls measure it from then on; the load's measurement never overrides them.
        budget.record(40)
        XCTAssertEqual(budget.source, .calls)
        let afterCalls = budget.estimateX
        budget.measuredAtLoad(10)
        XCTAssertEqual(budget.estimateX, afterCalls)
        XCTAssertEqual(budget.source, .calls)
        // Nonsense is ignored.
        var guess = StudioBudget()
        guess.measuredAtLoad(.nan)
        guess.measuredAtLoad(0)
        XCTAssertEqual(guess.source, .guess)
    }

    func testTheGuessForTheFastPhoneVocoderIs25x() {
        XCTAssertTrue(StudioBudget.isFastVocoder("NephisVocoderFast"))
        XCTAssertFalse(StudioBudget.isFastVocoder("NephisVocoder8"))
        XCTAssertFalse(StudioBudget.isFastVocoder(nil))
        XCTAssertEqual(StudioBudget(fastVocoder: true).estimateX, 25)
        XCTAssertEqual(StudioBudget(fastVocoder: false).estimateX, StudioBudget.seedX)
        // Even before the measurement, call 2 of build 375's test (146 characters, ~12.2 s) fits at 25x: ~0.49 s.
        XCTAssertTrue(StudioBudget(fastVocoder: true).use(characters: 146, ahead: 0, throttled: false))
    }

    func testTheSavedSpeedIsUsedAtLaunchAsItWasUnlessThePhoneIsWarm() {
        let cool = StudioBudget(rememberedX: 40, fastVocoder: true)
        XCTAssertEqual(cool.estimateX, 40)
        XCTAssertEqual(cool.source, .saved)
        XCTAssertTrue(cool.use(characters: 146, ahead: 0, throttled: false))
        // A warm phone now (fair heat or more): half of it.
        let warm = StudioBudget(rememberedX: 40, fastVocoder: true, warm: true)
        XCTAssertEqual(warm.estimateX, 20)
        XCTAssertEqual(warm.source, .saved)
        // A measurement at load (only when nothing was saved) replaces a saved speed too.
        var replaced = cool
        replaced.measuredAtLoad(30)
        XCTAssertEqual(replaced.estimateX, 30)
    }

    func testAThrottledOrSlowStudioKeepsTheOldRuleOnTheFirstCallToo() {
        var fast = StudioBudget()
        fast.measuredAtLoad(40)
        // Hot or Low Power Mode: only with the cushion, the first call included.
        XCTAssertFalse(fast.use(characters: 20, ahead: 0, throttled: true, first: true))
        XCTAssertTrue(fast.use(characters: 20, ahead: StudioBudget.cushion, throttled: true, first: true))
        // Measured under 4x (an older phone): the old rule, the first call included.
        var slow = StudioBudget(fastVocoder: true)
        slow.measuredAtLoad(3.5)
        XCTAssertFalse(slow.use(characters: 20, ahead: 0, throttled: false, first: true))
        XCTAssertFalse(slow.use(characters: 20, ahead: 5.9, throttled: false, first: true))
        XCTAssertTrue(slow.use(characters: 400, ahead: 6, throttled: false, first: true))
        // A studio that ran slow on a call (StudioPace's projection) falls back at once, first call or not.
        fast.record(0.8)
        XCTAssertFalse(fast.use(characters: 20, ahead: 0, throttled: false, first: true))
    }

    func testTheMeasuringRunIsOnePieceOfSilenceAndSkipsAHotPhone() {
        // Her studio (studio.json: 128 kept frames of 512 samples at 44.1 kHz): 17 latents, 1.36 s.
        let n = StudioBudget.measureLatents(chunkFrames: 128, hop: 512, sampleRate: 44_100)
        XCTAssertEqual(n, 17)
        // With the studio's 50 ms of end padding it fills one vocoder piece and isn't padded up to the blueprint's minimum.
        let samples = Int((Double(n * NephisFlow.samplesPerLatent + 1_200) * 44_100 / 24_000).rounded())
        let frames = NephisFlow.studioFrames(samples: samples, hop: 512)
        XCTAssertLessThanOrEqual(frames, 128)
        XCTAssertGreaterThanOrEqual(frames, NephisFlow.studioMinFrames)
        XCTAssertEqual(StudioBudget.measureLatents(chunkFrames: 0, hop: 512, sampleRate: 44_100), 1)
        // Nominal or fair: measure; serious or critical heat, or Low Power Mode: not.
        XCTAssertTrue(StudioBudget.mayMeasure(thermal: 0, lowPower: false))
        XCTAssertTrue(StudioBudget.mayMeasure(thermal: 1, lowPower: false))
        XCTAssertFalse(StudioBudget.mayMeasure(thermal: 2, lowPower: false))
        XCTAssertFalse(StudioBudget.mayMeasure(thermal: 0, lowPower: true))
    }

    func testASlowOrThrottledStudioIsSkippedAsBefore() {
        var slow = StudioBudget()
        slow.record(2)
        // Under `fastFrom`: only with the cushion, whatever the call costs.
        XCTAssertFalse(slow.use(characters: 20, ahead: 0, throttled: false))
        XCTAssertFalse(slow.use(characters: 20, ahead: 5.9, throttled: false))
        XCTAssertTrue(slow.use(characters: 400, ahead: 6, throttled: false))
        // A fast studio on a hot or low-power phone: the old rule too.
        var fast = StudioBudget()
        fast.record(40)
        XCTAssertFalse(fast.use(characters: 20, ahead: 0, throttled: true))
        XCTAssertFalse(fast.use(characters: 20, ahead: 5, throttled: true))
        XCTAssertTrue(fast.use(characters: 20, ahead: 6, throttled: true))
        // A fast studio that turns slow (heat): skipped at once on the next short-of-audio call.
        fast.record(1.5)
        XCTAssertFalse(fast.use(characters: 20, ahead: 3, throttled: false))
        // The new rule never skips a call the old one gave the studio.
        for x in [0.5, 2.0, 8.0, 40.0] {
            var b = StudioBudget()
            b.record(x)
            for chars in [1, 40, 400] {
                for ahead in [6.0, 9.0, 60.0] {
                    for hot in [false, true] { XCTAssertTrue(b.use(characters: chars, ahead: ahead, throttled: hot)) }
                }
            }
        }
    }

    // MARK: - The "Her studio" switch, on by default per pack (2026-10-15)

    func testTheStudioSwitchIsOnByDefaultAndKeepsAnExplicitOffPerPack() throws {
        let suite = "NephisStudioSwitchTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        // Never set: on. The old single setting left off (build 363's phone) no longer turns it off.
        defaults.set(false, forKey: "nephisStudio")
        XCTAssertTrue(NephisStudioSwitch.isOn(pack: "p0123456789abcdef", defaults: defaults))
        // The user's off is kept for that pack only.
        NephisStudioSwitch.set(false, pack: "p0123456789abcdef", defaults: defaults)
        XCTAssertFalse(NephisStudioSwitch.isOn(pack: "p0123456789abcdef", defaults: defaults))
        XCTAssertTrue(NephisStudioSwitch.isOn(pack: "pfedcba9876543210", defaults: defaults))
        // Installing the pack again turns it on.
        NephisStudioSwitch.installed(pack: "p0123456789abcdef", defaults: defaults)
        XCTAssertTrue(NephisStudioSwitch.isOn(pack: "p0123456789abcdef", defaults: defaults))
        // Off and on again: on.
        NephisStudioSwitch.set(false, pack: "pfedcba9876543210", defaults: defaults)
        NephisStudioSwitch.set(true, pack: "pfedcba9876543210", defaults: defaults)
        XCTAssertTrue(NephisStudioSwitch.isOn(pack: "pfedcba9876543210", defaults: defaults))
        // No pack: on, and a choice without one changes nothing.
        NephisStudioSwitch.set(false, pack: nil, defaults: defaults)
        XCTAssertTrue(NephisStudioSwitch.isOn(pack: nil, defaults: defaults))
        XCTAssertNil(defaults.stringArray(forKey: NephisStudioSwitch.offKey)?.first)
    }

    // MARK: - The Voice test's studio speed test against the clock (2026-10-13: pack 7's studio never finished)

    func testTheStudioSpeedTestStopsWhenOutOfTimeOrTooSlow() {
        // The warm-up only keeps to the clock: its first run prepares the models, so its pace says nothing yet.
        XCTAssertNil(StudioTestBudget.verdict(projectedX: 0.2, elapsedSeconds: 30, paced: false))
        XCTAssertEqual(StudioTestBudget.verdict(projectedX: 0.2, elapsedSeconds: 60, paced: false), "timed out after 60 s")
        // The timed render stops as soon as it can no longer reach real time.
        XCTAssertEqual(StudioTestBudget.verdict(projectedX: 0.3, elapsedSeconds: 12, paced: true), "studio too slow: 0.3x real time")
        XCTAssertNil(StudioTestBudget.verdict(projectedX: 1.0, elapsedSeconds: 12, paced: true))
        XCTAssertNil(StudioTestBudget.verdict(projectedX: 2.4, elapsedSeconds: 59.9, paced: true))
        // Out of time wins over the pace.
        XCTAssertEqual(StudioTestBudget.verdict(projectedX: 0.3, elapsedSeconds: 61, paced: true), "timed out after 60 s")
        XCTAssertEqual(StudioTestBudget.left(elapsedSeconds: 15), 45)
        XCTAssertEqual(StudioTestBudget.left(elapsedSeconds: 75), 0)
    }

    func testAFailedStudioLoadSaysWhenMemoryWasShort() {
        XCTAssertEqual(StudioTestBudget.loadFailure("Error 5", freeMB: 412.4), "not enough memory to load the studio (412 MB free)")
        XCTAssertEqual(StudioTestBudget.loadFailure("Error 5", freeMB: 2_400), "couldn't load the studio: Error 5")
        // Unknown free memory (the simulator) is never the reason.
        XCTAssertEqual(StudioTestBudget.loadFailure("Error 5", freeMB: nil), "couldn't load the studio: Error 5")
    }
}

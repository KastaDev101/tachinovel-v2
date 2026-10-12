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
}

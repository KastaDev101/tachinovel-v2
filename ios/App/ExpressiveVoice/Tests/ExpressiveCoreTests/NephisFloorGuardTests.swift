//
//  NephisFloorGuardTests.swift — the tuner's floor guard (NephisFloorGuard.swift): off is bit-identical, the gain curve is
//  the tuner's (threshold, ratio, floor; the phone's level 6.02 dB over the tuner's), a quiet floor sinks while speech
//  stays, and the chain reads it from pack.json.
//

import ExpressiveCore
import Foundation
import XCTest

final class NephisFloorGuardTests: XCTestCase {
    func testOffLeavesTheSoundAsItIs() throws {
        let x = (0..<4800).map { Float(0.001 * sin(Double($0) / 7)) }
        var y = x
        var guarded: NephisFloorGuard?
        XCTAssertFalse(NephisFloorGuard.apply(&guarded, settings: nil, to: &y, sampleRate: 24_000, restart: false))
        XCTAssertEqual(y, x)
        XCTAssertNil(guarded)
        XCTAssertFalse(NephisFloorGuard.apply(&guarded, settings: .init(amount: 0.004), to: &y, sampleRate: 24_000, restart: false))
        XCTAssertEqual(y, x)
        XCTAssertNil(try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"closeness": {"amount": 0.2}}"#.utf8)).floorGuard)
        XCTAssertNil(try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"floorGuard": 3}"#.utf8)).floorGuard)
        XCTAssertNil(try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"floorGuard": {}}"#.utf8)).floorGuard)
        XCTAssertEqual(try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"floorGuard": {"amount": 9}}"#.utf8)).floorGuard?.amount, 1,
                       "clamped")
    }

    func testTheGainCurveIsTheTuners() {
        let g = NephisFloorGuard.Settings(amount: 0.5)
        XCTAssertEqual(g.ratio, 2)
        XCTAssertEqual(g.floorGain, pow(10, -6.0 / 20), accuracy: 1e-12)
        XCTAssertEqual(NephisFloorGuard.gain(envelope: 0.075, settings: g), 1, "from the threshold on: untouched")
        XCTAssertEqual(NephisFloorGuard.gain(envelope: 0.3, settings: g), 1)
        XCTAssertEqual(NephisFloorGuard.gain(envelope: 0.06, settings: g), 0.8, accuracy: 1e-12, "(e / xT)^(r - 1)")
        XCTAssertEqual(NephisFloorGuard.gain(envelope: 0.01, settings: g), g.floorGain, accuracy: 1e-12, "never under its floor")
        XCTAssertEqual(NephisFloorGuard.gain(envelope: 0, settings: g), g.floorGain, accuracy: 1e-12)
        let gentle = NephisFloorGuard.Settings(amount: 0.1)
        XCTAssertEqual(NephisFloorGuard.gain(envelope: 0.05, settings: gentle), pow(0.05 / 0.075, 0.2), accuracy: 1e-12)
    }

    func testAQuietFloorSinksAndSpeechStays() {
        // A steady level a (the envelope settles to 15 · a at the phone's level: 30 · LPF(|x| / 2)).
        func settled(_ a: Float, amount: Double) -> Float {
            var x = [Float](repeating: a, count: 24_000)
            var guarded: NephisFloorGuard?
            NephisFloorGuard.apply(&guarded, settings: .init(amount: amount), to: &x, sampleRate: 24_000, restart: true)
            return x[x.count - 1] / a
        }
        XCTAssertEqual(settled(0.002, amount: 0.5), Float(pow(10, -6.0 / 20)), accuracy: 1e-3, "15 · 0.002 = 0.03: the floor")
        XCTAssertEqual(settled(0.004, amount: 0.5), 0.8, accuracy: 1e-3, "15 · 0.004 = 0.06")
        XCTAssertEqual(settled(0.01, amount: 0.5), 1, accuracy: 1e-6, "over the threshold (0.075 / 15 = 0.005)")
    }

    func testTheGuardCarriesOnFromCallToCall() {
        let x = (0..<9600).map { i in Float(i < 4800 ? 0.05 : 0.002) * Float(sin(Double(i) / 5)) }
        var whole = x
        var one: NephisFloorGuard?
        NephisFloorGuard.apply(&one, settings: .init(amount: 0.4), to: &whole, sampleRate: 24_000, restart: true)
        var a = Array(x.prefix(3000)), b = Array(x.dropFirst(3000))
        var two: NephisFloorGuard?
        NephisFloorGuard.apply(&two, settings: .init(amount: 0.4), to: &a, sampleRate: 24_000, restart: true)
        NephisFloorGuard.apply(&two, settings: .init(amount: 0.4), to: &b, sampleRate: 24_000, restart: false)
        XCTAssertEqual(a + b, whole)
    }
}

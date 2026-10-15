//
//  NephisStudioEQ.swift — her pack's own EQ on her studio's sound (pack.json chain "studioEQ", Kasta 2026-10-15).
//
//  A pack tuned on the PC can carry the EQ that made the audio Kasta approved, as a short list of RBJ cookbook sections
//  (high shelf, low shelf, peaking; Q as the cookbook's Q: alpha = sin(w0) / 2Q, shelves with 2·sqrt(A)·alpha) and an
//  overall gain:
//
//    "studioEQ": {"gainDB": -1.25, "sections": [
//      {"type": "highShelf", "hz": 10040, "q": 0.721, "db": 9.19},
//      {"type": "lowShelf",  "hz": 200,   "q": 0.7,   "db": 3.5},
//      {"type": "peaking",   "hz": 500,   "q": 1.0,   "db": -1.5}]}
//
//  The browser EQ tuner's two filter types (Kasta, 2026-10-15) are sections too: "highPass" (low cut) and "lowPass" (top
//  cut), RBJ cookbook 12 dB/octave with the section's Q (0.7071 = Butterworth, -3 dB at `hz`); their `db` is ignored:
//
//    HPF  b = [(1+c)/2, -(1+c), (1+c)/2]   LPF  b = [(1-c)/2, 1-c, (1-c)/2]   both  a = [1+al, -2c, 1-al]
//    with w = 2π·hz/fs, c = cos w, al = sin w / 2Q.
//
//  NephisFlowSynth runs it on every call her studio rendered (44.1 kHz), at the call's rate, after the breath polish and
//  after (independent of) "eqAfterStudio". A call the studio skipped or failed keeps the Mimi EQ path as before.
//  Absent or unreadable: nil, every call exactly as before. A section type this version doesn't know is skipped (a newer
//  pack still plays); values are clamped to sane ranges (hz 20-20,000 and under Nyquist at the call's rate, q 0.1-10,
//  db ±12, gain -12…+6 dB, at most 8 sections).
//
//  The filters run in double precision, every section on each sample before it is rounded back to Float, and `Filter`
//  keeps their state: a call processed in pieces sounds exactly like the call in one piece (as her mastering does,
//  NephisMaster). The studio hands a call over whole today, so each call starts from a fresh state in a pause.
//

import Foundation

extension NephisFlow {
    public struct StudioEQ: Codable, Sendable, Equatable {
        /// The section shapes (RBJ Audio EQ Cookbook).
        public enum Kind: String, Codable, Sendable, CaseIterable {
            case highShelf
            case lowShelf
            case peaking
            /// Low cut and top cut (12 dB/octave, Q from the section; `db` ignored).
            case highPass
            case lowPass
        }

        /// One section: its shape, corner or centre frequency (Hz), Q and gain (dB).
        public struct Section: Codable, Sendable, Equatable {
            public var type: Kind
            public var hz: Double
            public var q: Double
            public var db: Double

            public init(type: Kind, hz: Double, q: Double = 0.707, db: Double) {
                self.type = type
                self.hz = StudioEQ.clamped(hz, 20, 20_000, else: 1_000)
                self.q = StudioEQ.clamped(q, 0.1, 10, else: 0.707)
                self.db = StudioEQ.clamped(db, -12, 12, else: 0)
            }

            /// `type` and `hz` are needed (a type this version doesn't know throws: the list skips the section); q
            /// defaults to 0.707, db to 0.
            public init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                let type = try c.decode(Kind.self, forKey: .type)
                let hz = try c.decode(Double.self, forKey: .hz)
                self.init(type: type, hz: hz, q: (try? c.decodeIfPresent(Double.self, forKey: .q)) ?? 0.707,
                          db: (try? c.decodeIfPresent(Double.self, forKey: .db)) ?? 0)
            }
        }

        /// A list entry that never fails the list: an unknown or broken section decodes as nil and is left out.
        private struct Lenient: Decodable {
            let section: Section?
            init(from decoder: Decoder) throws {
                section = try? Section(from: decoder)
            }
        }

        public static let maxSections = 8

        /// Overall gain (dB), applied after the sections.
        public var gainDB: Double
        public var sections: [Section]

        public init(gainDB: Double = 0, sections: [Section]) {
            self.gainDB = Self.clamped(gainDB, -12, 6, else: 0)
            self.sections = Array(sections.prefix(Self.maxSections))
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let gain = (try? c.decodeIfPresent(Double.self, forKey: .gainDB)) ?? 0
            let list = (try? c.decodeIfPresent([Lenient].self, forKey: .sections)) ?? []
            self.init(gainDB: gain, sections: list.compactMap(\.section))
        }

        static func clamped(_ v: Double, _ lo: Double, _ hi: Double, else fallback: Double) -> Double {
            v.isFinite ? min(hi, max(lo, v)) : fallback
        }

        /// The EQ's filters for one call at `sampleRate`, from a fresh state. A frequency at or above Nyquist is moved
        /// just under it (49 % of the rate); a 0 dB shelf or peak is left out (a low or top cut never is: its `db` means
        /// nothing); an invalid rate gives a filter that does nothing.
        public func filter(sampleRate: Int) -> Filter {
            guard sampleRate > 0 else { return Filter(sections: [], gain: 1) }
            let fs = Double(sampleRate)
            let top = fs * 0.49
            let biquads: [ToneBiquad] = sections.compactMap { s in
                let hz = min(s.hz, top)
                switch s.type {
                case .highPass: return .highPass(hz: hz, q: s.q, fs: fs)
                case .lowPass: return .lowPass(hz: hz, q: s.q, fs: fs)
                case .highShelf: return s.db == 0 ? nil : .highShelf(hz: hz, q: s.q, db: s.db, fs: fs)
                case .lowShelf: return s.db == 0 ? nil : .lowShelf(hz: hz, q: s.q, db: s.db, fs: fs)
                case .peaking: return s.db == 0 ? nil : .peaking(hz: hz, q: s.q, db: s.db, fs: fs)
                }
            }
            return Filter(sections: biquads, gain: pow(10, gainDB / 20))
        }

        /// Her EQ over one whole call (`x` at `sampleRate`), from a fresh filter state (the call starts in a pause).
        public func apply(_ x: inout [Float], sampleRate: Int) {
            var f = filter(sampleRate: sampleRate)
            f.process(&x)
        }

        /// The EQ's filters and their state: feed it one call's audio in one piece or in consecutive chunks, the
        /// output is the same (double precision throughout, rounded to Float once per sample).
        public struct Filter: Sendable {
            var sections: [ToneBiquad]
            let gain: Double

            public mutating func process(_ x: inout [Float]) {
                guard !x.isEmpty else { return }
                if sections.isEmpty, gain == 1 { return }
                for i in x.indices {
                    var v = Double(x[i])
                    for k in sections.indices { v = sections[k].process(v) }
                    x[i] = Float(v * gain)
                }
            }
        }
    }
}

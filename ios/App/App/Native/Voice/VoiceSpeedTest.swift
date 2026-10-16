//
//  VoiceSpeedTest.swift — the Voice speed test (Kasta, 2026-10-15: "have a diagnostics/speed test ready and easily
//  accessible ... for the phone, so I can test it on my phone"). JS: src/ui/native/voice-speed.ts, reached from
//  Settings › Voices, the Listen player's Voice panel, the Voice test page and Settings › Diagnostics.
//
//  One tap renders a fixed ~45 s passage (NephisSpeedTest.passage, an original novel-style opening) with the Nephis
//  pack in use, the way Listen renders it, without playing it: the same flow engine (NephisFlowSynth) with the pack's
//  chain, her studio and its studio EQ, her pauses; calls cut and budgeted as Listen does (one sentence while under
//  4 s is ready, then paragraphs up to Pocket's 400 characters; her studio from 6 s ready; a lead-in from 25 s; one
//  take when the phone is warm), each issued as soon as the call before has its latents (ExpressiveService.synthesizeFlow,
//  in her crash sentinel). A simulated player then tells whether playback would ever have waited (NephisSpeedTest).
//  Since audio downloads part 1 (2026-10-16) its calls and their finish go through the one pipeline Listen and audio
//  downloads use (NephisRenderPipeline: NephisCallPlan's calls, her EQ step, the read's rate, NaturalFinish's flow finish),
//  so the .wav is what Listen plays before its volume stage, at 1×. Only "Voice volume" and its limiter are left out: the
//  Voice test's recording has them.
//
//  The report: time to first audio, render time against audio (× real time), keeps up (yes/no, the breaks), the time
//  per stage (Pocket generation, Mimi decode, studio blueprint, studio vocoder, EQ/post), the slowest call, every call,
//  the device, iOS, heat at the start and the end, low power mode, free memory, the pack (name, weightsSha256), her studio
//  on every call or why not, the chain in use. It goes to the Diagnostics folder (iCloud TachiNovel-Diagnostics) as
//  speedtest-<date>-<time>.json with the audio as .wav (32-bit float at the read's rate: 44.1 kHz with her studio), and
//  the JSON also to logs/ (the folder's mirror copies it later if the folder couldn't be reached now). "Play result"
//  plays the last rendered passage.
//
//  Main thread only, like ExpressiveService (its callbacks come on main); file work on DiagnosticsFiles.queue.
//

import ExpressiveCore
import ExpressiveEngines
import Foundation
import HDVoiceCore
import os

final class VoiceSpeedTest {
    static let shared = VoiceSpeedTest()

    private(set) var running = false
    private var stopAsked = false
    /// The last rendered passage (a local copy for "Play result") and its length.
    private(set) var lastAudio: URL?
    private(set) var lastAudioSeconds = 0.0
    private let log = Logger(subsystem: "app.tachinovel", category: "voice-speedtest")

    /// One call of the test, as it went.
    private struct Call {
        let n: Int
        let sentences: Range<Int>
        let chars: Int
        let pauseBefore: Double?
        let ahead: Double
        let studioAsked: Bool
        let takes: Int
        let leadIn: Bool
        let issuedAt: Double
        var preparedAt: Double?
        var readyAt: Double?
        var samples: [Float] = []
        var rate = 0
        var mastered = false
        var toned = false
        /// Letters of each sentence's text (where the pipeline's finish cuts the call into sentences).
        var letters: [Int] = []
        var report: NephisFlowSynth.Report?
        var error: String?
    }

    /// The whole run's state (main thread).
    private struct Run {
        let started: Date
        var loadMs = 0.0
        var studioWaitMs = 0.0
        var callsStarted: Date?
        var sentences: [NephisSpeedTest.Sentence] = []
        /// The passage as her calls see it (NephisCallPlan, exactly as Listen's segments map to it) and its quote style.
        var plan: [NephisCallPlan.Sentence] = []
        var quotes = QuoteRouter.SingleQuotes.thought
        var calls: [Call] = []
        var next = 0
        var reset = true
        var thermalStart = 0
        var thermalMax = 0
        var memoryStart: [String: Any] = [:]
        var stoppedListen = false
        /// Her dialogue pack's model as the calls start (its load time and the free memory around it), nil without one.
        var dialogue: NephisFlowSynth.DialogueStatus?
        /// Seconds already banked at the start (the steady-state run: Developer › "Start with 60 s buffered"), and whether
        /// the last call ran at background priority (Listen's RenderPacer.relaxed, with its hysteresis).
        var banked = 0.0
        var relaxed = false
        var done: ([String: Any]) -> Void
        var progress: ([String: Any]) -> Void
    }

    private var run: Run?

    // MARK: - Start and stop

    /// Runs the test; `progress` (main) as it goes ({step, text, done, total}), `done` (main) with the report, or
    /// {ran: false, error} when it can't run. `banked` (seconds, 0 = the usual run): the steady-state run starts as if that
    /// much audio were already waiting, so its calls are budgeted the way Listen's are once it is going.
    func start(banked: Double = 0, progress: @escaping ([String: Any]) -> Void, done: @escaping ([String: Any]) -> Void) {
        guard !running else { return done(["ran": false, "busy": true, "error": "The speed test is already running."]) }
        let svc = ExpressiveService.shared
        let delivery = VoiceSettings.shared.prefs.delivery
        guard NarrationController.listenEngine() == .pocketTts, delivery.isNephis else {
            return done(["ran": false, "error": "Choose Nephis as the voice first (Settings › Voices)."])
        }
        guard svc.isInstalled(.pocketTts) else { return done(["ran": false, "error": "Her voice isn’t downloaded yet (Settings › Voices)."]) }
        guard !svc.studioTestRunning else { return done(["ran": false, "busy": true, "error": "The studio test is running: try again when it ends."]) }
        guard !svc.crashDisabled else {
            return done(["ran": false, "error": "Nephis is switched off after crashing: turn her back on first (Settings › Voices)."])
        }
        running = true
        stopAsked = false
        // Audio downloads step aside (her engine is the test's alone).
        DrivePrep.shared.narrationChanged()
        // One voice at a time: the lab player, a preview and the old engine speed test stop; Listen stops (its place is
        // saved: it goes on from there, with a fresh read, when you play again).
        ExpressiveLabPlayer.shared.stop()
        VoicePreviewPlayer.shared.stop()
        svc.cancelSpeedTest(reason: "stopped: the Voice speed test started")
        let status = NarrationController.shared.status
        let listening = status == .playing || status == .paused || status == .loading
        if listening { NarrationController.shared.stop() }
        var r = Run(started: Date(), done: done, progress: progress)
        r.stoppedListen = listening
        r.banked = max(0, min(600, banked.isFinite ? banked : 0))
        r.thermalStart = ProcessInfo.processInfo.thermalState.rawValue
        r.thermalMax = r.thermalStart
        r.memoryStart = Self.memory()
        // With her dialogue pack the passage goes on with a short exchange (dialogue tags, a split quote, laughter), so the
        // test shows both voices; the narrator-only passage is unchanged (the lab compares its audio with the locked one).
        r.sentences = NephisSpeedTest.sentences(NephisSpeedTest.passageFor(dialogue: svc.nephisDialogue))
        r.plan = NephisSpeedTest.planSentences(r.sentences)
        r.quotes = NephisCallPlan.quoteStyle(r.plan.map(\.text))
        run = r
        say("load", "Loading her voice…")
        let t0 = Date()
        svc.ensureLoaded(.pocketTts) { [weak self] result in
            guard let self, self.run != nil else { return }
            self.run?.loadMs = Date().timeIntervalSince(t0) * 1000
            if case .failure(let error) = result { return self.finish(error: "Her voice couldn’t load: \(error.localizedDescription)") }
            guard svc.usesFlow else { return self.finish(error: "Nephis’s reading engine isn’t available (her voice files are missing).") }
            if self.stopAsked { return self.finish(error: "stopped") }
            self.say("studio", NephisModelPack.studioDirectory == nil ? "Getting ready…" : "Waiting for her studio to load…")
            let s0 = Date()
            // Her studio's models load in the background behind Pocket's: wait for them, so the test times her studio.
            svc.whenSettled { [weak self] in
                guard let self, self.run != nil else { return }
                self.run?.studioWaitMs = Date().timeIntervalSince(s0) * 1000
                if self.stopAsked { return self.finish(error: "stopped") }
                // Her dialogue pack's model (loaded behind her studio's): how its load went, for the report.
                let flow = svc.flowEngine
                Task { @MainActor [weak self] in
                    let status = await flow?.dialogueStatus()
                    guard let self, self.run != nil else { return }
                    self.run?.dialogue = status
                    self.run?.callsStarted = Date()
                    self.issueNext()
                }
            }
        }
    }

    /// Stop: no new call starts; the one running ends, then the report says "stopped". False when nothing runs.
    @discardableResult
    func stop() -> Bool {
        guard running else { return false }
        stopAsked = true
        // Still loading: the load's callback ends it; between calls: end now.
        if let r = run, r.callsStarted != nil, r.calls.allSatisfy({ $0.readyAt != nil || $0.error != nil }) { finish(error: "stopped") }
        return true
    }

    // MARK: - The calls

    private func seconds(since date: Date?) -> Double {
        date.map { Date().timeIntervalSince($0) } ?? 0
    }

    /// The next call, cut and budgeted as Listen does from what is ready ahead of the simulated player.
    private func issueNext() {
        guard var r = run, let t0 = r.callsStarted else { return }
        guard !stopAsked else {
            if r.calls.allSatisfy({ $0.readyAt != nil || $0.error != nil }) { finish(error: "stopped") }
            return
        }
        guard r.next < r.sentences.count else { return }
        let now = seconds(since: t0)
        let ready = r.calls.compactMap { c in c.readyAt.map { (at: $0, seconds: Double(c.samples.count) / Double(max(1, c.rate))) } }
        let ahead = NephisSpeedTest.ahead(at: now, ready: ready.map(\.at), seconds: ready.map(\.seconds), banked: r.banked)
        let i = r.next
        // Listen's call through the shared plan (HybridSpeechEngine.pumpRender: NephisCallPlan via NephisRenderPipeline): one
        // sentence while little is buffered, then paragraphs; calm narration, heteronyms resolved, the text as written for a
        // "raw" pack, the app's pause before it, her dialogue pack's quote hints; her studio on every call it can afford
        // (StudioBudget), extras only when far ahead, background priority as Listen gives it.
        let plan = r.plan
        let members = NephisCallPlan.group(from: i, count: plan.count, limit: NephisCallPlan.limit(first: plan[i], buffered: ahead)) { plan[$0] }
        let call = NephisCallPlan.call(members: members, count: plan.count, at: { plan[$0] },
                                       context: NephisCallPlan.Context(reset: r.reset, dialogue: ExpressiveService.shared.nephisDialogue,
                                                                       singleQuotes: r.quotes),
                                       spoken: NephisRenderPipeline.spoken)
        let range = i..<((members.last ?? i) + 1)
        var line = call.line
        let said = line.text
        let budget = Self.budget(ahead: ahead, calls: r.calls, readChange: call.readChange, switches: call.switches)
        line.takes = budget.takes
        line.leadIn = budget.leadIn
        line.studio = HybridSpeechEngine.studioFor(characters: said.count, ahead: ahead)
        r.relaxed = RenderPacer.relaxed(was: r.relaxed, buffered: ahead)
        if r.relaxed { line.relaxed = true }
        let k = r.calls.count
        r.calls.append(Call(n: k + 1, sentences: range, chars: said.count, pauseBefore: line.pauseBefore, ahead: ahead,
                            studioAsked: line.studio == true, takes: budget.takes, leadIn: budget.leadIn, issuedAt: now,
                            letters: members.map { plan[$0].say.count }))
        r.next = range.upperBound
        r.reset = false
        r.thermalMax = max(r.thermalMax, ProcessInfo.processInfo.thermalState.rawValue)
        run = r
        say("calls", "Rendering call \(k + 1) (sentences \(range.lowerBound + 1)–\(range.upperBound) of \(r.sentences.count))…",
            done: range.lowerBound, total: r.sentences.count)
        ExpressiveService.shared.synthesizeFlow(line, prepared: { [weak self] in
            guard let self, self.run != nil else { return }
            self.run?.calls[k].preparedAt = self.seconds(since: t0)
            self.issueNext()
        }, reported: { [weak self] report in
            self?.run?.calls[k].report = report
        }, completion: { [weak self] result in
            guard let self, self.run != nil else { return }
            switch result {
            case .success(let audio):
                self.run?.calls[k].samples = audio.samples
                self.run?.calls[k].rate = audio.sampleRate
                self.run?.calls[k].mastered = audio.mastered
                self.run?.calls[k].toned = audio.toned
            case .failure(let error):
                self.run?.calls[k].error = error.localizedDescription
                // Listen reads a failed call with another voice and her next call starts a fresh read.
                self.run?.reset = true
                if self.run?.calls[k].preparedAt == nil { self.issueNext() }
            }
            self.run?.calls[k].readyAt = self.seconds(since: t0)
            self.callEnded()
        })
    }

    /// Listen's budget for a call (NephisCallPlan.budget): one plain take on a warm phone or after a call (at user-initiated
    /// priority) under 1.5× real time; otherwise by the audio ready ahead, each voice change counted as less.
    private static func budget(ahead: Double, calls: [Call], readChange: Bool, switches: Int) -> (takes: Int, leadIn: Bool) {
        let warm = ProcessInfo.processInfo.thermalState.rawValue >= ProcessInfo.ThermalState.fair.rawValue
        let last = calls.last(where: { $0.report.map { !$0.relaxed } ?? false })?.report
        let x = last.flatMap { $0.totalMs > 0 ? $0.audioMs / $0.totalMs : nil }
        return NephisCallPlan.budget(buffered: ahead, readChange: readChange, switches: switches, warm: warm, lastUrgentX: x)
    }

    private func callEnded() {
        guard let r = run else { return }
        let finished = r.calls.allSatisfy { $0.readyAt != nil }
        if finished, r.next >= r.sentences.count || stopAsked {
            finish(error: stopAsked && r.next < r.sentences.count ? "stopped" : nil)
        }
    }

    // MARK: - The result

    private func say(_ step: String, _ text: String, done: Int = 0, total: Int = 0) {
        run?.progress(["step": step, "text": text, "done": done, "total": total])
    }

    private func finish(error: String?) {
        guard let r = run else { return }
        run = nil
        running = false
        stopAsked = false
        DrivePrep.shared.narrationChanged()
        ExpressiveService.shared.scheduleIdleRelease()
        // The audio as Listen plays it before its volume stage (the shared pipeline's finish: her EQ for a call without her
        // studio in a studio read, the read's rate, the thump filter and soft limit, the cut into sentences), at 1x.
        let rate = SessionRate.forRead(.pocketTts)
        var finish = NephisRenderPipeline.finish(rate: rate, seed: 1)
        let tilt = HybridSpeechEngine.nephisTilt
        var audio: [Float] = []
        // Where each call starts in the .wav (the PC's join check looks at every call boundary).
        var joins: [[String: Any]] = []
        for c in r.calls where !c.samples.isEmpty {
            joins.append(["n": c.n, "sample": audio.count, "seconds": Self.r2(Double(audio.count) / Double(max(1, rate)))])
            var samples = c.samples
            NephisRenderPipeline.preEQ(&samples, sampleRate: c.rate, readRate: rate, mastered: c.mastered, toned: c.toned, tilt: tilt)
            let converted = SessionRate.resample(samples, from: c.rate, to: rate) ?? []
            let unit = NephisRenderPipeline.unit(samples: converted, letters: c.letters, speed: 1, mastered: c.mastered, toned: c.toned)
            audio += finish.render(unit).flatMap(\.frames)
        }
        var report = Self.report(r, error: error, rate: rate, audioSamples: audio.count)
        report["callStarts"] = joins
        let stem = NephisSpeedTest.fileStem(Date(), steady: r.banked > 0)
        report["files"] = ["json": "\(stem).json", "wav": audio.isEmpty ? NSNull() as Any : "\(stem).wav" as Any] as [String: Any]
        // Stopped or refused before any call: nothing to keep.
        guard !r.calls.isEmpty else {
            report["saved"] = "not saved: nothing was rendered"
            return r.done(report)
        }
        guard !audio.isEmpty else {
            save(report: report, wav: nil, stem: stem, done: r.done)
            return
        }
        let wav = NephisSpeedTest.wavFloat32(audio, sampleRate: rate)
        lastAudioSeconds = Double(audio.count) / Double(max(1, rate))
        // The local copy for "Play result" (the last one only).
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("voice-speed-test", isDirectory: true)
        let local = caches.appendingPathComponent("last.wav")
        do {
            try FileManager.default.createDirectory(at: caches, withIntermediateDirectories: true)
            try wav.write(to: local, options: .atomic)
            lastAudio = local
        } catch {
            log.error("speed test: couldn’t keep the audio: \(error.localizedDescription, privacy: .public)")
            lastAudio = nil
        }
        save(report: report, wav: wav, stem: stem, done: r.done)
    }

    /// The report as JSON into logs/ (the folder's mirror copies it) and, with the audio, straight into the Diagnostics
    /// folder when one is linked; `done` with the report and where it went.
    private func save(report: [String: Any], wav: Data?, stem: String, done: @escaping ([String: Any]) -> Void) {
        var report = report
        guard JSONSerialization.isValidJSONObject(report),
              let json = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) else {
            report["saved"] = "not saved: the report couldn’t be written as JSON"
            return done(report)
        }
        let logs = CoreHost.shared.localAppDir.appendingPathComponent("logs", isDirectory: true)
        let log = self.log
        let finish = MainBound(done)
        let carried = MainBound(report)
        Task { @MainActor in
            let folder = DiagnosticsFolder.shared.folderURL
            let name = folder?.lastPathComponent
            // "Saved" only says the iPhone has it: whether iCloud takes it is the folder's last check (2026-10-15: two days
            // of "saved in TachiNovel-Diagnostics" never reached the PC).
            let notUploading = DiagnosticsFolder.shared.uploadProblem
            let linked = DiagnosticsFolder.shared.isLinked
            DiagnosticsFiles.queue.async {
                try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
                try? json.write(to: logs.appendingPathComponent("\(stem).json"), options: .atomic)
                Self.prune(logs)
                var saved = linked
                    ? "on the iPhone only: the Diagnostics folder is disconnected (reconnect it in More › About › Diagnostics)"
                    : "on the iPhone only: no Diagnostics folder is set (More › About › Diagnostics › Diagnostics Folder)"
                if let folder {
                    let accessing = folder.startAccessingSecurityScopedResource()
                    do {
                        try DiagnosticsFiles.requireRoot(folder)
                        let target = folder.appendingPathComponent("\(stem).json")
                        try DiagnosticsFiles.write(json, to: target)
                        if let wav { try DiagnosticsFiles.write(wav, to: folder.appendingPathComponent("\(stem).wav")) }
                        saved = "in \(name ?? "the Diagnostics folder")"
                        if case .problem(let why) = UploadCheck.of(target) {
                            saved += " on this iPhone, but \(why)"
                        } else if let notUploading {
                            saved += " on this iPhone, but \(notUploading)"
                        }
                    } catch {
                        log.error("speed test: couldn’t write to the Diagnostics folder: \(error.localizedDescription, privacy: .public)")
                        saved = "on the iPhone; the Diagnostics folder couldn’t be reached (\(error.localizedDescription)): the report goes there with the next copy"
                    }
                    if accessing { folder.stopAccessingSecurityScopedResource() }
                }
                let savedWhere = saved
                DispatchQueue.main.async {
                    var out = carried.value
                    out["saved"] = savedWhere
                    finish.value(out)
                    Task { @MainActor in DiagnosticsFolder.shared.mirror(force: true) }
                }
            }
        }
    }

    /// Keeps the newest 10 speed test reports in logs/.
    private static func prune(_ logs: URL) {
        let names = ((try? FileManager.default.contentsOfDirectory(atPath: logs.path)) ?? [])
            .filter { $0.hasPrefix("speedtest-") && $0.hasSuffix(".json") }.sorted(by: >)
        for name in names.dropFirst(10) { try? FileManager.default.removeItem(at: logs.appendingPathComponent(name)) }
    }

    // MARK: - Play

    /// Plays the last rendered passage; false when there is none.
    func play() throws -> Bool {
        guard let url = lastAudio, FileManager.default.fileExists(atPath: url.path) else { return false }
        ExpressiveLabPlayer.shared.stop()
        NarrationController.shared.activateForSample()
        try VoicePreviewPlayer.shared.play(.file(url))
        return true
    }

    func stopPlaying() {
        VoicePreviewPlayer.shared.stop()
    }

    // MARK: - The report

    private static func r1(_ x: Double) -> Double { (x * 10).rounded() / 10 }
    private static func r2(_ x: Double) -> Double { (x * 100).rounded() / 100 }
    /// Seconds as whole milliseconds.
    private static func ms(_ seconds: Double) -> Double { (seconds * 1000).rounded() }

    private static let heat = ["nominal", "fair", "serious", "critical"]
    private static func heatWord(_ v: Int) -> String { heat.indices.contains(v) ? heat[v] : "unknown" }

    private static func memory() -> [String: Any] {
        ["freeMB": ExpressiveService.freeMemoryMB().map { r1($0) } ?? NSNull(), "usedMB": r1(VoiceLab.memoryFootprintMB())]
    }

    private static func deviceModel() -> String {
        var sys = utsname()
        uname(&sys)
        return withUnsafeBytes(of: &sys.machine) { raw in String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self) }
    }

    private static func iosVersion() -> String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    private static func appVersion() -> String {
        let info = Bundle.main.infoDictionary
        return "\(info?["CFBundleShortVersionString"] as? String ?? "?") (\(info?["CFBundleVersion"] as? String ?? "?"))"
    }

    /// The pack in use (pack.json) and her studio.
    private static func pack() -> [String: Any] {
        guard let root = NephisModelPack.active else { return ["installed": false] }
        let info = NephisModelPack.info ?? [:]
        let hasStudio = FileManager.default.fileExists(atPath: root.appendingPathComponent("Models/nephis-studio/studio.json").path)
        return [
            "installed": true, "id": root.lastPathComponent, "name": info["name"] ?? NSNull(), "made": info["made"] ?? NSNull(),
            "base": info["base"] ?? NSNull(), "weightsSha256": info["weightsSha256"] ?? NSNull(), "hasStudio": hasStudio,
            "studioOn": NephisModelPack.studioOn, "studioUsed": NephisModelPack.studioDirectory != nil,
            "hasDewind": NephisModelPack.dewindDirectory != nil,
        ]
    }

    /// The chain in use (the pack's, or the defaults).
    private static func chain() -> [String: Any] {
        guard let c = ExpressiveService.shared.nephisFlowAssets?.chain else { return [:] }
        let eq: Any = c.studioEQ.map { eq -> [String: Any] in
            ["gainDB": eq.gainDB, "sections": eq.sections.map { s -> [String: Any] in ["type": s.type.rawValue, "hz": s.hz, "q": s.q, "db": s.db] }]
        } ?? NSNull()
        // The tuner's finishing (chain "closeness", "breathAir", "room"), as the app read it (clamped); null when absent.
        let closeness: Any = c.closeness.map { ["amount": $0.amount, "on": $0.on, "thresholdDB": $0.thresholdDB, "ratio": $0.ratio] as [String: Any] } ?? NSNull()
        let breathAir: Any = c.breathAir.map { ["amount": $0.amount, "drive": $0.drive, "preGain": $0.preGain, "mix": $0.mix] as [String: Any] } ?? NSNull()
        let room: Any = c.room.map { ["amount": $0.amount, "seconds": $0.seconds, "decay": $0.decay, "seed": $0.seed] as [String: Any] } ?? NSNull()
        // The de-wind cleaner (chain "dewind"): its passes, and the pack's model as dewind.json names it (null when off).
        let dewindDir = NephisModelPack.dewindDirectory
        let dewindConfig = dewindDir.flatMap { try? NephisDewindModel.readConfig(in: $0) }
        let dewind: Any = c.dewind.map { d -> [String: Any] in
            ["passes": d.passes, "model": dewindConfig?.model ?? NephisDewindModel.defaultName, "framesPerCall": dewindConfig?.frames_per_call ?? NSNull(),
             "computeUnits": dewindConfig?.compute_units ?? "cpu", "inPack": dewindDir != nil]
        } ?? NSNull()
        return [
            "closeness": closeness, "breathAir": breathAir, "room": room, "dewind": dewind,
            "clipFrames": c.clipFrames, "carryFrames": c.carryFrames, "studioEQ": eq, "studioEQPresent": c.studioEQ != nil,
            "eqAfterStudio": c.eqAfterStudio, "breathPolish": c.breathPolish != nil, "master": c.master?.preset.rawValue ?? NSNull(),
            "text": c.text.rawValue, "highShelfDB": c.highShelfDB ?? NSNull(), "softSibilance": c.softSibilance ?? NSNull(),
            "pieceGap": c.pieceGap, "paragraphGapScale": c.paragraphGapScale,
        ]
    }

    private static func studioWord(_ r: NephisFlowSynth.Report?) -> String {
        guard let r else { return "unknown" }
        return r.studioUsed ? "used" : r.studioRead ? "skipped" : "off"
    }

    /// A bypass reason's word before any colon ("memory: 480 MB free" → "memory").
    private static func reasonKey(_ reason: String?) -> String {
        String((reason ?? "unknown").prefix { $0 != ":" })
    }

    /// One call for the report's list.
    private static func callRow(_ c: Call, audioSeconds: Double, late: Bool) -> [String: Any] {
        var row: [String: Any] = ["n": c.n, "sentences": "\(c.sentences.lowerBound + 1)-\(c.sentences.upperBound)", "chars": c.chars]
        row["pauseBefore"] = c.pauseBefore ?? NSNull()
        row["aheadS"] = r1(c.ahead)
        row["studioAsked"] = c.studioAsked
        row["takes"] = c.takes
        row["leadIn"] = c.leadIn
        row["issuedS"] = r2(c.issuedAt)
        row["preparedS"] = c.preparedAt.map { r2($0) } ?? NSNull()
        row["readyS"] = c.readyAt.map { r2($0) } ?? NSNull()
        row["audioS"] = r2(audioSeconds)
        row["late"] = late
        row["rate"] = c.rate
        row["error"] = c.error ?? NSNull()
        row["studio"] = studioWord(c.report)
        guard let rep = c.report else { return row }
        row["totalMs"] = rep.totalMs.rounded()
        row["x"] = rep.totalMs > 0 ? r2(rep.audioMs / rep.totalMs) : 0
        row["pocketMs"] = rep.renderMs.rounded()
        row["analysisMs"] = rep.analysisMs.rounded()
        row["recognizeMs"] = rep.recognizeMs.rounded()
        row["mimiMs"] = rep.mimiMs.rounded()
        row["blueprintMs"] = rep.studioBlueprintMs.rounded()
        row["vocoderMs"] = rep.studioVocoderMs.rounded()
        row["studioRestMs"] = rep.studioRestMs.rounded()
        row["postMs"] = rep.postMs.rounded()
        row["reason"] = rep.bypassReason.map { String($0.prefix(160)) } ?? NSNull()
        row["studioX"] = rep.studioX.map { r2($0) } ?? NSNull()
        row["studioEQ"] = rep.studioEQ
        row["closeness"] = rep.closeness
        row["breathAir"] = rep.breathAir
        row["room"] = rep.room
        row["finishMs"] = r1(rep.finishMs)
        row["dewind"] = rep.dewindPasses
        row["dewindMs"] = r1(rep.dewindMs)
        row["dewindNote"] = rep.dewindNote.map { String($0.prefix(160)) } ?? NSNull()
        row["pieces"] = rep.pieces
        row["mood"] = rep.mood
        row["latents"] = ["stream": rep.streamLatents, "scratch": rep.scratchLatents, "tail": rep.tailLatents]
        row["relaxed"] = rep.relaxed
        row["listened"] = rep.listened
        row["floorGuard"] = rep.floorGuard
        if rep.dialogueSpans > 0 || rep.switches > 0 || rep.dialogueNote != nil { row["dialogue"] = ExpressiveService.dialogueJSON(rep) }
        return row
    }

    private static func report(_ r: Run, error: String?, rate: Int, audioSamples: Int) -> [String: Any] {
        let calls = r.calls
        let durations = calls.map { Double($0.samples.count) / Double(max(1, $0.rate)) }
        let ready = calls.map { $0.readyAt ?? 0 }
        let play = NephisSpeedTest.playback(ready: ready, seconds: durations, banked: r.banked)
        let audioSeconds = durations.reduce(0, +)
        let renderSeconds = calls.compactMap(\.readyAt).max() ?? 0
        let reports = calls.compactMap(\.report)
        func total(_ key: KeyPath<NephisFlowSynth.Report, Double>) -> Double { reports.reduce(0) { $0 + $1[keyPath: key] } }
        let stages: [String: Any] = [
            "pocketGenerationMs": total(\.renderMs).rounded(), "analysisMs": total(\.analysisMs).rounded(),
            "recognizeMs": total(\.recognizeMs).rounded(), "mimiDecodeMs": total(\.mimiMs).rounded(),
            "studioBlueprintMs": total(\.studioBlueprintMs).rounded(), "studioVocoderMs": total(\.studioVocoderMs).rounded(),
            "studioRestMs": total(\.studioRestMs).rounded(), "eqPostMs": total(\.postMs).rounded(),
            // Inside eqPostMs: the tuner's finishing (closeness, breath air, room).
            "finishMs": total(\.finishMs).rounded(),
            // Its own stage (not inside eqPostMs): the de-wind cleaner.
            "dewindMs": total(\.dewindMs).rounded(),
            // Inside dewindMs: its network's predictions, the network's inputs and outputs, the signal processing.
            "dewindPredictMs": total(\.dewindPredictMs).rounded(), "dewindIOMs": total(\.dewindIOMs).rounded(),
            "dewindDSPMs": total(\.dewindDSPMs).rounded(),
            "decodeMs": total(\.decodeMs).rounded(), "callsMs": total(\.totalMs).rounded(),
        ]
        // The work behind the sound (heat batch 1): extras and Mimi's latents per decoder against those played.
        func count(_ key: KeyPath<NephisFlowSynth.Report, Int>) -> Int { reports.reduce(0) { $0 + $1[keyPath: key] } }
        let played = max(1, count(\.streamLatents))
        let work: [String: Any] = [
            "takes": count(\.takes), "leadIns": reports.filter(\.leadIn).count, "listened": reports.filter(\.listened).count,
            "relaxedCalls": reports.filter(\.relaxed).count,
            "latents": ["stream": count(\.streamLatents), "scratch": count(\.scratchLatents), "tail": count(\.tailLatents)],
            "latentsPerPlayed": r2(Double(count(\.streamLatents) + count(\.scratchLatents) + count(\.tailLatents)) / Double(played)),
        ]
        var bypass: [String: Int] = [:]
        for rep in reports where rep.studioRead && !rep.studioUsed { bypass[reasonKey(rep.bypassReason), default: 0] += 1 }
        let studioRead = reports.contains { $0.studioRead }
        let studioUsed = reports.filter(\.studioUsed).count
        // The slowest call: the lowest × real time (its audio against its own time).
        let slowest = calls.indices.filter { calls[$0].report.map { $0.totalMs > 0 && $0.audioMs > 0 } ?? false }
            .min { a, b in
                let x = { (k: Int) -> Double in (calls[k].report?.audioMs ?? 0) / max(1, calls[k].report?.totalMs ?? 1) }
                return x(a) < x(b)
            }
        let late = Set(play.lateCalls)
        let rows: [[String: Any]] = calls.indices.map { k in callRow(calls[k], audioSeconds: durations[k], late: late.contains(k)) }
        let thermalEnd = ProcessInfo.processInfo.thermalState.rawValue
        let firstAudio = play.firstAudio
        let setup = (r.callsStarted ?? r.started).timeIntervalSince(r.started)
        let x = renderSeconds > 0 ? audioSeconds / renderSeconds : 0
        var studio: [String: Any] = ["read": studioRead, "calls": reports.count, "used": studioUsed]
        studio["skipped"] = studioRead ? reports.count - studioUsed : 0
        studio["reasons"] = bypass
        studio["everyCall"] = studioRead && studioUsed == reports.count && !reports.isEmpty
        studio["studioEQCalls"] = reports.filter(\.studioEQ).count
        studio["closenessCalls"] = reports.filter(\.closeness).count
        studio["breathAirCalls"] = reports.filter(\.breathAir).count
        studio["roomCalls"] = reports.filter(\.room).count
        // The de-wind cleaner: calls it cleaned, its model and compute units as loaded, and why it didn't run (the last reason).
        studio["dewindCalls"] = reports.filter { $0.dewindPasses > 0 }.count
        studio["dewindModel"] = reports.compactMap(\.dewindModel).last ?? NSNull()
        studio["dewindUnits"] = reports.compactMap(\.dewindUnits).last ?? NSNull()
        studio["dewindNote"] = reports.compactMap(\.dewindNote).last.map { String($0.prefix(160)) } ?? NSNull()
        studio["units"] = reports.compactMap(\.studioUnits).last ?? NSNull()
        studio["off"] = reports.compactMap(\.studioOff).last ?? NSNull()
        var device: [String: Any] = ["model": deviceModel(), "ios": iosVersion(), "os": ProcessInfo.processInfo.operatingSystemVersionString]
        device["lowPower"] = ProcessInfo.processInfo.isLowPowerModeEnabled
        device["cores"] = ProcessInfo.processInfo.activeProcessorCount
        device["thermalStart"] = heatWord(r.thermalStart)
        device["thermalEnd"] = heatWord(thermalEnd)
        device["thermalMax"] = heatWord(max(r.thermalMax, thermalEnd))
        device["memoryStart"] = r.memoryStart
        device["memoryEnd"] = memory()
        var out: [String: Any] = ["kind": "voice-speed-test", "version": 1, "ran": error == nil]
        out["error"] = error ?? NSNull()
        out["at"] = ISO8601DateFormatter().string(from: r.started)
        out["app"] = appVersion()
        out["device"] = device
        out["pack"] = pack()
        out["chain"] = chain()
        out["studio"] = studio
        let words = r.sentences.map(\.text).joined(separator: " ").split(separator: " ").count
        out["passage"] = ["sentences": r.sentences.count, "rendered": r.next, "words": words]
        out["setup"] = ["loadMs": r.loadMs.rounded(), "studioWaitMs": r.studioWaitMs.rounded(), "totalMs": ms(setup)]
        out["firstAudioMs"] = firstAudio.map { ms($0) } ?? NSNull()
        out["firstAudioFromTapMs"] = firstAudio.map { ms($0 + setup) } ?? NSNull()
        out["audioSeconds"] = r2(audioSeconds)
        out["renderSeconds"] = r2(renderSeconds)
        out["timesRealTime"] = r2(x)
        out["rtf"] = x > 0 ? r2(1 / x) as Any : NSNull() as Any
        out["keepsUp"] = error == nil && play.keepsUp && !calls.isEmpty && calls.allSatisfy { $0.error == nil }
        out["breaks"] = play.breaks
        out["breakSeconds"] = r2(play.breakSeconds)
        out["failedCalls"] = calls.filter { $0.error != nil }.count
        out["stages"] = stages
        out["work"] = work
        // The steady-state run (Developer › "Start with 60 s buffered"): the head start it began with.
        out["mode"] = r.banked > 0 ? "steady" : "start"
        out["bankedAtStart"] = r.banked
        if let k = slowest, let rep = calls[k].report {
            var slow: [String: Any] = ["n": calls[k].n, "x": r2(rep.audioMs / max(1, rep.totalMs)), "totalMs": rep.totalMs.rounded()]
            slow["audioS"] = r2(durations[k])
            slow["studio"] = studioWord(rep)
            out["slowestCall"] = slow
        } else {
            out["slowestCall"] = NSNull()
        }
        out["calls"] = rows
        // Her dialogue pack (null without one): its pack and model load (time, free memory before and after), the calls and
        // voice changes (a minute of audio), and per voice the pieces, Pocket time and audio.
        if NephisModelPack.dialogueRoot != nil {
            let switches = count(\.switches)
            let dRender = total(\.dialogueRenderMs)
            let dSeconds = total(\.dialogueSeconds)
            var notes: [String: Int] = [:]
            for rep in reports { if let n = rep.dialogueNote { notes[reasonKey(n), default: 0] += 1 } }
            out["dialogue"] = [
                "pack": ExpressiveService.shared.dialoguePackSnapshot(r.dialogue),
                "calls": reports.filter { $0.dialogueSpans > 0 }.count, "spans": count(\.dialogueSpans), "switches": switches,
                "switchesPerMinute": audioSeconds > 0 ? r2(Double(switches) / (audioSeconds / 60)) : 0,
                "narrator": ["pieces": count(\.pieces) - count(\.dialoguePieces), "pocketMs": (total(\.renderMs) - dRender).rounded(),
                             "seconds": r2(max(0, audioSeconds - dSeconds))] as [String: Any],
                "dialogue": ["pieces": count(\.dialoguePieces), "pocketMs": dRender.rounded(), "seconds": r2(dSeconds),
                             "latents": count(\.dialogueLatents), "chars": count(\.dialogueChars), "finishMs": total(\.dialogueFinishMs).rounded(),
                             "renderX": dRender > 0 ? r2(dSeconds * 1000 / dRender) as Any : NSNull() as Any] as [String: Any],
                "narratorRead": notes,
            ] as [String: Any]
        } else {
            out["dialogue"] = NSNull()
        }
        out["sampleRate"] = rate
        out["audioSamples"] = audioSamples
        out["listenStopped"] = r.stoppedListen
        return out
    }
}

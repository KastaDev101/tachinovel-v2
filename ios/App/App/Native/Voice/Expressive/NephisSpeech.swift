//
//  NephisSpeech.swift — word timings for the Nephis flow engine (lead-in cut, word check), from Apple's speech
//  recognizer on this device only (never the network). Without permission or on-device support there is no
//  transcriber: Nephis still reads with carry-over, blended joins and clean-ups, just without lead-ins and the
//  word check.
//

import AVFoundation
import ExpressiveCore
import ExpressiveEngines
import Foundation
import Speech

enum NephisSpeech {
    /// Ask once (the system shows its prompt the first time); completion on main with whether recognition may run.
    static func requestAccess(_ completion: @escaping (Bool) -> Void) {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return completion(available)
        case .denied, .restricted: return completion(false)
        default:
            SFSpeechRecognizer.requestAuthorization { status in
                DispatchQueue.main.async { completion(status == .authorized && available) }
            }
        }
    }

    static var available: Bool {
        guard SFSpeechRecognizer.authorizationStatus() == .authorized, let r = SFSpeechRecognizer(locale: Locale(identifier: "en-US")) else { return false }
        return r.supportsOnDeviceRecognition
    }

    /// The transcriber for NephisFlowSynth, or nil when recognition can't run on this device now.
    static func transcriber() -> NephisTranscriber? {
        guard available else { return nil }
        return { samples, sampleRate in await recognize(samples, sampleRate: sampleRate) }
    }

    private static func recognize(_ samples: [Float], sampleRate: Int) async -> [NephisFlow.Word]? {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")), recognizer.supportsOnDeviceRecognition,
              let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate), channels: 1, interleaved: false),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
              let channel = buffer.floatChannelData?[0] else { return nil }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { src in
            guard let base = src.baseAddress else { return }
            channel.update(from: base, count: samples.count)
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        request.addsPunctuation = true
        request.append(buffer)
        request.endAudio()
        return await withCheckedContinuation { (cont: CheckedContinuation<[NephisFlow.Word]?, Never>) in
            let once = Once()
            let task = recognizer.recognitionTask(with: request) { result, error in
                if let result, result.isFinal {
                    let words = result.bestTranscription.segments.map {
                        NephisFlow.Word(start: $0.timestamp, end: $0.timestamp + $0.duration, text: " " + $0.substring)
                    }
                    once.run { cont.resume(returning: words) }
                } else if error != nil {
                    once.run { cont.resume(returning: nil) }
                }
            }
            // Never hold a render up for long: no answer in 8 s = no word timings for this take.
            DispatchQueue.global().asyncAfter(deadline: .now() + 8) {
                once.run {
                    task.cancel()
                    cont.resume(returning: nil)
                }
            }
        }
    }

    /// Runs its block once, from any thread.
    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var done = false
        func run(_ body: () -> Void) {
            lock.lock()
            defer { lock.unlock() }
            guard !done else { return }
            done = true
            body()
        }
    }
}

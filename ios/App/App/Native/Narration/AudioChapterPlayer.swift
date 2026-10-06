//
//  AudioChapterPlayer.swift — plays one narrated chapter file (AAC .m4a, or a chapter inside an .m4b
//  bundle) with AVPlayer. Main thread only. NarrationController owns it and handles the session,
//  Now Playing, remote commands and chapter-to-chapter flow.
//

import AVFoundation
import Foundation

final class AudioChapterPlayer {
    private(set) var player: AVPlayer?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var statusObservation: NSKeyValueObservation?

    /// File time (seconds), ~4×/s while playing.
    var onTime: ((Double) -> Void)?
    var onEnd: (() -> Void)?
    var onFail: ((String) -> Void)?

    var isLoaded: Bool { player != nil }
    var isPlaying: Bool { (player?.rate ?? 0) > 0 }

    var currentTime: Double {
        let t = player?.currentTime().seconds ?? 0
        return t.isFinite ? t : 0
    }

    /// File duration in seconds (0 until known).
    var fileDuration: Double {
        let d = player?.currentItem?.duration.seconds ?? 0
        return d.isFinite ? d : 0
    }

    func load(url: URL, at seconds: Double, rate: Float) {
        stop()
        let item = AVPlayerItem(url: url)
        item.audioTimePitchAlgorithm = .timeDomain // speech-friendly time stretching for 0.75–2×
        let p = AVPlayer(playerItem: item)
        p.automaticallyWaitsToMinimizeStalling = false
        player = p
        statusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            guard item.status == .failed else { return }
            let message = item.error?.localizedDescription ?? "The audio file can't be played"
            DispatchQueue.main.async { self?.onFail?(message) }
        }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            self?.onEnd?()
        }
        timeObserver = p.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] t in
            let s = t.seconds
            if s.isFinite { self?.onTime?(s) }
        }
        if seconds > 0.5 {
            p.seek(to: CMTime(seconds: seconds, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { _ in
                p.playImmediately(atRate: rate)
            }
        } else {
            p.playImmediately(atRate: rate)
        }
    }

    func pause() {
        player?.pause()
    }

    func resume(rate: Float) {
        player?.playImmediately(atRate: rate)
    }

    func setRate(_ rate: Float) {
        guard let p = player, p.rate > 0 else { return }
        p.rate = rate
    }

    func seek(to seconds: Double, completion: (() -> Void)? = nil) {
        guard let p = player else { return }
        p.seek(to: CMTime(seconds: max(0, seconds), preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { _ in
            DispatchQueue.main.async { completion?() }
        }
    }

    func stop() {
        if let timeObserver, let p = player { p.removeTimeObserver(timeObserver) }
        timeObserver = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        statusObservation = nil
        player?.pause()
        player = nil
    }
}

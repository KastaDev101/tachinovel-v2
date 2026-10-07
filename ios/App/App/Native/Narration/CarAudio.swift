//
//  CarAudio.swift — Now Playing and remote commands: what CarPlay's Now Playing screen, the lock screen,
//  Control Center, headphones, the steering wheel and Siri ("Hey Siri, pause / resume / next") show and do.
//
//  This works without Apple's CarPlay audio entitlement: CarPlay shows and controls any app that plays
//  audio through MPNowPlayingInfoCenter + MPRemoteCommandCenter. The logic (command mapping, the chapter
//  clock for synthesized speech, flicker-free updates) is platform-free in HDVoiceCore/CarAudio.swift;
//  this file connects it to MediaPlayer. Main thread only.
//
//  The CarPlay *templates* app (a "Continue listening" list in the car) is CarPlay/CarPlaySceneDelegate.swift,
//  behind the TNCarPlayTemplates flag until Apple grants the entitlement (docs/car.md).
//

import Foundation
import HDVoiceCore
import MediaPlayer
import UIKit

/// MPNowPlayingInfoCenter, published through NowPlayingSmoother so the shown time and length stay steady.
/// Main-thread confined (the controller updates it on main).
final class NowPlayingCenter: @unchecked Sendable {
    static let shared = NowPlayingCenter()

    private var smoother = NowPlayingSmoother()
    private(set) var metadata: NowPlayingMetadata?
    private var artwork: MPMediaItemArtwork?
    private var artworkKey: String?

    private init() {}

    /// Publish the current state. `jump`: a deliberate move (new chapter, seek, rate change) shown at once.
    func publish(chapter: String, novel: String, elapsed: Double, duration: Double, playing: Bool, speed: Double, jump: Bool) {
        let shown = smoother.next(elapsed: elapsed, duration: duration, rate: playing ? speed : 0,
                                  now: ProcessInfo.processInfo.systemUptime, jump: jump)
        let m = NowPlayingMetadata.make(chapter: chapter, novel: novel, shown: shown)
        metadata = m
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: m.title,
            MPMediaItemPropertyArtist: m.artist,
            MPMediaItemPropertyAlbumTitle: m.album,
            MPMediaItemPropertyPlaybackDuration: m.duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: m.elapsed,
            MPNowPlayingInfoPropertyPlaybackRate: m.rate,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: m.defaultRate,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
            MPNowPlayingInfoPropertyIsLiveStream: false,
        ]
        if let artwork { info[MPMediaItemPropertyArtwork] = artwork }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    func clear() {
        smoother.reset()
        metadata = nil
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    /// Cover art for the novel (cached on the device, so the car shows it offline too). Republishes when
    /// it arrives.
    func setArtwork(cover: String?) {
        guard cover != artworkKey else { return }
        artworkKey = cover
        artwork = nil
        guard let cover else { return }
        ArtworkCache.shared.image(for: cover) { [weak self] image in
            guard let self, self.artworkKey == cover, let image else { return }
            self.artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                info[MPMediaItemPropertyArtwork] = self.artwork
                MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            }
        }
    }

    /// The published fields (Voice Lab, the simulator self-test).
    func snapshot() -> [String: Any] {
        let info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        var out: [String: Any] = [:]
        out["title"] = info[MPMediaItemPropertyTitle] as? String
        out["artist"] = info[MPMediaItemPropertyArtist] as? String
        out["album"] = info[MPMediaItemPropertyAlbumTitle] as? String
        out["duration"] = (info[MPMediaItemPropertyPlaybackDuration] as? NSNumber)?.doubleValue
        out["elapsed"] = (info[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? NSNumber)?.doubleValue
        out["rate"] = (info[MPNowPlayingInfoPropertyPlaybackRate] as? NSNumber)?.doubleValue
        out["artwork"] = info[MPMediaItemPropertyArtwork] != nil
        if let shown = smoother.shown { out["shownNow"] = shown.elapsedShown(at: ProcessInfo.processInfo.systemUptime) }
        return out
    }
}

/// Cover images for Now Playing: the reader's local covers, or https covers downloaded once into Caches
/// (downscaled; the car shows ~600 px at most).
/// Loads off main; its memory cache and completions are touched on main only.
final class ArtworkCache: @unchecked Sendable {
    static let shared = ArtworkCache()

    private let memory = NSCache<NSString, UIImage>()
    private let folder: URL
    private static let maxSide: CGFloat = 600

    private init() {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        folder = caches.appendingPathComponent("artwork", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        memory.countLimit = 12
    }

    /// The image for a cover reference (local "covers/…" path or https URL); completion on main.
    func image(for cover: String, completion: @escaping (UIImage?) -> Void) {
        if let hit = memory.object(forKey: cover as NSString) { return completion(hit) }
        let done = MainBound(completion)
        let disk = folder.appendingPathComponent("\(Self.fnv(cover)).jpg")
        let local = Self.localCoverPath(cover)
        DispatchQueue.global(qos: .utility).async {
            if let path = local ?? (FileManager.default.fileExists(atPath: disk.path) ? disk.path : nil),
               let img = UIImage(contentsOfFile: path) {
                return self.deliver(Self.scaled(img), key: cover, completion: done)
            }
            guard local == nil, let url = URL(string: cover), url.scheme == "https" else {
                return DispatchQueue.main.async { done.value(nil) }
            }
            URLSession.shared.dataTask(with: url) { data, _, _ in
                guard let data, let img = UIImage(data: data) else { return DispatchQueue.main.async { done.value(nil) } }
                let small = Self.scaled(img)
                if let jpg = small.jpegData(compressionQuality: 0.85) { try? jpg.write(to: disk, options: .atomic) }
                self.deliver(small, key: cover, completion: done)
            }.resume()
        }
    }

    private func deliver(_ img: UIImage, key: String, completion: MainBound<(UIImage?) -> Void>) {
        DispatchQueue.main.async {
            self.memory.setObject(img, forKey: key as NSString)
            completion.value(img)
        }
    }

    /// The reader's local cover file for a "covers/…" reference.
    private static func localCoverPath(_ cover: String) -> String? {
        guard !cover.hasPrefix("http"), cover.hasPrefix("covers/") || cover.contains("/covers/") else { return nil }
        let name = (cover as NSString).lastPathComponent
        return CoreHost.shared.localAppDir.appendingPathComponent("covers").appendingPathComponent(name).path
    }

    private static func scaled(_ img: UIImage) -> UIImage {
        let side = max(img.size.width, img.size.height)
        guard side > maxSide, side > 0 else { return img }
        let k = maxSide / side
        return img.preparingThumbnail(of: CGSize(width: (img.size.width * k).rounded(), height: (img.size.height * k).rounded())) ?? img
    }

    /// Stable file name for a URL (FNV-1a, 64-bit).
    private static func fnv(_ s: String) -> String {
        var h: UInt64 = 0xcbf2_9ce4_8422_2325
        for b in s.utf8 {
            h ^= UInt64(b)
            h = h &* 0x100_0000_01b3
        }
        return String(h, radix: 16)
    }
}

/// MPRemoteCommandCenter: one target per command, all going through `handle` (which the simulator self-test
/// also calls, since MPRemoteCommandEvents can't be created outside the system).
/// Main-thread confined (MPRemoteCommandCenter delivers on main).
final class RemoteCommandHub: @unchecked Sendable {
    static let shared = RemoteCommandHub()

    /// NarrationController's handler: performs the command, returns whether there was something to control.
    var handler: ((RemoteCommand) -> MPRemoteCommandHandlerStatus)?
    private var installed = false
    private(set) var buttons: CarButtons = .chapters
    /// The last commands received (newest last), for the Voice Lab and the self-test.
    private(set) var recent: [String] = []

    private init() {}

    func install() {
        guard !installed else { return }
        installed = true
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { [weak self] _ in self?.handle(.play) ?? .commandFailed }
        c.pauseCommand.addTarget { [weak self] _ in self?.handle(.pause) ?? .commandFailed }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in self?.handle(.togglePlayPause) ?? .commandFailed }
        c.nextTrackCommand.addTarget { [weak self] _ in self?.handle(.nextTrack) ?? .commandFailed }
        c.previousTrackCommand.addTarget { [weak self] _ in self?.handle(.previousTrack) ?? .commandFailed }
        c.skipForwardCommand.addTarget { [weak self] event in
            let s = (event as? MPSkipIntervalCommandEvent)?.interval ?? RemoteCommandMap.skipInterval
            return self?.handle(.skipForward(s)) ?? .commandFailed
        }
        c.skipBackwardCommand.addTarget { [weak self] event in
            let s = (event as? MPSkipIntervalCommandEvent)?.interval ?? RemoteCommandMap.skipInterval
            return self?.handle(.skipBackward(s)) ?? .commandFailed
        }
        c.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            return self?.handle(.changePlaybackPosition(e.positionTime)) ?? .commandFailed
        }
        c.changePlaybackRateCommand.addTarget { [weak self] event in
            guard let e = event as? MPChangePlaybackRateCommandEvent else { return .commandFailed }
            return self?.handle(.changePlaybackRate(e.playbackRate)) ?? .commandFailed
        }
        c.skipForwardCommand.preferredIntervals = [NSNumber(value: RemoteCommandMap.skipInterval)]
        c.skipBackwardCommand.preferredIntervals = [NSNumber(value: RemoteCommandMap.skipInterval)]
        c.changePlaybackRateCommand.supportedPlaybackRates = RemoteCommandMap.rates.map { NSNumber(value: $0) }
        apply(buttons)
    }

    /// The "Car buttons" setting: track buttons (chapters) or skip buttons (15 s).
    func apply(_ b: CarButtons) {
        buttons = b
        guard installed else { return }
        let c = MPRemoteCommandCenter.shared()
        let e = RemoteCommandMap.enabled(b)
        c.playCommand.isEnabled = true
        c.pauseCommand.isEnabled = true
        c.togglePlayPauseCommand.isEnabled = true
        c.nextTrackCommand.isEnabled = e.nextTrack
        c.previousTrackCommand.isEnabled = e.previousTrack
        c.skipForwardCommand.isEnabled = e.skipForward
        c.skipBackwardCommand.isEnabled = e.skipBackward
        c.changePlaybackPositionCommand.isEnabled = e.changePlaybackPosition
        c.changePlaybackRateCommand.isEnabled = e.changePlaybackRate
    }

    @discardableResult
    func handle(_ command: RemoteCommand) -> MPRemoteCommandHandlerStatus {
        let run = { () -> MPRemoteCommandHandlerStatus in
            self.recent.append(command.name)
            if self.recent.count > 20 { self.recent.removeFirst(self.recent.count - 20) }
            return self.handler?(command) ?? .noActionableNowPlayingItem
        }
        if Thread.isMainThread { return run() }
        return DispatchQueue.main.sync(execute: run)
    }

    /// What the system offers now (Voice Lab, self-test).
    func snapshot() -> [String: Any] {
        let c = MPRemoteCommandCenter.shared()
        return [
            "installed": installed,
            "buttons": buttons.rawValue,
            "nextTrack": c.nextTrackCommand.isEnabled,
            "previousTrack": c.previousTrackCommand.isEnabled,
            "skipForward": c.skipForwardCommand.isEnabled,
            "skipBackward": c.skipBackwardCommand.isEnabled,
            "skipInterval": c.skipForwardCommand.preferredIntervals.first?.doubleValue ?? 0,
            "changePlaybackPosition": c.changePlaybackPositionCommand.isEnabled,
            "changePlaybackRate": c.changePlaybackRateCommand.isEnabled,
            "recent": recent,
        ]
    }
}

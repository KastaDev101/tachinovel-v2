//
//  NativeUI.swift — real iOS pieces for the core's NativeUi (v1 contract: action sheets, alerts, share
//  sheet, document picker, SF Symbols, image downscaling, device info, brightness).
//  UI methods run on the main thread; symbolPNG/resizeImage are thread-safe (UIGraphicsImageRenderer,
//  ImageIO) and run on the core queue.
//

import ImageIO
import UIKit
import UniformTypeIdentifiers

final class NativeUI: NSObject, UIDocumentPickerDelegate {
    static let shared = NativeUI()

    struct ActionOptions {
        var title: String?
        var message: String?
        var actions: [(title: String, destructive: Bool)] = []
        var cancel: String?

        init(json: String) {
            let obj = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] ?? [:]
            title = obj["title"] as? String
            message = obj["message"] as? String
            cancel = obj["cancel"] as? String
            for a in obj["actions"] as? [[String: Any]] ?? [] {
                actions.append((a["title"] as? String ?? "", a["destructive"] as? Bool ?? false))
            }
        }
    }

    // MARK: - Presenting

    func keyWindow() -> UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }
    }

    func topViewController() -> UIViewController? {
        var top = keyWindow()?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }

    /// Alert/action sheet; completion gets the chosen action index, or -1 for cancel (Scriptable parity).
    /// Queued: a second alert waits for the first instead of failing silently.
    func choose(_ opts: ActionOptions, style: UIAlertController.Style, completion: @escaping (Int) -> Void) {
        let answer = Once(completion)
        PresentationQueue.shared.enqueue({ host, finished in
            let ac = UIAlertController(title: opts.title, message: opts.message, preferredStyle: style)
            for (i, a) in opts.actions.enumerated() {
                ac.addAction(UIAlertAction(title: a.title, style: a.destructive ? .destructive : .default) { _ in
                    answer.call(i)
                    finished()
                })
            }
            if let cancel = opts.cancel ?? (style == .actionSheet ? "Cancel" : nil) {
                ac.addAction(UIAlertAction(title: cancel, style: .cancel) { _ in
                    answer.call(-1)
                    finished()
                })
            }
            if ac.actions.isEmpty { // an alert without buttons could never be dismissed
                ac.addAction(UIAlertAction(title: "OK", style: .cancel) { _ in
                    answer.call(-1)
                    finished()
                })
            }
            if let pop = ac.popoverPresentationController { // iPad
                pop.sourceView = host.view
                pop.sourceRect = CGRect(x: host.view.bounds.midX, y: host.view.bounds.maxY - 80, width: 1, height: 1)
                pop.permittedArrowDirections = []
            }
            host.present(ac, animated: true)
            return ac
        }, cancel: { answer.call(-1) })
    }

    func share(_ items: [Any], completion: @escaping () -> Void) {
        let answer = Once<Void> { _ in completion() }
        guard !items.isEmpty else { return answer.call(()) }
        PresentationQueue.shared.enqueue({ host, finished in
            let vc = UIActivityViewController(activityItems: items, applicationActivities: nil)
            vc.completionWithItemsHandler = { _, _, _, _ in
                answer.call(())
                finished()
            }
            if let pop = vc.popoverPresentationController {
                pop.sourceView = host.view
                pop.sourceRect = CGRect(x: host.view.bounds.midX, y: host.view.bounds.midY, width: 1, height: 1)
            }
            host.present(vc, animated: true)
            return vc
        }, cancel: { answer.call(()) })
    }

    // MARK: - Document picker

    /// One picker at a time (PresentationQueue), so these never belong to two requests.
    private var pickCompletion: ((String?) -> Void)?
    private var pickFinished: (() -> Void)?
    private var pickDestDir: String = ""

    func pickFile(types: [String], destDir: String, completion: @escaping (String?) -> Void) {
        let answer = Once(completion)
        PresentationQueue.shared.enqueue({ [self] host, finished in
            let utTypes: [UTType] = types.compactMap { UTType($0) ?? UTType(filenameExtension: $0) }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: utTypes.isEmpty ? [.data] : utTypes, asCopy: true)
            picker.delegate = self
            picker.allowsMultipleSelection = false
            pickCompletion = { answer.call($0) }
            pickFinished = finished
            pickDestDir = destDir
            host.present(picker, animated: true)
            return picker
        }, cancel: { answer.call(nil) })
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let src = urls.first else { return finishPick(nil) }
        let fm = FileManager.default
        let safe = src.lastPathComponent.replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "_", options: .regularExpression)
        let dst = URL(fileURLWithPath: pickDestDir).appendingPathComponent(safe.isEmpty ? "picked-file" : safe)
        try? fm.createDirectory(atPath: pickDestDir, withIntermediateDirectories: true)
        try? fm.removeItem(at: dst)
        do {
            try fm.copyItem(at: src, to: dst)
            finishPick(dst.path)
        } catch {
            finishPick(nil)
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finishPick(nil) }

    private func finishPick(_ path: String?) {
        let c = pickCompletion
        let f = pickFinished
        pickCompletion = nil
        pickFinished = nil
        c?(path)
        f?()
    }

    // MARK: - Brightness

    func setBrightness(_ value: CGFloat) {
        let screen = keyWindow()?.windowScene?.screen
        screen?.brightness = min(1, max(0, value))
        DeviceSnapshot.shared.refresh()
    }

    // MARK: - Thread-safe rendering

    /// SF Symbol → PNG base64, white on transparent (the UI tints it with CSS masks), rendered @3x.
    nonisolated static func symbolPNG(name: String, size: CGFloat) -> String? {
        let config = UIImage.SymbolConfiguration(pointSize: max(8, size))
        guard let image = UIImage(systemName: name, withConfiguration: config)?.withTintColor(.white, renderingMode: .alwaysOriginal) else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 3
        format.opaque = false
        let rendered = UIGraphicsImageRenderer(size: image.size, format: format).image { _ in image.draw(at: .zero) }
        return rendered.pngData()?.base64EncodedString()
    }

    /// Downscale with ImageIO (decodes WebP/HEIC/…; never materializes the full-size bitmap).
    nonisolated static func resizeImage(base64: String, maxWidth: Int) -> String? {
        guard let data = Data(base64Encoded: base64),
              let src = CGImageSourceCreateWithData(data as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? Int, let h = props[kCGImagePropertyPixelHeight] as? Int, w > 0, h > 0 else { return nil }
        if w <= maxWidth { return base64 }
        let maxPixel = max(maxWidth, Int((Double(h) * Double(maxWidth) / Double(w)).rounded()))
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let thumb = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, thumb, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return (out as Data).base64EncodedString()
    }
}

/// Device info snapshot, refreshed on the main thread (UIKit state must not be read from the core queue).
final class DeviceSnapshot: @unchecked Sendable { // `cached` is lock-protected; UIKit is read on the main actor only
    static let shared = DeviceSnapshot()
    private let lock = NSLock()
    private var cached = "{}"

    /// Call once on the main thread at launch.
    @MainActor func start() {
        UIDevice.current.isBatteryMonitoringEnabled = true
        let nc = NotificationCenter.default
        let names = [
            UIDevice.batteryLevelDidChangeNotification,
            UIDevice.batteryStateDidChangeNotification,
            UIScreen.brightnessDidChangeNotification,
            UIApplication.didBecomeActiveNotification,
        ]
        for name in names {
            nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.refresh() } }
        }
        refresh()
    }

    @MainActor func refresh() {
        let device = UIDevice.current
        let window = NativeUI.shared.keyWindow()
        let info: [String: Any] = [
            "model": device.model,
            "systemVersion": device.systemVersion,
            "batteryLevel": device.batteryLevel < 0 ? 1 : Double(device.batteryLevel),
            "charging": device.batteryState == .charging || device.batteryState == .full,
            "brightness": Double(window?.windowScene?.screen.brightness ?? 0.5),
            "dark": (window?.traitCollection.userInterfaceStyle ?? .dark) == .dark,
        ]
        let json = (try? JSONSerialization.data(withJSONObject: info)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        lock.lock()
        cached = json
        lock.unlock()
    }

    func json() -> String {
        lock.lock()
        defer { lock.unlock() }
        return cached
    }
}

/// Calls the wrapped completion at most once (main thread).
final class Once<T> {
    private var fn: ((T) -> Void)?
    init(_ fn: @escaping (T) -> Void) { self.fn = fn }
    func call(_ value: T) {
        let f = fn
        fn = nil
        f?(value)
    }
}

/// Serializes everything presented modally for the core (alerts, action sheets, share sheet, document
/// picker, browser-check sheet). Main thread only.
///  - A request that arrives while another is on screen WAITS for it (UIKit refuses to present on a
///    controller that is already presenting or animating, and v1's Scriptable did queue them).
///  - Every request is answered exactly once: by the user, or with "cancelled" when it can't be shown
///    (no window, a controller stuck animating, or UIKit silently refusing the presentation).
@MainActor
final class PresentationQueue {
    static let shared = PresentationQueue()

    /// Builds and presents its controller on `host`, returns it (nil = nothing shown: the job answered
    /// its caller itself). Must call `finished()` once the user is done (after answering the caller).
    typealias Job = (_ host: UIViewController, _ finished: @escaping () -> Void) -> UIViewController?

    private var jobs: [(job: Job, cancel: () -> Void)] = []
    private var busy = false

    func enqueue(_ job: @escaping Job, cancel: @escaping () -> Void) {
        jobs.append((job, cancel))
        pump()
    }

    private func pump(attempt: Int = 0) {
        guard !busy, !jobs.isEmpty else { return }
        guard let host = NativeUI.shared.topViewController() else {
            let skipped = jobs.removeFirst()
            skipped.cancel()
            return pump()
        }
        // Wait out an animating controller (the previous alert finishing its dismissal, a sheet appearing).
        if host.isBeingDismissed || host.isBeingPresented || host.transitionCoordinator != nil {
            if attempt < 40 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.pump(attempt: attempt + 1) }
            } else {
                let skipped = jobs.removeFirst()
                skipped.cancel()
                pump()
            }
            return
        }
        let next = jobs.removeFirst()
        busy = true
        var done = false
        let finished: () -> Void = { [weak self] in
            guard !done else { return }
            done = true
            self?.busy = false
            self?.pump()
        }
        guard let presented = next.job(host, finished) else { return finished() }
        // UIKit refuses some presentations with only a console warning: detect that and answer the caller.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            guard !done, presented.presentingViewController == nil, !presented.isBeingPresented else { return }
            next.cancel()
            finished()
        }
    }
}

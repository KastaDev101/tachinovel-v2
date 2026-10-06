//
//  SmokeResponder.swift — Debug only. During the CI simulator smoke tour (`-tachiSmokeTour native`,
//  ci/ios-sim-smoke.sh, src/ui/native/smoke.ts) nobody can tap system sheets, so this answers them the
//  way a user tapping Cancel would, two seconds after they appear:
//   - document pickers: the first (Restore from Files…) like the Cancel button (dismissed, then the
//     delegate's documentPickerWasCancelled); the second (Link audio folder) like a swipe down, which
//     calls no delegate method at all — the popup queue must still go on (the share sheet comes next);
//   - the share sheet: dismissed, then its completion handler with completed = false.
//  Anything else on top (an alert, an unexpected controller) is logged so the CI log shows it.
//  Release builds don't contain this file's code.
//

#if DEBUG
import os
import UIKit

@MainActor
final class SmokeResponder {
    static let shared = SmokeResponder()

    private let log = Logger(subsystem: "app.tachinovel", category: "smoke")
    private var running = false
    private var seenController: ObjectIdentifier?
    private var seenSince = Date.distantFuture
    private let delay: TimeInterval = 2
    private var pickersSeen = 0

    /// Polls twice a second for the rest of the process's life (smoke runs only).
    func start() {
        guard !running else { return }
        running = true
        log.warning("smoke: native responder on")
        Task { @MainActor in
            while true {
                try? await Task.sleep(nanoseconds: 500_000_000)
                SmokeResponder.shared.check()
            }
        }
    }

    private func check() {
        guard let top = NativeUI.shared.topViewController(), top.presentingViewController != nil,
              !top.isBeingPresented, !top.isBeingDismissed else {
            seenController = nil
            return
        }
        let id = ObjectIdentifier(top)
        guard seenController == id else {
            seenController = id
            seenSince = Date()
            log.warning("smoke: native on screen: \(String(describing: type(of: top)), privacy: .public)")
            return
        }
        guard Date().timeIntervalSince(seenSince) >= delay else { return }
        // Handled (or reported) once per controller.
        seenSince = Date.distantFuture
        switch top {
        case let picker as UIDocumentPickerViewController:
            pickersSeen += 1
            if pickersSeen == 2 {
                log.warning("smoke: native swipe away document picker (no delegate call)")
                picker.dismiss(animated: true)
            } else {
                log.warning("smoke: native cancel document picker")
                picker.dismiss(animated: true) { picker.delegate?.documentPickerWasCancelled?(picker) }
            }
        case let share as UIActivityViewController:
            log.warning("smoke: native cancel share sheet")
            share.dismiss(animated: true) { share.completionWithItemsHandler?(nil, false, nil, nil) }
        case let alert as UIAlertController:
            // No public API taps an alert's action; leave it (the tour avoids alerts) and say so.
            log.warning("smoke: native alert left open: \(alert.title ?? "", privacy: .public) \(alert.message ?? "", privacy: .public)")
        default:
            log.warning("smoke: native controller left open: \(String(describing: type(of: top)), privacy: .public)")
        }
    }
}
#endif

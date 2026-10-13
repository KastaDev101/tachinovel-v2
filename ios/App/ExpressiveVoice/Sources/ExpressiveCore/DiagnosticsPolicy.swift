//
//  DiagnosticsPolicy.swift — when the app copies its diagnostics into the linked folder (the app's
//  DiagnosticsFolder.swift), what a failed copy means, and which log files changed. Platform-free so it is unit-tested.
//
//  Kasta 2026-10-13: nothing reached the PC for a whole morning of use. The copy waited on the web page (asleep while
//  the app is in the background: Listen in the car, the copy at backgrounding), there was no copy at launch, and a
//  failed copy was only an os_log line, so a folder that stopped working looked exactly like one that worked.
//

import Foundation

public enum DiagnosticsPolicy {
    /// While a voice works (Listen playing, a Voice test, a model call in flight): a copy every minute.
    public static let busyInterval: TimeInterval = 60
    /// Otherwise every five minutes while the app runs.
    public static let idleInterval: TimeInterval = 5 * 60
    /// storage.json is a walk of the whole container: at most every half hour (and on a report or "Copy Now").
    public static let storageInterval: TimeInterval = 30 * 60

    /// A periodic copy is due: `lastAttempt` is the last copy started (successful or not).
    public static func isDue(now: Date, lastAttempt: Date?, busy: Bool) -> Bool {
        guard let lastAttempt else { return true }
        return now.timeIntervalSince(lastAttempt) >= (busy ? busyInterval : idleInterval) - 1
    }

    /// Copy a file under logs/ when the copy in the folder has another size, or the file changed since the last copy
    /// that worked (a log trimmed back to the same size still changed).
    public static func shouldCopy(sourceSize: Int, sourceModified: Date?, targetSize: Int?, lastSuccess: Date?) -> Bool {
        guard let targetSize, targetSize == sourceSize else { return true }
        guard let sourceModified, let lastSuccess else { return lastSuccess == nil }
        return sourceModified > lastSuccess
    }

    public enum Health: Equatable, Sendable {
        /// No folder linked.
        case off
        case ok
        /// The folder can't be reached any more (the link broke: reinstall, folder moved or deleted, access gone):
        /// only picking it again fixes it.
        case disconnected(String)
        /// The last copy failed for another reason (iCloud Drive busy, iPhone full); the next one may work.
        case failing(String)

        public var state: String {
            switch self {
            case .off: return "off"
            case .ok: return "ok"
            case .disconnected: return "disconnected"
            case .failing: return "failing"
            }
        }

        public var problem: String? {
            switch self {
            case .off, .ok: return nil
            case .disconnected(let why), .failing(let why): return why
            }
        }
    }

    /// What a failed copy or a link that doesn't resolve means.
    public static func classify(_ error: Error) -> Health {
        let ns = error as NSError
        let errors = [ns] + ((ns.userInfo[NSUnderlyingErrorKey] as? NSError).map { [$0] } ?? [])
        for e in errors {
            if e.domain == NSCocoaErrorDomain {
                switch e.code {
                case NSFileReadNoPermissionError, NSFileWriteNoPermissionError:
                    return .disconnected("The app isn’t allowed into the folder any more")
                case NSFileNoSuchFileError, NSFileReadNoSuchFileError, NSFileReadInvalidFileNameError:
                    return .disconnected("The folder isn’t there any more")
                case NSFileWriteOutOfSpaceError:
                    return .failing("The iPhone is full")
                case NSUserCancelledError:
                    return .failing("iCloud Drive didn’t answer in time")
                case NSFileWriteVolumeReadOnlyError:
                    return .disconnected("The folder is read-only")
                default: break
                }
            }
            if e.domain == NSPOSIXErrorDomain {
                switch Int32(e.code) {
                case EPERM, EACCES: return .disconnected("The app isn’t allowed into the folder any more")
                case ENOENT: return .disconnected("The folder isn’t there any more")
                case ENOSPC: return .failing("The iPhone is full")
                default: break
                }
            }
        }
        return .failing(ns.localizedDescription)
    }
}

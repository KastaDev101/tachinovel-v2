//
//  NativeHostAPI.swift — the `__native` object installed into the core JSContext.
//
//  Contract: src/core/native-api.ts (one TS interface, this Swift implementation, and a Node mock in
//  tests/helpers/native-mock.ts). Keep the three in sync.
//
//  Rules:
//   - Only strings, numbers, booleans, string arrays and callbacks cross the boundary.
//   - Sync members run on the core queue and throw a JS Error on failure (context.exception).
//   - Async members call `cb(error, result)` exactly once, always on the core queue.
//
//  No `import Capacitor` here (JSValue name clash). JSVal = JavaScriptCore.JSValue.
//

import Foundation
import ImageIO
@preconcurrency import JavaScriptCore
import os // Logger interpolation (`privacy:`) used through host.log
import UIKit
import UniformTypeIdentifiers

typealias JSVal = JavaScriptCore.JSValue

final class NativeHostAPI {
    private unowned let host: CoreHost
    private let launchReason: String
    private let http = NativeHTTP()
    /// Core-queue only.
    private var timers: [Int: DispatchWorkItem] = [:]
    private var nextTimer = 1

    init(host: CoreHost, launchReason: String) {
        self.host = host
        self.launchReason = launchReason
    }

    // MARK: - Helpers

    /// A Swift @convention(block) closure as an object JSC turns into a JS function.
    private func fn<T>(_ block: T) -> AnyObject { unsafeBitCast(block, to: AnyObject.self) }

    private static func current() -> JSContext { JSContext.current() }

    private static func null() -> JSVal { JSVal(nullIn: current()) }

    private static func string(_ s: String) -> JSVal { JSVal(object: s, in: current()) }

    /// Raise a JS exception from inside a block (JSC throws it when the block returns).
    private static func raise(_ message: String) {
        let ctx = current()
        ctx.exception = JSVal(newErrorFromMessage: message, in: ctx)
    }

    /// Invoke a JS callback `cb(error, result)` on the core queue.
    private func reply(_ cb: JSVal, error: String?, result: Any? = nil) {
        host.queue.async {
            if let error {
                _ = cb.call(withArguments: [error, NSNull()])
            } else {
                _ = cb.call(withArguments: [NSNull(), result ?? NSNull()])
            }
        }
    }

    private func set(_ obj: JSVal, _ name: String, _ value: Any) {
        obj.setObject(value, forKeyedSubscript: name as NSString)
    }

    // MARK: - Object

    func makeObject(in ctx: JSContext) -> JSVal {
        let obj = JSVal(newObjectIn: ctx)!
        set(obj, "info", info(in: ctx))
        set(obj, "fs", fileSystem(in: ctx))
        set(obj, "ui", ui(in: ctx))
        set(obj, "timers", timerObject(in: ctx))
        set(obj, "bundle", bundle(in: ctx))

        let httpBlock: @convention(block) (String, JSVal) -> Void = { [self] json, cb in
            http.perform(json: json) { result in
                switch result {
                case .success(let response): self.reply(cb, error: nil, result: response)
                case .failure(let error): self.reply(cb, error: error.localizedDescription)
                }
            }
        }
        set(obj, "http", fn(httpBlock))

        let browserFetch: @convention(block) (String, JSVal) -> Void = { [self] requestJson, cb in
            guard let request = BrowserFetcher.Request(json: requestJson) else {
                return reply(cb, error: "browserFetch: invalid request")
            }
            DispatchQueue.main.async {
                BrowserFetcher.shared.fetch(request) { result in
                    switch result {
                    case .success(let json): self.reply(cb, error: nil, result: json)
                    case .failure(let error): self.reply(cb, error: error.localizedDescription)
                    }
                }
            }
        }
        set(obj, "browserFetch", fn(browserFetch))

        // Core log lines can name sources, novels and URLs. In the system log they are readable only in
        // Debug builds (the CI smoke test reads them); Release builds keep them <private>. The app's own
        // log file (Settings › Diagnostics) is unaffected.
        let log: @convention(block) (String, String) -> Void = { [self] level, line in
            #if DEBUG
            switch level {
            case "error": host.log.error("\(line, privacy: .public)")
            case "warn": host.log.warning("\(line, privacy: .public)")
            case "debug": host.log.debug("\(line, privacy: .public)")
            default: host.log.info("\(line, privacy: .public)")
            }
            #else
            switch level {
            case "error": host.log.error("\(line, privacy: .private)")
            case "warn": host.log.warning("\(line, privacy: .private)")
            case "debug": host.log.debug("\(line, privacy: .private)")
            default: host.log.info("\(line, privacy: .private)")
            }
            #endif
        }
        set(obj, "log", fn(log))

        let emit: @convention(block) (String, String) -> Void = { [self] event, payload in
            host.emit(event, payload)
        }
        set(obj, "emit", fn(emit))

        let register: @convention(block) (JSVal) -> Void = { [self] handler in
            host.setHandler(handler)
        }
        set(obj, "register", fn(register))
        return obj
    }

    private func info(in ctx: JSContext) -> JSVal {
        let o = JSVal(newObjectIn: ctx)!
        let bundle = Bundle.main.infoDictionary ?? [:]
        let version = "\(bundle["CFBundleShortVersionString"] as? String ?? "?") (\(bundle["CFBundleVersion"] as? String ?? "?"))"
        set(o, "platform", "ios")
        set(o, "appVersion", version)
        set(o, "localRoot", host.localRoot.path)
        set(o, "syncedRoot", host.syncedRoot.map { $0.path as Any } ?? NSNull())
        set(o, "launchReason", launchReason)
        return o
    }

    // MARK: - File system (FileManager semantics the v1 FileStore expects)

    private static func placeholder(_ path: String) -> String {
        let url = URL(fileURLWithPath: path)
        return url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).icloud").path
    }

    private func fileSystem(in ctx: JSContext) -> JSVal {
        let o = JSVal(newObjectIn: ctx)!
        addFileContents(to: o)
        addFileTree(to: o)
        let download: @convention(block) (String, JSVal) -> Void = { [self] path, cb in
            ICloudFiles.ensureDownloaded(path: path) { error in self.reply(cb, error: error, result: true) }
        }
        set(o, "download", fn(download))
        return o
    }

    /// readText / writeText / readBase64 / writeBase64.
    private func addFileContents(to o: JSVal) {
        let fm = FileManager.default
        let readText: @convention(block) (String) -> JSVal = { path in
            guard let s = try? String(contentsOfFile: path, encoding: .utf8) else { return Self.null() }
            return Self.string(s)
        }
        let writeText: @convention(block) (String, String) -> Void = { path, text in
            let parent = (path as NSString).deletingLastPathComponent
            guard fm.fileExists(atPath: parent) else { return Self.raise("No such directory: \(parent)") }
            do { try text.write(toFile: path, atomically: false, encoding: .utf8) } catch { Self.raise("Write failed: \(error.localizedDescription)") }
        }
        let readBase64: @convention(block) (String) -> JSVal = { path in
            guard let data = fm.contents(atPath: path) else { return Self.null() }
            return Self.string(data.base64EncodedString())
        }
        let writeBase64: @convention(block) (String, String) -> Void = { path, b64 in
            let parent = (path as NSString).deletingLastPathComponent
            guard fm.fileExists(atPath: parent) else { return Self.raise("No such directory: \(parent)") }
            guard let data = Data(base64Encoded: b64) else { return Self.raise("Invalid base64") }
            do { try data.write(to: URL(fileURLWithPath: path)) } catch { Self.raise("Write failed: \(error.localizedDescription)") }
        }
        set(o, "readText", fn(readText))
        set(o, "writeText", fn(writeText))
        set(o, "readBase64", fn(readBase64))
        set(o, "writeBase64", fn(writeBase64))
    }

    /// exists / isDirectory / remove / move / copy / list / size / modifiedAt / mkdirp.
    private func addFileTree(to o: JSVal) {
        let fm = FileManager.default
        let exists: @convention(block) (String) -> Bool = { path in
            fm.fileExists(atPath: path) || fm.fileExists(atPath: Self.placeholder(path))
        }
        let isDirectory: @convention(block) (String) -> Bool = { path in
            var isDir: ObjCBool = false
            return fm.fileExists(atPath: path, isDirectory: &isDir) && isDir.boolValue
        }
        let remove: @convention(block) (String) -> Void = { path in
            let ph = Self.placeholder(path)
            let real = fm.fileExists(atPath: path)
            guard real || fm.fileExists(atPath: ph) else { return Self.raise("No such file: \(path)") }
            do {
                if real { try fm.removeItem(atPath: path) }
                if fm.fileExists(atPath: ph) { try fm.removeItem(atPath: ph) }
            } catch { Self.raise("Remove failed: \(error.localizedDescription)") }
        }
        let move: @convention(block) (String, String) -> Void = { from, to in
            guard !fm.fileExists(atPath: to) else { return Self.raise("Destination exists: \(to)") }
            do { try fm.moveItem(atPath: from, toPath: to) } catch { Self.raise("Move failed: \(error.localizedDescription)") }
        }
        let copy: @convention(block) (String, String) -> Void = { from, to in
            guard !fm.fileExists(atPath: to) else { return Self.raise("Destination exists: \(to)") }
            do { try fm.copyItem(atPath: from, toPath: to) } catch { Self.raise("Copy failed: \(error.localizedDescription)") }
        }
        let list: @convention(block) (String) -> [String] = { path in
            do { return try fm.contentsOfDirectory(atPath: path) } catch {
                Self.raise("List failed: \(error.localizedDescription)")
                return []
            }
        }
        let size: @convention(block) (String) -> Double = { path in
            guard let attrs = try? fm.attributesOfItem(atPath: path) else { return 0 }
            return (attrs[.size] as? NSNumber)?.doubleValue ?? 0
        }
        let modifiedAt: @convention(block) (String) -> JSVal = { path in
            guard let attrs = try? fm.attributesOfItem(atPath: path), let date = attrs[.modificationDate] as? Date else { return Self.null() }
            return JSVal(double: date.timeIntervalSince1970 * 1000, in: Self.current())
        }
        let mkdirp: @convention(block) (String) -> Void = { path in
            do { try fm.createDirectory(atPath: path, withIntermediateDirectories: true) } catch { Self.raise("mkdir failed: \(error.localizedDescription)") }
        }
        set(o, "exists", fn(exists))
        set(o, "isDirectory", fn(isDirectory))
        set(o, "remove", fn(remove))
        set(o, "move", fn(move))
        set(o, "copy", fn(copy))
        set(o, "list", fn(list))
        set(o, "size", fn(size))
        set(o, "modifiedAt", fn(modifiedAt))
        set(o, "mkdirp", fn(mkdirp))
    }

    // MARK: - Timers (core queue)

    private func timerObject(in ctx: JSContext) -> JSVal {
        let o = JSVal(newObjectIn: ctx)!
        let setTimer: @convention(block) (Double, JSVal) -> Double = { [self] ms, cb in
            let id = nextTimer
            nextTimer += 1
            let item = DispatchWorkItem { [self] in
                guard timers.removeValue(forKey: id) != nil else { return }
                _ = cb.call(withArguments: [])
            }
            timers[id] = item
            // Clamp like browsers (2^31-1 ms); Int(_:) traps on NaN/huge values.
            let delay = ms.isFinite ? min(max(0, ms), 2_147_483_647) : 0
            host.queue.asyncAfter(deadline: .now() + .microseconds(Int(delay * 1000)), execute: item)
            return Double(id)
        }
        let clearTimer: @convention(block) (Double) -> Void = { [self] id in
            guard let key = Int(exactly: id) else { return } // clear(undefined) arrives as NaN
            timers.removeValue(forKey: key)?.cancel()
        }
        set(o, "set", fn(setTimer))
        set(o, "clear", fn(clearTimer))
        return o
    }

    // MARK: - App bundle (read-only core files under public/core/)

    private static func bundled(_ rel: String) -> URL? {
        guard !rel.contains(".."), !rel.hasPrefix("/"), let base = Bundle.main.resourceURL else { return nil }
        return base.appendingPathComponent("public/core", isDirectory: true).appendingPathComponent(rel)
    }

    private func bundle(in ctx: JSContext) -> JSVal {
        let o = JSVal(newObjectIn: ctx)!
        let read: @convention(block) (String) -> JSVal = { rel in
            guard let url = Self.bundled(rel), let s = try? String(contentsOf: url, encoding: .utf8) else { return Self.null() }
            return Self.string(s)
        }
        let loadModule: @convention(block) (String) -> JSVal = { rel in
            guard let url = Self.bundled(rel), let code = try? String(contentsOf: url, encoding: .utf8) else {
                Self.raise("Bundled module missing: \(rel)")
                return Self.null()
            }
            let wrapped = "(function (module, exports, require) {" + code + "\n})"
            // evaluateScript reports a SyntaxError to the context's exceptionHandler (CoreHost's only logs
            // it) and returns undefined; capture it and rethrow to the caller as the contract requires.
            let ctx = Self.current()
            let saved = ctx.exceptionHandler
            var thrown: JSVal?
            ctx.exceptionHandler = { _, exception in thrown = exception }
            let result = ctx.evaluateScript(wrapped, withSourceURL: url)
            ctx.exceptionHandler = saved
            if let thrown {
                ctx.exception = thrown
                return Self.null()
            }
            return result ?? Self.null()
        }
        set(o, "read", fn(read))
        set(o, "loadModule", fn(loadModule))
        return o
    }

    // MARK: - Native UI

    private func ui(in ctx: JSContext) -> JSVal {
        let o = JSVal(newObjectIn: ctx)!
        let actionSheet: @convention(block) (String, JSVal) -> Void = { [self] json, cb in
            let opts = NativeUI.ActionOptions(json: json)
            DispatchQueue.main.async { NativeUI.shared.choose(opts, style: .actionSheet) { self.reply(cb, error: nil, result: $0) } }
        }
        let alert: @convention(block) (String, JSVal) -> Void = { [self] json, cb in
            let opts = NativeUI.ActionOptions(json: json)
            DispatchQueue.main.async { NativeUI.shared.choose(opts, style: .alert) { self.reply(cb, error: nil, result: $0) } }
        }
        let share: @convention(block) (String, JSVal) -> Void = { [self] json, cb in
            let obj = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] ?? [:]
            var items: [Any] = []
            if let text = obj["text"] as? String { items.append(text) }
            if let s = obj["url"] as? String, let url = URL(string: s) { items.append(url) }
            DispatchQueue.main.async { NativeUI.shared.share(items) { self.reply(cb, error: nil, result: true) } }
        }
        let shareFile: @convention(block) (String, JSVal) -> Void = { [self] path, cb in
            DispatchQueue.main.async { NativeUI.shared.share([URL(fileURLWithPath: path)]) { self.reply(cb, error: nil, result: true) } }
        }
        let shareImage: @convention(block) (String, JSVal) -> Void = { [self] b64, cb in
            guard let data = Data(base64Encoded: b64), let image = UIImage(data: data) else {
                return reply(cb, error: "Not a decodable image")
            }
            DispatchQueue.main.async { NativeUI.shared.share([image]) { self.reply(cb, error: nil, result: true) } }
        }
        let pickFile: @convention(block) (String, String, JSVal) -> Void = { [self] typesJson, destDir, cb in
            let types = ((try? JSONSerialization.jsonObject(with: Data(typesJson.utf8))) as? [String]) ?? []
            DispatchQueue.main.async {
                NativeUI.shared.pickFile(types: types, destDir: destDir) { path in
                    if let path { self.reply(cb, error: nil, result: path) } else { self.reply(cb, error: "cancelled") }
                }
            }
        }
        let openUrl: @convention(block) (String) -> Void = { s in
            guard let url = URL(string: s), url.scheme == "https" || url.scheme == "http" else { return }
            DispatchQueue.main.async { UIApplication.shared.open(url) }
        }
        let symbol: @convention(block) (String, Double) -> JSVal = { name, size in
            guard let b64 = NativeUI.symbolPNG(name: name, size: CGFloat(size)) else { return Self.null() }
            return Self.string(b64)
        }
        let resizeImage: @convention(block) (String, Double) -> JSVal = { b64, maxWidth in
            // Int(_:) traps on NaN/infinite (resizeImage(b64, undefined) from JS).
            guard maxWidth.isFinite, maxWidth >= 1,
                  let out = NativeUI.resizeImage(base64: b64, maxWidth: Int(min(maxWidth, 100_000))) else { return Self.null() }
            return Self.string(out)
        }
        let device: @convention(block) () -> String = {
            DeviceSnapshot.shared.json()
        }
        let setBrightness: @convention(block) (Double) -> Void = { value in
            DispatchQueue.main.async { NativeUI.shared.setBrightness(CGFloat(value)) }
        }
        let solveChallenge: @convention(block) (String, JSVal) -> Void = { [self] url, cb in
            DispatchQueue.main.async {
                ChallengeViewController.present(urlString: url) { solved in self.reply(cb, error: nil, result: solved) }
            }
        }
        set(o, "actionSheet", fn(actionSheet))
        set(o, "alert", fn(alert))
        set(o, "share", fn(share))
        set(o, "shareFile", fn(shareFile))
        set(o, "shareImage", fn(shareImage))
        set(o, "pickFile", fn(pickFile))
        set(o, "openUrl", fn(openUrl))
        set(o, "symbol", fn(symbol))
        set(o, "resizeImage", fn(resizeImage))
        set(o, "device", fn(device))
        set(o, "setBrightness", fn(setBrightness))
        set(o, "solveChallenge", fn(solveChallenge))
        return o
    }
}

// MARK: - iCloud downloads

enum ICloudFiles {
    /// Materialize an evicted iCloud file (".name.icloud" placeholder or dataless file).
    /// Calls back with nil when the file is readable, or an error message.
    static func ensureDownloaded(path: String, timeout: TimeInterval = 30, completion: @escaping (String?) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let fm = FileManager.default
            var url = URL(fileURLWithPath: path)
            func isReady() -> Bool {
                url.removeAllCachedResourceValues()
                let values = try? url.resourceValues(forKeys: [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey])
                if values?.isUbiquitousItem != true { return fm.fileExists(atPath: path) }
                return values?.ubiquitousItemDownloadingStatus == .current
            }
            if isReady() { return completion(nil) }
            do { try fm.startDownloadingUbiquitousItem(at: url) } catch {
                return completion(fm.fileExists(atPath: path) ? nil : "iCloud download failed: \(error.localizedDescription)")
            }
            let deadline = Date().addingTimeInterval(timeout)
            while Date() < deadline {
                Thread.sleep(forTimeInterval: 0.2)
                if isReady() { return completion(nil) }
            }
            completion("iCloud download timed out: \(url.lastPathComponent)")
        }
    }
}

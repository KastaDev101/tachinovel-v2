//
//  StorageMapTests.swift — the storage map (StorageMap.swift): every byte in the container lands in one category, the
//  leftovers are the copies iOS made, unfinished unpacks and the removed voices' files, and cleaning them never touches a
//  complete pack (the active one above all), a model in use, the reading app's store or the recording. Small fake files only.
//

import ExpressiveCore
import Foundation
import XCTest

final class StorageMapTests: XCTestCase {
    private var container: URL!
    private var loc: StorageLocations!
    private var library: NephisPackLibrary!

    override func setUpWithError() throws {
        container = FileManager.default.temporaryDirectory.appendingPathComponent("container-\(UUID().uuidString)", isDirectory: true)
        let lib = container.appendingPathComponent("Library", isDirectory: true)
        loc = StorageLocations(applicationSupport: lib.appendingPathComponent("Application Support", isDirectory: true),
                               documents: container.appendingPathComponent("Documents", isDirectory: true),
                               library: lib, tmp: container.appendingPathComponent("tmp", isDirectory: true),
                               container: container, bundle: nil)
        for dir in [loc.applicationSupport, loc.documents, loc.tmp] {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        library = NephisPackLibrary(root: loc.packs)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: container)
    }

    private func file(_ url: URL, bytes: Int = 5000) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(repeating: 1, count: bytes).write(to: url)
    }

    private func pack(name: String, into folder: URL? = nil) throws -> URL {
        let root = try folder ?? library.stagingDirectory()
        for rel in NephisPackLibrary.required { try file(root.appendingPathComponent(rel), bytes: 100) }
        try JSONSerialization.data(withJSONObject: ["name": name, "made": "2026-10-1\(name.count % 10)"])
            .write(to: root.appendingPathComponent("pack.json"))
        return root
    }

    private func entry(_ r: StorageReport, _ key: String) -> StorageEntry? { r.entries.first { $0.key == key } }

    func testEveryCategoryAddsUpToTheContainer() throws {
        let six = try library.add(staged: pack(name: "nephis-6"), fallbackName: "a").pack
        let seven = try library.add(staged: pack(name: "nephis-seven"), fallbackName: "b").pack
        XCTAssertEqual(library.activeID, seven.id)
        try file(loc.models.appendingPathComponent("pocket-tts/v2.1/english/x.bin"), bytes: 40_000)
        try file(loc.models.appendingPathComponent("kokoro/g2p.bin"), bytes: 20_000)
        try file(loc.models.appendingPathComponent("chatterbox-nano/y.bin"), bytes: 25_000)
        try file(loc.applicationSupport.appendingPathComponent("DriveAudio/a.m4a"))
        try file(loc.appStore.appendingPathComponent("covers/c.webp"))
        try file(loc.appStore.appendingPathComponent("voices/v.json"))
        try file(loc.appStore.appendingPathComponent("ota/bundles/1/index.html"))
        try file(loc.documents.appendingPathComponent("voice-test.wav"), bytes: 30_000)
        try file(loc.documents.appendingPathComponent("backups/b.json"))
        try file(loc.documents.appendingPathComponent("Inbox/nephis-6.tnmodel"), bytes: 60_000)
        try file(loc.tmp.appendingPathComponent("app.tachinovel-Inbox/nephis-7.tnmodel"), bytes: 70_000)
        try file(loc.library.appendingPathComponent("Caches/artwork/a.jpg"))
        try file(loc.library.appendingPathComponent("Preferences/app.plist"))

        let r = StorageMap.scan(loc, library: library, installing: false)
        XCTAssertEqual(entry(r, "packActive")?.count, 1)
        XCTAssertEqual(entry(r, "packActive")?.note, "nephis-seven")
        XCTAssertEqual(entry(r, "packsOther")?.note, six.name)
        XCTAssertGreaterThanOrEqual(entry(r, "modelPocket")?.bytes ?? 0, 40_000)
        XCTAssertGreaterThanOrEqual(entry(r, "modelsOther")?.bytes ?? 0, 20_000)
        XCTAssertLessThan(entry(r, "modelsOther")?.bytes ?? 0, 25_000, "a removed voice's model is a leftover, not a model in use")
        XCTAssertEqual(entry(r, "leftoverRemovedModels")?.count, 1)
        XCTAssertEqual(entry(r, "leftoverRemovedModels")?.note, "Chatterbox Nano (no longer used)")
        XCTAssertGreaterThanOrEqual(entry(r, "leftoverRemovedModels")?.bytes ?? 0, 25_000)
        XCTAssertGreaterThan(entry(r, "leftoverImportedVoices")?.bytes ?? 0, 0)
        XCTAssertGreaterThanOrEqual(entry(r, "recordings")?.bytes ?? 0, 30_000)
        XCTAssertEqual(entry(r, "leftoverInbox")?.count, 2)
        XCTAssertGreaterThanOrEqual(entry(r, "leftoverInbox")?.bytes ?? 0, 130_000)
        XCTAssertGreaterThan(entry(r, "documents")?.bytes ?? 0, 0)
        XCTAssertLessThan(entry(r, "documents")?.bytes ?? 0, 30_000, "the recording and the Inbox copy aren't counted twice")
        XCTAssertGreaterThan(entry(r, "reading")?.bytes ?? 0, 0)
        XCTAssertEqual(r.totalBytes, StorageMap.sizeOf(container), "nothing counted twice")
        XCTAssertEqual(r.entries.reduce(Int64(0)) { $0 + $1.bytes }, r.totalBytes, "every byte in exactly one category")
        XCTAssertEqual(r.leftoverBytes, r.entries.filter(\.leftover).reduce(0) { $0 + $1.bytes })
        let json = r.json()
        XCTAssertEqual((json["entries"] as? [[String: Any]])?.count, r.entries.count)
        XCTAssertTrue(JSONSerialization.isValidJSONObject(json))
    }

    func testCleanRemovesOnlyLeftovers() throws {
        let six = try library.add(staged: pack(name: "nephis-6"), fallbackName: "a").pack
        let ten = try library.add(staged: pack(name: "nephis-10"), fallbackName: "b").pack
        try file(loc.models.appendingPathComponent("pocket-tts/x.bin"))
        try file(loc.models.appendingPathComponent("kokoro/g2p.bin"))
        try file(loc.models.appendingPathComponent("neutts-2e/m.bin"))
        try file(loc.appStore.appendingPathComponent("voices/v.json"))
        try file(loc.appStore.appendingPathComponent("library.json"))
        try file(loc.documents.appendingPathComponent("voice-test.wav"))
        try file(loc.documents.appendingPathComponent("backups/b.json"))
        try file(loc.documents.appendingPathComponent("Inbox/nephis-10.tnmodel"))
        try file(loc.documents.appendingPathComponent("Inbox/notes.txt"))
        try file(loc.tmp.appendingPathComponent("app.tachinovel-Inbox/v.tnvoice"))
        try file(loc.documents.appendingPathComponent("broken.tnmodel"))
        try file(loc.tmp.appendingPathComponent("voice-import/x.tnvoice"))
        // An unpack a killed app left, a pack folder missing files, and an old build's half-unpacked single pack.
        let staging = try library.stagingDirectory()
        try file(staging.appendingPathComponent("Models/a.bin"))
        let incomplete = loc.packs.appendingPathComponent("p0123456789abcdef", isDirectory: true)
        try file(incomplete.appendingPathComponent("pack.json"))
        try file(loc.legacyPack.appendingPathComponent("Models/half.bin"))

        let before = StorageMap.scan(loc, library: library, installing: false)
        XCTAssertGreaterThan(before.leftoverBytes, 0)
        let cleaned = StorageMap.clean(loc, library: library, installing: false)
        XCTAssertEqual(cleaned.removed, 9)
        XCTAssertEqual(cleaned.bytes, before.leftoverBytes)

        let fm = FileManager.default
        for id in [six.id, ten.id] { XCTAssertTrue(NephisPackLibrary.isComplete(try library.directory(id))) }
        XCTAssertEqual(library.activeID, ten.id)
        for path in ["Library/Application Support/fluidaudio/Models/pocket-tts/x.bin", "Library/Application Support/fluidaudio/Models/kokoro/g2p.bin",
                     "Library/Application Support/TachiNovel/library.json",
                     "Documents/voice-test.wav", "Documents/backups/b.json", "Documents/Inbox/notes.txt"] {
            XCTAssertTrue(fm.fileExists(atPath: container.appendingPathComponent(path).path), path)
        }
        for gone in [staging, incomplete, loc.legacyPack, loc.documents.appendingPathComponent("broken.tnmodel"),
                     loc.documents.appendingPathComponent("Inbox/nephis-10.tnmodel"), loc.tmp.appendingPathComponent("voice-import"),
                     loc.models.appendingPathComponent("neutts-2e"), loc.appStore.appendingPathComponent("voices")] {
            XCTAssertFalse(fm.fileExists(atPath: gone.path), gone.lastPathComponent)
        }
        XCTAssertEqual(StorageMap.scan(loc, library: library, installing: false).leftoverBytes, 0)
    }

    func testNothingInFlightIsALeftoverWhileInstalling() throws {
        _ = try library.add(staged: pack(name: "nephis-6"), fallbackName: "a")
        let staging = try library.stagingDirectory()
        try file(staging.appendingPathComponent("Models/a.bin"))
        try file(loc.documents.appendingPathComponent("Inbox/nephis-7.tnmodel"))
        try file(loc.documents.appendingPathComponent("nephis-8.tnmodel"))
        XCTAssertEqual(StorageMap.leftovers(loc, library: library, installing: true), [])
        XCTAssertEqual(StorageMap.clean(loc, library: library, installing: true).removed, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: staging.path))
        let r = StorageMap.scan(loc, library: library, installing: true)
        XCTAssertEqual(r.leftoverBytes, 0)
        XCTAssertEqual(r.entries.reduce(Int64(0)) { $0 + $1.bytes }, r.totalBytes)
    }

    func testActivePackIsNeverALeftoverEvenWhenIncomplete() throws {
        let p = try library.add(staged: pack(name: "nephis-6"), fallbackName: "a").pack
        let dir = try library.directory(p.id)
        try FileManager.default.removeItem(at: dir.appendingPathComponent(NephisPackLibrary.required[0]))
        XCTAssertNil(library.activeID, "an incomplete pack isn't read with")
        XCTAssertEqual(library.leftoverFolders(), [])
        XCTAssertTrue(library.protectedFolders().contains(dir.standardizedFileURL.path))
        StorageMap.clean(loc, library: library, installing: false)
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.path))
    }

    func testSystemInboxCopies() {
        let docs = URL(fileURLWithPath: "/var/mobile/Containers/Data/Application/X/Documents")
        let tmp = URL(fileURLWithPath: "/var/mobile/Containers/Data/Application/X/tmp")
        XCTAssertTrue(StorageMap.isSystemInboxCopy(docs.appendingPathComponent("Inbox/p.tnmodel"), documents: docs, tmp: tmp))
        XCTAssertTrue(StorageMap.isSystemInboxCopy(tmp.appendingPathComponent("app.tachinovel-Inbox/p.tnmodel"), documents: docs, tmp: tmp))
        XCTAssertFalse(StorageMap.isSystemInboxCopy(docs.appendingPathComponent("p.tnmodel"), documents: docs, tmp: tmp))
        XCTAssertFalse(StorageMap.isSystemInboxCopy(tmp.appendingPathComponent("voice-import/p.tnvoice"), documents: docs, tmp: tmp))
        XCTAssertFalse(StorageMap.isSystemInboxCopy(URL(fileURLWithPath: "/private/var/mobile/Library/Mobile Documents/com~apple~CloudDocs/p.tnmodel"),
                                                    documents: docs, tmp: tmp))
    }
}

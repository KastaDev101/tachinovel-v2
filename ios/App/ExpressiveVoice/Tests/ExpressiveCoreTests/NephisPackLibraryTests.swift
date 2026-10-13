//
//  NephisPackLibraryTests.swift — the Nephis model packs kept side by side (NephisPackLibrary.swift): adding makes
//  a pack active, the same name and date replaces its copy, switching, deleting (the active one falls back to the
//  next, then to none), bad ids, and the move of the single pack older builds kept. The packs here are empty files
//  with the right names, never a real model.
//

import ExpressiveCore
import Foundation
import XCTest

final class NephisPackLibraryTests: XCTestCase {
    private var dir: URL!
    private var library: NephisPackLibrary!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("packs-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        library = NephisPackLibrary(root: dir.appendingPathComponent("NephisPacks", isDirectory: true))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    /// An unpacked pack: every required file (`bytes` in the decoder weights), pack.json, optionally her studio.
    private func unpacked(name: String?, made: String?, studio: Bool = false, bytes: Int = 1, into folder: URL? = nil) throws -> URL {
        let root = try folder ?? library.stagingDirectory()
        for rel in NephisPackLibrary.required {
            let url = root.appendingPathComponent(rel)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(repeating: 7, count: rel.hasSuffix("weight.bin") ? bytes : 1).write(to: url)
        }
        if studio {
            let s = root.appendingPathComponent("Models/nephis-studio/studio.json")
            try FileManager.default.createDirectory(at: s.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("{}".utf8).write(to: s)
        }
        var info: [String: Any] = ["checkpoint": "test"]
        if let name { info["name"] = name }
        if let made { info["made"] = made }
        try JSONSerialization.data(withJSONObject: info).write(to: root.appendingPathComponent("pack.json"))
        return root
    }

    private func at(_ seconds: TimeInterval) -> Date { Date(timeIntervalSince1970: 1_790_000_000 + seconds) }

    func testAddMakesActiveAndListsNewestFirst() throws {
        XCTAssertNil(library.activeID)
        XCTAssertEqual(library.list(), [])
        let a = try library.add(staged: unpacked(name: "nephis-r9", made: "2026-10-11", studio: true), fallbackName: "file", now: at(0))
        XCTAssertFalse(a.replaced)
        XCTAssertEqual(a.pack.name, "nephis-r9")
        XCTAssertEqual(a.pack.made, "2026-10-11")
        XCTAssertTrue(a.pack.studio)
        XCTAssertGreaterThan(a.pack.bytes, 0)
        XCTAssertEqual(library.activeID, a.pack.id)
        XCTAssertEqual(library.activeDirectory?.lastPathComponent, a.pack.id)
        XCTAssertTrue(NephisPackLibrary.isComplete(try XCTUnwrap(library.activeDirectory)))
        XCTAssertEqual(NephisPackLibrary.info(in: try XCTUnwrap(library.activeDirectory))?["name"] as? String, "nephis-r9")

        let b = try library.add(staged: unpacked(name: "nephis-r10", made: "2026-10-12"), fallbackName: "file", now: at(60))
        XCTAssertEqual(library.activeID, b.pack.id, "the pack just opened is the one she reads with")
        XCTAssertFalse(b.pack.studio)
        XCTAssertEqual(library.list().map(\.name), ["nephis-r10", "nephis-r9"])
        XCTAssertEqual(library.totalBytes, a.pack.bytes + b.pack.bytes)
        // Unpacks don't linger next to the packs.
        let left = try FileManager.default.contentsOfDirectory(atPath: library.root.path).filter { $0.hasPrefix(".") }
        XCTAssertEqual(left, [])
    }

    func testSameNameAndDateReplacesThatEntry() throws {
        let first = try library.add(staged: unpacked(name: "nephis-r9", made: "2026-10-11", bytes: 10), fallbackName: "f", now: at(0))
        let other = try library.add(staged: unpacked(name: "nephis-r9", made: "2026-10-12"), fallbackName: "f", now: at(10))
        XCTAssertNotEqual(first.pack.id, other.pack.id, "another date is another pack")
        let again = try library.add(staged: unpacked(name: "nephis-r9", made: "2026-10-11", bytes: 50_000), fallbackName: "f", now: at(20))
        XCTAssertTrue(again.replaced)
        XCTAssertEqual(again.pack.id, first.pack.id)
        XCTAssertEqual(library.list().count, 2)
        XCTAssertEqual(library.activeID, first.pack.id)
        XCTAssertGreaterThan(again.pack.bytes, first.pack.bytes, "the new copy's files")
        // pack.json without a name: the file's name names it, and the same file again is the same entry.
        let unnamed = try library.add(staged: unpacked(name: nil, made: nil), fallbackName: "nephis-test", now: at(30))
        XCTAssertEqual(unnamed.pack.name, "nephis-test")
        XCTAssertTrue(try library.add(staged: unpacked(name: nil, made: nil), fallbackName: "nephis-test", now: at(40)).replaced)
        XCTAssertEqual(library.list().count, 3)
    }

    func testIncompletePackIsRefused() throws {
        let staged = try unpacked(name: "x", made: nil)
        try FileManager.default.removeItem(at: staged.appendingPathComponent(NephisPackLibrary.required[0]))
        XCTAssertThrowsError(try library.add(staged: staged, fallbackName: "x")) { XCTAssertEqual($0 as? NephisPackError, .incomplete) }
        XCTAssertNil(library.activeID)
        XCTAssertEqual(library.list(), [])
    }

    func testSwitch() throws {
        let a = try library.add(staged: unpacked(name: "a", made: "1"), fallbackName: "f", now: at(0)).pack
        let b = try library.add(staged: unpacked(name: "b", made: "2"), fallbackName: "f", now: at(1)).pack
        XCTAssertEqual(library.activeID, b.id)
        try library.activate(a.id)
        XCTAssertEqual(library.activeID, a.id)
        XCTAssertEqual(library.activeDirectory?.lastPathComponent, a.id)
        try library.activate(nil)
        XCTAssertNil(library.activeID)
        XCTAssertNil(library.activeDirectory)
        XCTAssertThrowsError(try library.activate("p0000000000000000"))
        XCTAssertThrowsError(try library.activate("../NephisModel"))
        XCTAssertNil(library.activeID, "a refused switch changes nothing")
        XCTAssertThrowsError(try library.delete("../../Documents"))
    }

    func testDeleteActiveFallsBackToNextThenNone() throws {
        let a = try library.add(staged: unpacked(name: "a", made: "1"), fallbackName: "f", now: at(0)).pack
        let b = try library.add(staged: unpacked(name: "b", made: "2"), fallbackName: "f", now: at(1)).pack
        let c = try library.add(staged: unpacked(name: "c", made: "3"), fallbackName: "f", now: at(2)).pack
        // Not the active one: nothing else changes.
        XCTAssertEqual(try library.delete(a.id), c.id)
        XCTAssertEqual(library.list().map(\.id), [c.id, b.id])
        XCTAssertFalse(FileManager.default.fileExists(atPath: try library.directory(a.id).path))
        // The active one: the next in the list takes over.
        XCTAssertEqual(try library.delete(c.id), b.id)
        XCTAssertEqual(library.activeID, b.id)
        // The last one: none (she reads with the shipped model).
        XCTAssertNil(try library.delete(b.id))
        XCTAssertNil(library.activeID)
        XCTAssertEqual(library.list(), [])
    }

    func testActivePackFolderGoneMeansNone() throws {
        let a = try library.add(staged: unpacked(name: "a", made: "1"), fallbackName: "f").pack
        try FileManager.default.removeItem(at: library.directory(a.id).appendingPathComponent(NephisPackLibrary.required[2]))
        XCTAssertNil(library.activeID, "an incomplete pack is never read")
        XCTAssertEqual(library.list(), [])
    }

    func testMigratesTheSingleOldPack() throws {
        let legacy = dir.appendingPathComponent("NephisModel", isDirectory: true)
        _ = try unpacked(name: "nephis-r8", made: "2026-10-10", studio: true, into: legacy)
        let weights = try Data(contentsOf: legacy.appendingPathComponent(NephisPackLibrary.required[1]))
        // A killed unpack from an earlier launch.
        let stale = try library.stagingDirectory()
        XCTAssertTrue(library.migrate(legacy: legacy, now: at(0)))
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacy.path), "moved, not copied")
        XCTAssertFalse(FileManager.default.fileExists(atPath: stale.path))
        let packs = library.list()
        XCTAssertEqual(packs.map(\.name), ["nephis-r8"])
        XCTAssertEqual(packs.first?.made, "2026-10-10")
        XCTAssertEqual(packs.first?.studio, true)
        XCTAssertEqual(library.activeID, packs.first?.id)
        let packDir = try XCTUnwrap(library.activeDirectory)
        XCTAssertEqual(try Data(contentsOf: packDir.appendingPathComponent(NephisPackLibrary.required[1])), weights, "her files, untouched")
        // Next launch: nothing more to do.
        XCTAssertFalse(library.migrate(legacy: legacy))
        XCTAssertEqual(library.list().count, 1)
    }

    func testMigrationKeepsAnotherActivePackAndSkipsAnIncompleteOldFolder() throws {
        let current = try library.add(staged: unpacked(name: "new", made: "2"), fallbackName: "f", now: at(5)).pack
        let legacy = dir.appendingPathComponent("NephisModel", isDirectory: true)
        _ = try unpacked(name: "old", made: "1", into: legacy)
        XCTAssertTrue(library.migrate(legacy: legacy, now: at(0)))
        XCTAssertEqual(library.activeID, current.id)
        XCTAssertEqual(library.list().map(\.name), ["new", "old"])

        let broken = dir.appendingPathComponent("Broken", isDirectory: true)
        _ = try unpacked(name: "half", made: "0", into: broken)
        try FileManager.default.removeItem(at: broken.appendingPathComponent(NephisPackLibrary.required[0]))
        XCTAssertFalse(library.migrate(legacy: broken))
        XCTAssertTrue(FileManager.default.fileExists(atPath: broken.path), "left alone")
        XCTAssertEqual(library.list().count, 2)
    }

    func testIDs() {
        let id = NephisPackLibrary.id(name: "nephis-r9", made: "2026-10-11")
        XCTAssertTrue(NephisPackLibrary.isValidID(id))
        XCTAssertEqual(id, NephisPackLibrary.id(name: "nephis-r9", made: "2026-10-11"))
        XCTAssertNotEqual(id, NephisPackLibrary.id(name: "nephis-r9", made: nil))
        for bad in ["", "p", "pABCDEF0123456789", "v0123456789abcdef", "p0123456789abcde/", "../p0123456789abc"] {
            XCTAssertFalse(NephisPackLibrary.isValidID(bad), bad)
        }
    }
}

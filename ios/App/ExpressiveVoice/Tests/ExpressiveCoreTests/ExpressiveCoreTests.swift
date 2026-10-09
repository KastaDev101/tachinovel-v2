import ExpressiveCore
import XCTest

final class TextChunkerTests: XCTestCase {
    func testShortTextIsOneChunk() {
        XCTAssertEqual(TextChunker.chunks("  Hello there.  ", limit: 120), ["Hello there."])
        XCTAssertEqual(TextChunker.chunks("", limit: 120), [])
    }

    func testSplitsAtSentenceEndsAndKeepsClosingQuotes() {
        let text = "“The rain had stopped by the time Sunny reached the bridge.” He counted the lanterns, all of them, and wondered who had lit them."
        let chunks = TextChunker.chunks(text, limit: 70)
        XCTAssertEqual(chunks.first, "“The rain had stopped by the time Sunny reached the bridge.”")
        for c in chunks { XCTAssertLessThanOrEqual(c.count, 70) }
        XCTAssertEqual(chunks.joined(separator: " "), text)
    }

    func testFallsBackToClausesThenSpaces() {
        let text = "one two three four five six, seven eight nine ten eleven twelve thirteen fourteen fifteen"
        let chunks = TextChunker.chunks(text, limit: 40)
        XCTAssertEqual(chunks.first, "one two three four five six,")
        for c in chunks { XCTAssertLessThanOrEqual(c.count, 40) }
        XCTAssertEqual(chunks.joined(separator: " "), text)
    }

    func testNeverCutsATag() {
        let text = "aaaa bbbb cccc [clear throat] dddd eeee ffff gggg"
        for limit in 8...30 {
            for c in TextChunker.chunks(text, limit: limit) {
                XCTAssertEqual(c.filter { $0 == "[" }.count, c.filter { $0 == "]" }.count, "limit \(limit): \(c)")
            }
        }
    }

    func testHardCutForOneHugeWord() {
        let word = String(repeating: "x", count: 50)
        let chunks = TextChunker.chunks(word, limit: 20)
        XCTAssertEqual(chunks.joined(), word)
        XCTAssertTrue(chunks.allSatisfy { $0.count <= 20 })
    }
}

final class StyleMapperTests: XCTestCase {
    func testPocketTextKeepsEllipsesFromEndingTheLine() {
        XCTAssertEqual(StyleMapper.pocketText("Oh, is that how you hold a blade? Hmm... I've seen farmers do better."),
                       "Oh, is that how you hold a blade? Hm, I've seen farmers do better.")
        XCTAssertEqual(StyleMapper.pocketText("Hmmm. HMM? Hmm…"), "Hm. HMM? Hm.")
        XCTAssertEqual(StyleMapper.pocketText("“Relax, little one. I don’t bite… often.”"), "“Relax, little one. I don’t bite, often.”")
        XCTAssertEqual(StyleMapper.pocketText("“I don’t know…” she said."), "“I don’t know.” she said.")
        XCTAssertEqual(StyleMapper.pocketText("…and then the lights went out..."), "and then the lights went out.")
        XCTAssertEqual(StyleMapper.pocketText("“…what? Ah! Hm… W-wait…?”"), "“what? Ah! Hm, W-wait?”")
        XCTAssertEqual(StyleMapper.pocketText("Well. . . maybe."), "Well, maybe.")
        XCTAssertEqual(StyleMapper.pocketText("He paused, …, then went on."), "He paused, then went on.")
        XCTAssertEqual(StyleMapper.pocketText("'Damna... tion...'"), "'Damnation.'")
        XCTAssertEqual(StyleMapper.pocketText("It's imposs… ible!"), "It's impossible!")
        XCTAssertEqual(StyleMapper.pocketText("There are 312 steps, 1,500 lanterns and a 3rd gate."),
                       "There are three hundred twelve steps, one thousand five hundred lanterns and a third gate.")
        XCTAssertEqual(StyleMapper.spokenNumbers("Chapter 7. It cost 2.5 coins."), "Chapter seven. It cost 2.5 coins.")
        XCTAssertEqual(StyleMapper.pocketText("The APC rolled past gate L0-49."), "The A P C rolled past gate L zero forty nine.")
        XCTAssertEqual(StyleMapper.spokenCodes("NO! RUN, the NPC said."), "NO! RUN, the N P C said.")
        XCTAssertEqual(StyleMapper.spokenCodes("GET DOWN, NOW!"), "GET DOWN, NOW!", "a shouted sentence stays words")
        XCTAssertEqual(StyleMapper.spokenNumbers("the 21st and 40th floors"), "the twenty first and fortieth floors")
        XCTAssertEqual(StyleMapper.pocketText("What... is... going on?"), "What, is, going on?")
        XCTAssertEqual(StyleMapper.pocketText("Ah... not good..."), "Ah, not good.")
    }

    func testPlainTextRemovesSoundTags() {
        XCTAssertEqual(StyleMapper.plainText("“It was a fair price, I swear [chuckle]. Well, almost fair.”"), "“It was a fair price, I swear. Well, almost fair.”")
        XCTAssertEqual(StyleMapper.plainText("[gasp] “It’s coming from the cellar!”"), "“It’s coming from the cellar!”")
        XCTAssertEqual(StyleMapper.plainText("[Sigh] fine [clear throat] then."), "fine then.")
    }

    func testChatterboxLeadTag() {
        XCTAssertEqual(StyleMapper.chatterboxLeadTag(ExpressiveLine(text: "x", emotion: "angry")), "[angry]")
        XCTAssertEqual(StyleMapper.chatterboxLeadTag(ExpressiveLine(text: "x", emotion: "sad", style: "whisper")), "[whispering]")
        XCTAssertEqual(StyleMapper.chatterboxLeadTag(ExpressiveLine(text: "x", emotion: "fearful")), "[fear]")
        XCTAssertNil(StyleMapper.chatterboxLeadTag(ExpressiveLine(text: "x")))
    }

    func testChatterboxChunksCarryTheTagAndStayWithinTheLimit() {
        let line = ExpressiveLine(text: String(repeating: "The lanterns swayed in the wind. ", count: 8), emotion: "fearful")
        let chunks = StyleMapper.chatterboxChunks(line, limit: 120)
        XCTAssertGreaterThan(chunks.count, 1)
        for c in chunks {
            XCTAssertTrue(c.hasPrefix("[fear] "), c)
            XCTAssertLessThanOrEqual(c.count, 120)
        }
    }

    func testNeuTtsMapping() {
        XCTAssertEqual(StyleMapper.neuttsEmotion(ExpressiveLine(text: "x", emotion: "surprised")), "surprised")
        XCTAssertEqual(StyleMapper.neuttsEmotion(ExpressiveLine(text: "x", emotion: "whisper")), "neutral")
        XCTAssertEqual(StyleMapper.neuttsSpeaker(role: "narrator"), "emily")
        XCTAssertEqual(StyleMapper.neuttsSpeaker(role: "male"), "paul")
        XCTAssertEqual(StyleMapper.neuttsSpeaker(role: "female"), "sophie")
        // Characters never share the narrator's voice.
        XCTAssertEqual(StyleMapper.neuttsSpeaker(role: "male", narrator: "paul"), "steven")
        XCTAssertEqual(StyleMapper.neuttsSpeaker(role: "female", narrator: "sophie"), "emily")
        XCTAssertEqual(StyleMapper.neuttsSpeaker(role: "narrator", narrator: "nobody"), "emily")
    }
}

final class PinnedModelsTests: XCTestCase {
    func testEveryEngineIsPinned() {
        for id in ExpressiveEngineID.allCases {
            guard let m = id.pinned else { return XCTFail("\(id) not pinned") }
            XCTAssertEqual(m.revision.count, 40)
            XCTAssertFalse(m.files.isEmpty)
            XCTAssertGreaterThan(m.totalBytes, 100_000_000)
            for f in m.files {
                XCTAssertEqual(f.sha256.count, 64)
                XCTAssertTrue(PinnedModels.isSafeRelativePath(f.path), f.path)
                let url = m.remoteURL(for: f)?.absoluteString ?? ""
                XCTAssertTrue(url.hasPrefix("https://huggingface.co/\(m.repo)/resolve/\(m.revision)/"), url)
            }
        }
        XCTAssertEqual(PinnedModels.fluidAudioVersion, "0.17.5")
    }

    func testUnsafePathsAreRejected() {
        for p in ["", "/etc/passwd", "../x", "a/../b", "a//b", "a/./b", "a\\b"] {
            XCTAssertFalse(PinnedModels.isSafeRelativePath(p), p)
        }
        XCTAssertTrue(PinnedModels.isSafeRelativePath("v2.1/english/constants_bin/alba.safetensors"))
    }
}

final class ModelStoreTests: XCTestCase {
    func testInstalledStateFollowsTheRecord() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("expressive-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let data = Data("hello".utf8)
        let sha = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        let model = PinnedEngineModel(id: "t", title: "T", repo: "o/r", revision: String(repeating: "a", count: 40), folder: "t",
                                      license: "MIT", licenseURL: "", upstream: "", inApp: false,
                                      files: [PinnedFile(path: "d/f.bin", size: 5, sha256: sha)])
        let store = ModelStore(root: root)
        XCTAssertFalse(store.isInstalled(model))
        let file = store.directory(for: model).appendingPathComponent("d/f.bin")
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: file)
        XCTAssertEqual(try ModelStore.sha256(of: file), sha)
        XCTAssertEqual(store.verifyAll(model), [])
        XCTAssertFalse(store.isInstalled(model), "no record yet")
        let record = InstallRecord(revision: model.revision, verified: ["d/f.bin": sha])
        try JSONEncoder().encode(record).write(to: store.directory(for: model).appendingPathComponent(ModelStore.recordName))
        XCTAssertTrue(store.isInstalled(model))
        XCTAssertEqual(store.bytesOnDisk(model), 5)
        try Data("hellO".utf8).write(to: file)
        XCTAssertEqual(store.verifyAll(model), ["d/f.bin"])
        try store.remove(model)
        XCTAssertFalse(store.isInstalled(model))
        XCTAssertEqual(store.bytesOnDisk(model), 0)
    }
}

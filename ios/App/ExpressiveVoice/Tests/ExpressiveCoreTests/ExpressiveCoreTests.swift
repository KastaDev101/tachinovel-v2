import ExpressiveCore
import XCTest

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
        XCTAssertEqual(StyleMapper.spokenCodes("He said HMM and then AAAH at the APC."), "He said HMM and then AAAH at the A P C.")
        XCTAssertEqual(StyleMapper.spokenCodes("GET DOWN, NOW!"), "GET DOWN, NOW!", "a shouted sentence stays words")
        XCTAssertEqual(StyleMapper.spokenNumbers("the 21st and 40th floors"), "the twenty first and fortieth floors")
        XCTAssertEqual(StyleMapper.pocketText("What... is... going on?"), "What, is, going on?")
        XCTAssertEqual(StyleMapper.pocketText("Ah... not good..."), "Ah, not good.")
    }

    func testPocketTextRawFormKeepsTheTextAsWritten() {
        // Q1's raw arm (tachinovel-tts-lab 2026-10-12): the script's lines read as written, ellipses as "...".
        let q1 = [
            "Hah... hahh... what did you just do to me...",
            "Right there... right there... yes, yes, YES— ohhh... fuuuck... oh...",
            "Eyes on me. No— on me. Mmm... that's it. Ah— keep that pace... exactly that... god, you're doing so well... mmh...",
            "\"Did you lock the gate?\" A long pause. \"...Define locked.\"",
            "Closer. Closer. Faster now. Faster. Hold the line, hold it, hold it... NOOOW!",
            "Please... please, open the door... please... OPEN IT!",
            "Again. Again! Ha... we did it... we actually DID it!",
            "Kai... Kai! KAI!",
            "Don't stop... don't you dare stop... I'm— OH, GOD— mmmh... god... fuuuuck...",
            "Heh... ah— you want more, don't you? I can tell... mmm... ask me nicely.",
            "Hmmm... you came back.",
            "\"Race you to the top! Loser carries the packs for a week! Ready, set...\" She was already running. \"Go!\"",
        ]
        for line in q1 { XCTAssertEqual(StyleMapper.pocketText(line, form: .raw), line) }
        XCTAssertEqual(StyleMapper.pocketText("Hmm… I don’t bite… often.", form: .raw), "Hmm... I don’t bite... often.", "every \"…\" as \"...\"")
        XCTAssertEqual(StyleMapper.pocketText("Well. . . maybe…. Or not.", form: .raw), "Well... maybe... Or not.")
        // What a book needs stays: numbers, codes, real acronyms spelled, a broken word joined.
        XCTAssertEqual(StyleMapper.pocketText("There are 312 steps, 1,500 lanterns and a 3rd gate.", form: .raw),
                       "There are three hundred twelve steps, one thousand five hundred lanterns and a third gate.")
        XCTAssertEqual(StyleMapper.pocketText("The NPC rolled past gate L0-49.", form: .raw), "The N P C rolled past gate L zero forty nine.")
        XCTAssertEqual(StyleMapper.pocketText("His HP fell... and the AI said OK.", form: .raw), "His H P fell... and the A I said OK.")
        XCTAssertEqual(StyleMapper.pocketText("'Damna... tion...'", form: .raw), "'Damnation...'")
        XCTAssertEqual(StyleMapper.pocketText("It's imposs… ible!", form: .raw), "It's impossible!")
        // Shouted words stay words (the app's form never shows them to spokenCodes: nanoText lower-cases them first).
        XCTAssertEqual(StyleMapper.spokenCodes("Please, OPEN IT and STAY there, Kai.", acronymsOnly: true), "Please, OPEN IT and STAY there, Kai.")
        XCTAssertEqual(StyleMapper.spokenCodes("Please, OPEN IT and STAY there, Kai."), "Please, O P E N IT and S T A Y there, Kai.", "the app's form, unchanged")
        // The default is the app's form, exactly.
        XCTAssertEqual(StyleMapper.pocketText("Hmmm. HMM? Hmm…", form: .app), StyleMapper.pocketText("Hmmm. HMM? Hmm…"))
    }

    func testPlainTextRemovesSoundTags() {
        XCTAssertEqual(StyleMapper.plainText("“It was a fair price, I swear [chuckle]. Well, almost fair.”"), "“It was a fair price, I swear. Well, almost fair.”")
        XCTAssertEqual(StyleMapper.plainText("[gasp] “It’s coming from the cellar!”"), "“It’s coming from the cellar!”")
        XCTAssertEqual(StyleMapper.plainText("[Sigh] fine [clear throat] then."), "fine then.")
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

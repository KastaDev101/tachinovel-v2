//
//  PinnedModels.swift — the model files of each experimental engine, pinned by Hugging Face revision and
//  SHA-256. The list itself is generated (PinnedModels.generated.swift ← ios/expressive-models.lock.json,
//  tools/expressive-models.ts); this file only holds the types.
//

import Foundation

public struct PinnedFile: Sendable, Equatable {
    /// Path inside the Hugging Face repo, also the path under the engine's local folder.
    public let path: String
    public let size: Int64
    /// Lowercase hex SHA-256 of the file's bytes.
    public let sha256: String

    public init(path: String, size: Int64, sha256: String) {
        self.path = path
        self.size = size
        self.sha256 = sha256
    }
}

public struct PinnedEngineModel: Sendable, Equatable {
    public let id: String
    public let title: String
    public let repo: String
    public let revision: String
    /// Folder under FluidAudio's TTS model cache (`TtsCacheDirectory/Models/<folder>`), where its loaders look.
    public let folder: String
    public let license: String
    public let licenseURL: String
    public let upstream: String
    /// Offered in the app's Voice Lab (false: CI benchmark only).
    public let inApp: Bool
    public let files: [PinnedFile]

    public init(id: String, title: String, repo: String, revision: String, folder: String, license: String,
                licenseURL: String, upstream: String, inApp: Bool, files: [PinnedFile]) {
        self.id = id
        self.title = title
        self.repo = repo
        self.revision = revision
        self.folder = folder
        self.license = license
        self.licenseURL = licenseURL
        self.upstream = upstream
        self.inApp = inApp
        self.files = files
    }

    public var totalBytes: Int64 { files.reduce(0) { $0 + $1.size } }

    /// `https://huggingface.co/<repo>/resolve/<revision>/<path>` (immutable: a commit, never a branch).
    public func remoteURL(for file: PinnedFile) -> URL? {
        guard PinnedModels.isSafeRelativePath(file.path),
              let encoded = file.path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return nil }
        return URL(string: "https://huggingface.co/\(repo)/resolve/\(revision)/\(encoded)")
    }
}

public enum PinnedModels {
    public static func model(_ id: String) -> PinnedEngineModel? {
        all.first { $0.id == id }
    }

    /// A relative path that stays inside its folder (no "..", no absolute path, no empty component).
    public static func isSafeRelativePath(_ path: String) -> Bool {
        guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\\") else { return false }
        return path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }
}

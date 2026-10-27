import Foundation

// Offene Dateien (Dokumente in Tabs, Quelldateien, Ordner für Exporte). Die Oberfläche kennt nur Kennungen.
// Dateien aus der Dateien-App werden an Ort und Stelle bearbeitet: Zugriff mit Sicherheitsbereich, Lesezeichen für
// „Zuletzt geöffnet“, Lesen und Schreiben über NSFileCoordinator (iCloud und andere Anbieter laden und sichern dann
// richtig).
final class OpenFile {
    let id: String
    var url: URL
    var scoped: Bool
    var untitled: Bool
    var size: Int = 0
    var modified: Date?

    init(id: String, url: URL, scoped: Bool, untitled: Bool) {
        self.id = id
        self.url = url
        self.scoped = scoped
        self.untitled = untitled
    }

    var name: String { url.lastPathComponent }

    // Ordnername für die Anzeige („iCloud Drive“, „Downloads“, „Auf meinem iPad“ …)
    var dir: String {
        if untitled { return "" }
        let parent = url.deletingLastPathComponent()
        if let localized = try? parent.resourceValues(forKeys: [.localizedNameKey]).localizedName, !localized.isEmpty { return localized }
        let last = parent.lastPathComponent
        return last == "com~apple~CloudDocs" ? "iCloud Drive" : last
    }
}

final class FileRegistry {
    private var files: [String: OpenFile] = [:]
    private let lock = NSLock()

    func get(_ id: String) -> OpenFile? {
        lock.lock()
        defer { lock.unlock() }
        return files[id]
    }

    // Datei anmelden; scoped: Zugriff wurde mit startAccessingSecurityScopedResource geöffnet
    func register(url: URL, scoped: Bool, untitled: Bool = false) throws -> OpenFile {
        let file = OpenFile(id: UUID().uuidString.lowercased(), url: url, scoped: scoped, untitled: untitled)
        try refresh(file, coordinated: true)
        lock.lock()
        files[file.id] = file
        lock.unlock()
        return file
    }

    // Größe und Änderungszeit lesen. coordinated: über den Koordinator (lädt Dateien aus iCloud vorher herunter)
    func refresh(_ file: OpenFile, coordinated: Bool) throws {
        var failure: Error?
        let read = { (url: URL) in
            do {
                let values = try url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey])
                if values.isRegularFile == false { throw BridgeError("not-a-file") }
                file.size = values.fileSize ?? 0
                file.modified = values.contentModificationDate
            } catch {
                failure = error
            }
        }
        if coordinated {
            var coordinationError: NSError?
            NSFileCoordinator().coordinate(readingItemAt: file.url, options: [], error: &coordinationError) { read($0) }
            if let coordinationError { throw coordinationError }
        } else {
            read(file.url)
        }
        if let failure { throw failure }
    }

    // Bereits geöffneter Ort (Ordner für Exporte); Größe und Zeit zählen hier nicht
    func adopt(_ file: OpenFile) {
        lock.lock()
        files[file.id] = file
        lock.unlock()
    }

    func close(_ id: String) {
        lock.lock()
        let file = files.removeValue(forKey: id)
        lock.unlock()
        guard let file else { return }
        if file.scoped { file.url.stopAccessingSecurityScopedResource() }
        Staging.removeIfStaged(file.url)
    }

    // Andere Datei unter derselben Kennung (nach „Sichern unter“)
    func replace(_ id: String, with other: OpenFile) {
        lock.lock()
        defer { lock.unlock() }
        guard let current = files[id] else { return }
        if current.scoped { current.url.stopAccessingSecurityScopedResource() }
        Staging.removeIfStaged(current.url)
        current.url = other.url
        current.scoped = other.scoped
        current.untitled = other.untitled
        current.size = other.size
        current.modified = other.modified
        files.removeValue(forKey: other.id)
    }

    func read(_ id: String, begin: Int, end: Int) throws -> Data {
        guard let file = get(id) else { throw BridgeError("unknown-file") }
        let handle = try FileHandle(forReadingFrom: file.url)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(max(0, begin)))
        return try handle.read(upToCount: max(0, end - begin)) ?? Data()
    }

    // true, wenn die Datei auf dem Speicher noch dem Stand beim Öffnen bzw. letzten Sichern entspricht
    func isUnchanged(_ file: OpenFile) -> Bool {
        guard let values = try? file.url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]) else { return false }
        return values.fileSize == file.size && values.contentModificationDate == file.modified
    }

    // Über die vorhandene Datei schreiben. Erst atomar (temporäre Datei daneben, dann umbenennen); erlaubt der Anbieter
    // keine neue Datei im Ordner (Zugriff nur auf diese eine Datei), direkt in die Datei.
    func write(_ data: Data, to file: OpenFile) throws {
        try Self.coordinatedWrite(data, to: file.url)
        try refresh(file, coordinated: false)
    }

    static func coordinatedWrite(_ data: Data, to url: URL) throws {
        var coordinationError: NSError?
        var writeError: Error?
        NSFileCoordinator().coordinate(writingItemAt: url, options: [.forReplacing], error: &coordinationError) { target in
            do {
                try data.write(to: target, options: [.atomic])
            } catch {
                do {
                    try data.write(to: target, options: [])
                } catch {
                    writeError = error
                }
            }
        }
        if let coordinationError { throw coordinationError }
        if let writeError { throw writeError }
    }

    // Lesezeichen für dauerhaften Zugriff (Zuletzt geöffnet)
    static func bookmark(for url: URL) -> String? {
        (try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil))?.base64EncodedString()
    }

    static func resolve(bookmark: String) -> URL? {
        guard let data = Data(base64Encoded: bookmark) else { return nil }
        var stale = false
        return try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
    }
}

// Temporäre Dateien: unbenannte Dokumente, Kopien abgelegter Dateien, neue Dateien vor dem Sichern-Dialog
enum Staging {
    static let folder = FileManager.default.temporaryDirectory.appendingPathComponent("Blattwerk", isDirectory: true)

    static func removeLeftovers() {
        try? FileManager.default.removeItem(at: folder)
    }

    // Eigener Unterordner je Datei, damit der Name (für den Sichern-Dialog) frei bleibt
    static func write(_ data: Data, name: String) throws -> URL {
        let dir = folder.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(safeName(name))
        try data.write(to: url, options: [.atomic])
        return url
    }

    static func isStaged(_ url: URL) -> Bool {
        url.standardizedFileURL.path.hasPrefix(folder.standardizedFileURL.path + "/")
    }

    static func removeIfStaged(_ url: URL) {
        if isStaged(url) { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    }

    // Kein Pfadtrenner, keine versteckten Dateien, nicht leer
    static func safeName(_ name: String) -> String {
        var cleaned = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        while cleaned.hasPrefix(".") { cleaned.removeFirst() }
        cleaned = String(cleaned.prefix(200)).trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? "Dokument" : cleaned
    }
}

// Ablage der App (Einstellungen, Zuletzt geöffnet, Unterschriften, eigene Vorlagen, Vorschaubilder)
enum Storage {
    static let root: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Blattwerk", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }()

    // Relativer Pfad → Datei in der Ablage; nichts außerhalb, keine versteckten Teile
    static func url(for relative: String) -> URL? {
        let parts = relative.split(separator: "/").map(String.init)
        guard !parts.isEmpty, parts.count <= 3, parts.allSatisfy({ !$0.isEmpty && !$0.hasPrefix(".") && $0 != ".." }) else { return nil }
        return parts.reduce(root) { $0.appendingPathComponent($1) }
    }

    static func read(_ relative: String) -> Data? {
        guard let url = url(for: relative) else { return nil }
        return try? Data(contentsOf: url)
    }

    static func write(_ relative: String, _ data: Data) throws {
        guard let url = url(for: relative) else { throw BridgeError("invalid-path") }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: [.atomic])
    }

    static func remove(_ relative: String) {
        guard let url = url(for: relative) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    static func list(_ relative: String) -> [[String: Any]] {
        guard let dir = url(for: relative),
              let names = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])
        else { return [] }
        return names.map { url in
            let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)?.timeIntervalSince1970 ?? 0
            return ["name": url.lastPathComponent, "modified": modified * 1000]
        }
    }
}

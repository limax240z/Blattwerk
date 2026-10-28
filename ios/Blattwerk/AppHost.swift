import UIKit
import UniformTypeIdentifiers
import WebKit

// Bausteine der Hülle für die Oberfläche (Gegenstück: src/ios/api.ts). Aufrufe kommen über die Brücke (call) oder als
// Anfrage an app://bundle/__native/… (handleNative, für Bytes).
final class AppHost: NSObject {
    let files = FileRegistry()
    private weak var controller: WebViewController?
    private var ready = false
    // Dateien, die iPadOS übergibt, bevor die Oberfläche bereit ist
    private var pendingIncoming: [[String: Any]] = []
    private var pickerDelegate: PickerDelegate?
    private let pdfMaker = HtmlToPdf()
    // Bytes von der Oberfläche, stückweise über die Brücke angeliefert (upload.chunk): Auf dem Gerät reicht WebKit den
    // Rumpf von fetch an den Schema-Handler nicht weiter (im Simulator schon). Abgeholt mit ?upload=<Kennung>.
    private var uploads: [String: Data] = [:]
    private let uploadLock = NSLock()
    private static let maxUploadBytes = 1536 << 20

    func attach(controller: WebViewController) {
        self.controller = controller
    }

    // MARK: Aufrufe über die Brücke

    func call(_ method: String, _ args: [String: Any], reply: @escaping (Result<Any?, BridgeError>) -> Void) {
        switch method {
        case "log":
            DebugLog.write(args["text"] as? String ?? "")
            reply(.success(nil))
        case "ready":
            ready = true
            for file in pendingIncoming { emit("fileOpened", file) }
            pendingIncoming.removeAll()
            #if DEBUG
            // Entwicklung im Simulator: SIMCTL_CHILD_BLATTWERK_EVAL=<Pfad zu .js> führt ein Prüfskript in der Oberfläche aus
            if let path = ProcessInfo.processInfo.environment["BLATTWERK_EVAL"], let script = try? String(contentsOfFile: path, encoding: .utf8) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                    self?.controller?.webView.evaluateJavaScript(script)
                }
            }
            #endif
            reply(.success(nil))
        case "appInfo":
            let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
            reply(.success(["version": version]))
        case "files.pick":
            let types = (args["types"] as? [String] ?? []).compactMap { UTType($0) }
            pickDocuments(types: types.isEmpty ? [.pdf] : types, multiple: args["multiple"] as? Bool ?? false) { reply(.success($0)) }
        case "files.openBookmark":
            guard let bookmark = args["bookmark"] as? String, let url = FileRegistry.resolve(bookmark: bookmark) else {
                reply(.success(nil))
                return
            }
            let scoped = url.startAccessingSecurityScopedResource()
            do {
                let file = try files.register(url: url, scoped: scoped)
                reply(.success(describe(file, bookmark: FileRegistry.bookmark(for: url) ?? bookmark)))
            } catch {
                if scoped { url.stopAccessingSecurityScopedResource() }
                reply(.success(nil))
            }
        case "files.info":
            guard let id = args["fileId"] as? String, let file = files.get(id) else {
                reply(.success(nil))
                return
            }
            reply(.success(describe(file)))
        case "files.close":
            if let id = args["fileId"] as? String { files.close(id) }
            reply(.success(nil))
        case "files.export":
            exportStaged(args, reply: reply)
        case "files.pickFolder":
            pickFolder { reply(.success($0)) }
        case "files.releaseFolder":
            if let id = args["folderId"] as? String { files.close(id) }
            reply(.success(nil))
        case "store.list":
            reply(.success(Storage.list(args["dir"] as? String ?? "")))
        case "upload.chunk":
            guard let id = args["id"] as? String, id.count <= 64, let base64 = args["data"] as? String, let chunk = Data(base64Encoded: base64) else {
                reply(.failure(BridgeError("invalid-chunk")))
                return
            }
            uploadLock.lock()
            let size = (uploads[id]?.count ?? 0) + chunk.count
            if size <= Self.maxUploadBytes { uploads[id, default: Data()].append(chunk) } else { uploads.removeValue(forKey: id) }
            uploadLock.unlock()
            reply(size <= Self.maxUploadBytes ? .success(nil) : .failure(BridgeError("too-large")))
        case "upload.discard":
            if let id = args["id"] as? String {
                uploadLock.lock()
                uploads.removeValue(forKey: id)
                uploadLock.unlock()
            }
            reply(.success(nil))
        case "store.remove":
            if let path = args["path"] as? String { Storage.remove(path) }
            reply(.success(nil))
        case "fonts.available":
            let names = args["names"] as? [String] ?? []
            reply(.success(Dictionary(uniqueKeysWithValues: names.map { ($0, Fonts.fileURL(postscriptName: $0) != nil) })))
        case "htmlToPdf":
            guard let html = args["html"] as? String, let page = args["page"] as? [String: Any], let view = controller?.view else {
                reply(.failure(BridgeError("invalid-data")))
                return
            }
            pdfMaker.make(html: html, page: PageSetup(page), in: view) { result in
                switch result {
                case .success(let data): reply(.success(data.base64EncodedString()))
                case .failure(let error): reply(.failure(BridgeError(String(describing: error))))
                }
            }
        case "print":
            print(name: args["name"] as? String ?? "Blattwerk", reply: reply)
        case "menu.set":
            MenuBar.shared.update(menus: args["menus"] as? [[String: Any]] ?? []) { [weak self] id in self?.emit("menu", id) }
            reply(.success(nil))
        case "openExternal":
            openExternal(args) { reply(.success($0)) }
        case "about":
            let version = args["version"] as? String ?? ""
            let name = args["name"] as? String ?? "Blattwerk"
            alert(title: name, message: version) { reply(.success(nil)) }
        default:
            reply(.failure(BridgeError("unknown-method")))
        }
    }

    // Ereignis an die Oberfläche (src/ios/native.ts: on)
    func emit(_ event: String, _ payload: Any) {
        guard let data = try? JSONSerialization.data(withJSONObject: [event, payload], options: [.fragmentsAllowed]),
              let json = String(data: data, encoding: .utf8)
        else { return }
        controller?.webView.evaluateJavaScript("(() => { const [e, p] = \(json); window.__blattwerkNative?.emit(e, p); })()")
    }

    private func describe(_ file: OpenFile, bookmark: String? = nil) -> [String: Any] {
        var info: [String: Any] = ["fileId": file.id, "name": file.name, "dir": file.dir, "size": file.size]
        if file.untitled { info["untitled"] = true }
        if !file.untitled, let mark = bookmark ?? (file.scoped ? FileRegistry.bookmark(for: file.url) : nil) { info["bookmark"] = mark }
        return info
    }

    // MARK: Dateien, die iPadOS übergibt

    func openIncoming(_ url: URL, inPlace: Bool) {
        let scoped = url.startAccessingSecurityScopedResource()
        do {
            // Ohne „an Ort und Stelle“ liegt eine Kopie im Eingang der App; sie gilt als unbenannt (Sichern fragt nach dem Ort)
            let file = try files.register(url: url, scoped: scoped, untitled: !inPlace)
            let info = describe(file, bookmark: inPlace ? FileRegistry.bookmark(for: url) : nil)
            if ready { emit("fileOpened", info) } else { pendingIncoming.append(info) }
        } catch {
            if scoped { url.stopAccessingSecurityScopedResource() }
        }
    }

    // MARK: Bytes über app://bundle/__native/…

    func handleNative(_ request: NativeRequest, respond: @escaping (NativeResponse) -> Void) {
        let parts = request.path.split(separator: "/", maxSplits: 1).map(String.init)
        let kind = parts.first ?? ""
        let rest = parts.count > 1 ? parts[1] : ""
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            respond(nativeResponse(kind: kind, rest: rest, request: request))
        }
    }

    private func nativeResponse(kind: String, rest: String, request: NativeRequest) -> NativeResponse {
        switch (kind, request.method) {
        case ("file", "GET"):
            let begin = Int(request.query["begin"] ?? "") ?? 0
            let end = Int(request.query["end"] ?? "") ?? 0
            guard end >= begin, end - begin <= 64 << 20 else { return .error(400, "invalid-range") }
            do {
                return .bytes(try files.read(rest, begin: begin, end: end))
            } catch {
                return .notFound
            }
        case ("save", "PUT"):
            guard let data = completeBody(request) else { return .error(400, "incomplete-body") }
            guard let file = files.get(rest) else { return .json(["ok": false, "error": "unknown-file"]) }
            if request.query["force"] != "1", !files.isUnchanged(file) { return .json(["ok": false, "error": "changed-externally"]) }
            do {
                try files.write(data, to: file)
                return .json(["ok": true, "file": describe(file)])
            } catch {
                return .json(["ok": false, "error": "write-failed", "detail": String(describing: error)])
            }
        case ("stage", "PUT"):
            guard let data = completeBody(request) else { return .error(400, "incomplete-body") }
            do {
                let url = try Staging.write(data, name: request.query["name"] ?? "Dokument.pdf")
                if request.query["open"] == "1" {
                    let file = try files.register(url: url, scoped: false, untitled: true)
                    return .json(describe(file))
                }
                return .json(["stageId": url.deletingLastPathComponent().lastPathComponent + "/" + url.lastPathComponent])
            } catch {
                return .error(500, String(describing: error))
            }
        case ("folder", "PUT"):
            guard let data = completeBody(request) else { return .error(400, "incomplete-body") }
            guard let folder = files.get(rest) else { return .json(["ok": false, "error": "unknown-folder"]) }
            do {
                let name = try writeUnique(data, name: Staging.safeName(request.query["name"] ?? "Datei"), in: folder.url)
                return .json(["ok": true, "name": name])
            } catch {
                return .json(["ok": false, "error": "write-failed", "detail": String(describing: error)])
            }
        case ("store", "GET"):
            guard let data = Storage.read(rest) else { return .notFound }
            return .bytes(data)
        case ("store", "PUT"):
            guard let data = completeBody(request) else { return .error(400, "incomplete-body") }
            do {
                try Storage.write(rest, data)
                return .json(true)
            } catch {
                return .error(500, String(describing: error))
            }
        case ("font", "GET"):
            guard let url = Fonts.fileURL(postscriptName: rest), let data = try? Data(contentsOf: url), data.count <= 40 << 20 else { return .notFound }
            return .bytes(data)
        default:
            return .notFound
        }
    }

    // Bytes einer Anfrage: aus den angelieferten Stücken (upload) oder dem Rumpf. Nur vollständig: Die Oberfläche schickt
    // die Länge mit (len); fehlt sie oder stimmt sie nicht, wird nichts geschrieben (sonst könnte eine Datei leer oder
    // abgeschnitten überschrieben werden).
    private func completeBody(_ request: NativeRequest) -> Data? {
        var body = request.body
        if let id = request.query["upload"] {
            uploadLock.lock()
            body = uploads.removeValue(forKey: id)
            uploadLock.unlock()
        }
        guard let body, let expected = request.query["len"].flatMap(Int.init), expected > 0, body.count == expected else { return nil }
        return body
    }

    // „Name.pdf“, sonst „Name (2).pdf“ …; vorhandene Dateien werden nie überschrieben
    private func writeUnique(_ data: Data, name: String, in folder: URL) throws -> String {
        let ext = (name as NSString).pathExtension
        let base = (name as NSString).deletingPathExtension
        for n in 1..<10000 {
            let candidate = n == 1 ? name : "\(base) (\(n))\(ext.isEmpty ? "" : ".\(ext)")"
            let url = folder.appendingPathComponent(candidate)
            if FileManager.default.fileExists(atPath: url.path) { continue }
            try FileRegistry.coordinatedWrite(data, to: url)
            return candidate
        }
        throw BridgeError("no-free-name")
    }

    // MARK: Auswahl- und Sichern-Dialoge der Dateien-App

    private func present(_ picker: UIDocumentPickerViewController, onPick: @escaping ([URL]) -> Void) {
        guard let controller else {
            onPick([])
            return
        }
        let delegate = PickerDelegate { [weak self] urls in
            self?.pickerDelegate = nil
            onPick(urls)
        }
        pickerDelegate = delegate
        picker.delegate = delegate
        // Nur ein Dialog zugleich: Ein noch offener wird geschlossen
        if let presented = controller.presentedViewController {
            presented.dismiss(animated: false)
        }
        controller.present(picker, animated: true)
    }

    private func pickDocuments(types: [UTType], multiple: Bool, done: @escaping ([[String: Any]]) -> Void) {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: false)
        picker.allowsMultipleSelection = multiple
        present(picker) { [self] urls in
            done(urls.compactMap { url in
                let scoped = url.startAccessingSecurityScopedResource()
                guard let file = try? files.register(url: url, scoped: scoped) else {
                    if scoped { url.stopAccessingSecurityScopedResource() }
                    return nil
                }
                return describe(file, bookmark: FileRegistry.bookmark(for: url))
            })
        }
    }

    private func pickFolder(done: @escaping ([String: Any]) -> Void) {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
        present(picker) { [self] urls in
            guard let url = urls.first else {
                done(["ok": false])
                return
            }
            let scoped = url.startAccessingSecurityScopedResource()
            let folder = OpenFile(id: UUID().uuidString.lowercased(), url: url, scoped: scoped, untitled: false)
            files.adopt(folder)
            done(["ok": true, "folderId": folder.id, "name": url.lastPathComponent])
        }
    }

    // Vorbereitete Dateien über den Sichern-Dialog an einen gewählten Ort bewegen
    private func exportStaged(_ args: [String: Any], reply: @escaping (Result<Any?, BridgeError>) -> Void) {
        let urls = (args["stageIds"] as? [String] ?? []).map { Staging.folder.appendingPathComponent($0) }
        guard !urls.isEmpty, urls.allSatisfy({ Staging.isStaged($0) && FileManager.default.fileExists(atPath: $0.path) }) else {
            reply(.success(["ok": false, "error": "invalid-data"]))
            return
        }
        let register = args["register"] as? Bool ?? false
        let replaceId = args["replaceFileId"] as? String
        let picker = UIDocumentPickerViewController(forExporting: urls, asCopy: true)
        present(picker) { [self] picked in
            for url in urls { Staging.removeIfStaged(url) }
            guard !picked.isEmpty else {
                reply(.success(["ok": false, "error": "cancelled"]))
                return
            }
            var described: [[String: Any]] = []
            for url in picked {
                if !register {
                    described.append(["fileId": "", "name": url.lastPathComponent, "dir": url.deletingLastPathComponent().lastPathComponent, "size": 0])
                    continue
                }
                let scoped = url.startAccessingSecurityScopedResource()
                guard let file = try? files.register(url: url, scoped: scoped) else {
                    if scoped { url.stopAccessingSecurityScopedResource() }
                    reply(.success(["ok": false, "error": "write-failed", "detail": "reopen"]))
                    return
                }
                let bookmark = FileRegistry.bookmark(for: url)
                if let replaceId, files.get(replaceId) != nil {
                    files.replace(replaceId, with: file)
                    described.append(describe(files.get(replaceId)!, bookmark: bookmark))
                } else {
                    described.append(describe(file, bookmark: bookmark))
                }
            }
            reply(.success(["ok": true, "files": described]))
        }
    }

    // MARK: Drucken, Links, Hinweise

    private func print(name: String, reply: @escaping (Result<Any?, BridgeError>) -> Void) {
        guard let controller, UIPrintInteractionController.isPrintingAvailable else {
            reply(.success(["ok": false, "reason": "failed"]))
            return
        }
        let info = UIPrintInfo.printInfo()
        info.jobName = name
        info.outputType = .general
        let printer = UIPrintInteractionController.shared
        printer.printInfo = info
        printer.printFormatter = controller.webView.viewPrintFormatter()
        let view = controller.view!
        let anchor = CGRect(x: view.bounds.midX, y: view.safeAreaInsets.top + 20, width: 1, height: 1)
        printer.present(from: anchor, in: view, animated: true) { _, completed, error in
            if error != nil {
                reply(.success(["ok": false, "reason": "failed"]))
            } else {
                reply(.success(completed ? ["ok": true] : ["ok": false, "reason": "cancelled"]))
            }
        }
    }

    // Nur http, https und mailto, ohne Zugangsdaten; vorher Rückfrage mit dem Zielserver (Texte aus der Oberfläche)
    private func openExternal(_ args: [String: Any], done: @escaping (Bool) -> Void) {
        guard let text = args["url"] as? String, let url = URL(string: text), let scheme = url.scheme?.lowercased(),
              ["http", "https", "mailto"].contains(scheme), url.user == nil, url.password == nil, let controller
        else {
            done(false)
            return
        }
        let alert = UIAlertController(title: args["message"] as? String ?? text, message: args["detail"] as? String, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: args["cancel"] as? String ?? "Abbrechen", style: .cancel) { _ in done(false) })
        alert.addAction(UIAlertAction(title: args["open"] as? String ?? "Öffnen", style: .default) { _ in
            UIApplication.shared.open(url)
            done(true)
        })
        controller.present(alert, animated: true)
    }

    private func alert(title: String, message: String, done: @escaping () -> Void) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in done() })
        controller?.present(alert, animated: true)
    }
}

// MARK: Navigation: nur die eigene Oberfläche, keine neuen Fenster

extension AppHost: WKNavigationDelegate, WKUIDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        decisionHandler(url?.scheme == "app" && url?.host == "bundle" ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        nil
    }

    // Abgestürzter Inhaltsprozess (z. B. zu wenig Speicher): Oberfläche neu laden
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        ready = false
        webView.reload()
    }

    // Rückfragen der Oberfläche (window.confirm, window.alert) als Systemdialog
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        alert(title: "", message: message, done: completionHandler)
    }
}

final class PickerDelegate: NSObject, UIDocumentPickerDelegate {
    private let done: ([URL]) -> Void
    private var finished = false

    init(done: @escaping ([URL]) -> Void) {
        self.done = done
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        finish(urls)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finish([])
    }

    private func finish(_ urls: [URL]) {
        guard !finished else { return }
        finished = true
        done(urls)
    }
}

// Meldungen für die Entwicklung: Systemprotokoll, in Debug-Builds zusätzlich Library/Caches/oberflaeche.log
// (scripts/run-ios-sim.sh gibt die Datei aus)
enum DebugLog {
    static func write(_ text: String) {
        NSLog("[Blattwerk] %@", text)
        #if DEBUG
        let log = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("oberflaeche.log")
        if let handle = try? FileHandle(forWritingTo: log) {
            handle.seekToEndOfFile()
            handle.write(Data((text + "\n").utf8))
            try? handle.close()
        } else {
            try? Data((text + "\n").utf8).write(to: log)
        }
        #endif
    }
}

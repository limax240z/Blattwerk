import Foundation
import WebKit

// app://bundle/… liefert die Oberfläche aus dem Ordner „web“ der App, mit derselben CSP wie auf dem Mac in jeder
// Antwort (auch für Worker). app://bundle/__native/… sind Bytes der Hülle: Dateien lesen und schreiben, Ablage,
// Schriften (siehe AppHost.handleNative).
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    private let host: AppHost
    private let root = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true).standardizedFileURL
    private let csp: String
    // Abgebrochene Aufgaben dürfen keine Antwort mehr bekommen
    private var stopped = Set<ObjectIdentifier>()
    private let queue = DispatchQueue(label: "de.blattwerk.scheme", qos: .userInitiated, attributes: .concurrent)

    static let mimeTypes: [String: String] = [
        "html": "text/html; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "json": "application/json; charset=utf-8",
        "wasm": "application/wasm",
        "svg": "image/svg+xml",
        "png": "image/png",
        "jpg": "image/jpeg",
        "ftl": "text/plain; charset=utf-8",
        "bcmap": "application/octet-stream",
        "pfb": "application/octet-stream",
        "ttf": "font/ttf",
        "gz": "application/gzip",
        "traineddata": "application/octet-stream",
        "txt": "text/plain; charset=utf-8",
    ]

    init(host: AppHost) {
        self.host = host
        let cspURL = Bundle.main.resourceURL!.appendingPathComponent("web/csp.txt")
        csp = (try? String(contentsOf: cspURL, encoding: .utf8)) ?? "default-src 'none'"
        super.init()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, url.host == "bundle" else {
            respond(urlSchemeTask, status: 404, body: Data(), type: "text/plain")
            return
        }
        let path = url.path
        if path.hasPrefix("/__native/") {
            let original = urlSchemeTask.request
            // Den Rumpf nicht im Hauptthread lesen: Als Strom kann er blockieren, bis WebKit ihn geliefert hat
            queue.async { [weak self] in
                guard let self else { return }
                let request = NativeRequest(
                    path: String(path.dropFirst("/__native/".count)),
                    method: original.httpMethod ?? "GET",
                    query: Dictionary(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.map { ($0.name, $0.value ?? "") } ?? [], uniquingKeysWith: { _, last in last }),
                    body: Self.body(of: original)
                )
                self.host.handleNative(request) { [weak self] response in
                    self?.respond(urlSchemeTask, status: response.status, body: response.body, type: response.type)
                }
            }
            return
        }
        queue.async { [weak self] in
            guard let self else { return }
            let relative = path.hasPrefix("/") ? String(path.dropFirst()) : path
            let file = self.root.appendingPathComponent(relative.isEmpty ? "index.html" : relative).standardizedFileURL
            // Nur Dateien unterhalb von „web“
            guard file.path.hasPrefix(self.root.path + "/"), let data = try? Data(contentsOf: file) else {
                self.respond(urlSchemeTask, status: 404, body: Data(), type: "text/plain")
                return
            }
            let type = Self.mimeTypes[file.pathExtension.lowercased()] ?? "application/octet-stream"
            self.respond(urlSchemeTask, status: 200, body: data, type: type)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        DispatchQueue.main.async { self.stopped.insert(ObjectIdentifier(urlSchemeTask)) }
    }

    // Rumpf einer Anfrage: direkt oder als Strom (auf dem Gerät liefert WebKit Rümpfe als Strom). Lesen bis zum Ende
    // (read liefert 0); hasBytesAvailable ist am Anfang oft noch falsch, der Rumpf kam dann leer an (Vorlagen auf dem
    // iPhone öffneten als leere Datei). Ein Lesefehler gilt als fehlender Rumpf.
    private static func body(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let size = 1 << 20
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: size)
        defer { buffer.deallocate() }
        while true {
            let read = stream.read(buffer, maxLength: size)
            if read < 0 { return nil }
            if read == 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }

    private func respond(_ task: WKURLSchemeTask, status: Int, body: Data, type: String) {
        DispatchQueue.main.async {
            let id = ObjectIdentifier(task)
            if self.stopped.remove(id) != nil { return }
            let headers = [
                "Content-Type": type,
                "Content-Length": String(body.count),
                "Content-Security-Policy": self.csp,
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "no-store",
            ]
            guard let url = task.request.url, let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else { return }
            task.didReceive(response)
            task.didReceive(body)
            task.didFinish()
        }
    }
}

struct NativeRequest {
    let path: String
    let method: String
    let query: [String: String]
    let body: Data?
}

struct NativeResponse {
    let status: Int
    let body: Data
    let type: String

    static func bytes(_ data: Data) -> NativeResponse { NativeResponse(status: 200, body: data, type: "application/octet-stream") }
    static func json(_ value: Any) -> NativeResponse {
        let data = (try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])) ?? Data("null".utf8)
        return NativeResponse(status: 200, body: data, type: "application/json")
    }
    static func error(_ status: Int, _ message: String) -> NativeResponse { NativeResponse(status: status, body: Data(message.utf8), type: "text/plain") }
    static let notFound = NativeResponse(status: 404, body: Data(), type: "text/plain")
}

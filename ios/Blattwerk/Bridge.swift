import Foundation
import WebKit

// Nachrichten der Oberfläche (src/ios/native.ts: call): { method, args } → Antwort als JSON-Wert oder Fehlertext.
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    private weak var host: AppHost?

    init(host: AppHost) {
        self.host = host
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        // Nur die eigene Oberfläche (app://bundle) darf die Hülle ansprechen
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "app", message.frameInfo.securityOrigin.host == "bundle",
              let body = message.body as? [String: Any], let method = body["method"] as? String, let host
        else {
            replyHandler(nil, "invalid-message")
            return
        }
        let args = body["args"] as? [String: Any] ?? [:]
        host.call(method, args) { result in
            switch result {
            case .success(let value): replyHandler(value ?? NSNull(), nil)
            case .failure(let error): replyHandler(nil, error.message)
            }
        }
    }
}

struct BridgeError: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

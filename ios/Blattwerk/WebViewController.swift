import UIKit
import WebKit

// Hauptansicht: eine WebView mit der Oberfläche aus app://bundle/ (SchemeHandler.swift). Netzwerk gibt es nicht,
// die Oberfläche spricht nur über die Brücke (Bridge.swift) und app://bundle/__native/… mit der Hülle.
final class WebViewController: UIViewController {
    let host = AppHost()
    private(set) var webView: WKWebView!

    override func loadView() {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(SchemeHandler(host: host), forURLScheme: "app")
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addScriptMessageHandler(Bridge(host: host), contentWorld: .page, name: "blattwerk")
        // Seite nicht als Ganzes zoomen: Das Dokument zoomt die Oberfläche selbst (Pinch → src/ios/touch.ts)
        let viewport = WKUserScript(
            source: """
            (() => {
              const meta = document.querySelector('meta[name=viewport]') ?? document.head.appendChild(document.createElement('meta'));
              meta.name = 'viewport';
              meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
            })();
            """,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )
        configuration.userContentController.addUserScript(viewport)
        #if DEBUG
        // Fehler der Oberfläche im Protokoll des Geräts (Entwicklung)
        let errors = WKUserScript(
            source: """
            (() => {
              const send = (text) => window.webkit?.messageHandlers?.blattwerk?.postMessage({ method: 'log', args: { text: String(text) } }).catch(() => {});
              addEventListener('error', (e) => send('error: ' + e.message + ' @ ' + e.filename + ':' + e.lineno));
              addEventListener('unhandledrejection', (e) => send('rejection: ' + (e.reason?.stack ?? e.reason)));
              const original = console.error.bind(console);
              console.error = (...args) => { send('console.error: ' + args.map(String).join(' ')); original(...args); };
            })();
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        configuration.userContentController.addUserScript(errors)
        #endif
        configuration.defaultWebpagePreferences.preferredContentMode = .desktop
        configuration.preferences.isElementFullscreenEnabled = false
        configuration.allowsInlineMediaPlayback = false

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = Self.windowColor
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsLinkPreview = false
        webView.navigationDelegate = host
        webView.uiDelegate = host
        #if DEBUG
        webView.isInspectable = true
        #endif
        self.webView = webView

        let root = UIView()
        root.backgroundColor = Self.windowColor
        root.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            // Bis an alle Ränder; Statusleiste und Home-Balken hält die Oberfläche selbst frei (env(safe-area-inset-*))
            webView.topAnchor.constraint(equalTo: root.topAnchor),
            webView.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
        ])
        view = root
        host.attach(controller: self)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.load(URLRequest(url: URL(string: "app://bundle/index.html")!))
    }

    override var prefersHomeIndicatorAutoHidden: Bool { true }

    // Fensterhintergrund der Oberfläche (--color-bg in tokens.css), hell und dunkel; sichtbar, bis die Seite gezeichnet ist
    static let windowColor = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x1c / 255, green: 0x1d / 255, blue: 0x1a / 255, alpha: 1)
            : UIColor(red: 0xf3 / 255, green: 0xef / 255, blue: 0xe6 / 255, alpha: 1)
    }
}

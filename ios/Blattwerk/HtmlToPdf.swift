import UIKit
import WebKit

// HTML → PDF (Vorlagen, Textdokumente; Gegenstück zu src/main/convert/pdf.ts auf dem Mac). Eine unsichtbare WebView
// ohne JavaScript, ohne Netz (Inhaltsregeln sperren alles außer data:) und ohne gespeicherte Daten setzt die Seite;
// UIPrintPageRenderer teilt sie in Seiten der gewünschten Größe und schreibt ein PDF mit echtem Text.
struct PageSetup {
    let width: CGFloat
    let height: CGFloat
    let insets: UIEdgeInsets

    init(_ dict: [String: Any]) {
        func number(_ value: Any?) -> CGFloat { CGFloat((value as? NSNumber)?.doubleValue ?? 0) }
        let width = number(dict["width"])
        let height = number(dict["height"])
        self.width = width > 0 ? width : 595.28
        self.height = height > 0 ? height : 841.89
        let margins = dict["margins"] as? [String: Any] ?? [:]
        insets = UIEdgeInsets(top: number(margins["top"]), left: number(margins["left"]), bottom: number(margins["bottom"]), right: number(margins["right"]))
    }
}

final class HtmlToPdf: NSObject, WKNavigationDelegate {
    private struct Job {
        let html: String
        let page: PageSetup
        weak var view: UIView?
        let done: (Result<Data, Error>) -> Void
    }

    private var jobs: [Job] = []
    private var current: Job?
    private var webView: WKWebView?
    private var rules: WKContentRuleList?
    private var timeout: DispatchWorkItem?

    func make(html: String, page: PageSetup, in view: UIView, done: @escaping (Result<Data, Error>) -> Void) {
        jobs.append(Job(html: html, page: page, view: view, done: done))
        next()
    }

    private func next() {
        guard current == nil, !jobs.isEmpty else { return }
        let job = jobs.removeFirst()
        current = job
        loadRules { [weak self] rules in
            guard let self else { return }
            guard let rules, let view = job.view else {
                self.finish(.failure(BridgeError("no-rules")))
                return
            }
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            configuration.defaultWebpagePreferences.allowsContentJavaScript = false
            configuration.userContentController.add(rules)
            let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: job.page.width, height: job.page.height), configuration: configuration)
            webView.navigationDelegate = self
            webView.isUserInteractionEnabled = false
            webView.alpha = 0.01
            // Unter der Oberfläche einhängen (ohne Fenster setzt WebKit die Seite nicht)
            view.insertSubview(webView, at: 0)
            self.webView = webView
            let timeout = DispatchWorkItem { [weak self] in self?.finish(.failure(BridgeError("timeout"))) }
            self.timeout = timeout
            DispatchQueue.main.asyncAfter(deadline: .now() + 60, execute: timeout)
            webView.loadHTMLString(job.html, baseURL: nil)
        }
    }

    private func loadRules(_ done: @escaping (WKContentRuleList?) -> Void) {
        if let rules {
            done(rules)
            return
        }
        let json = """
        [{"trigger":{"url-filter":".*"},"action":{"type":"block"}},
         {"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}},
         {"trigger":{"url-filter":"^about:"},"action":{"type":"ignore-previous-rules"}}]
        """
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "blattwerk-convert", encodedContentRuleList: json) { [weak self] list, _ in
            self?.rules = list
            done(list)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Bilder (data:) und Schriften kurz fertig laden lassen
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.render() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(.failure(error))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(.failure(error))
    }

    // Nur das geladene HTML selbst, keine weiteren Seiten
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.request.url?.scheme == "about" ? .allow : .cancel)
    }

    private func render() {
        guard let job = current, let webView else { return }
        let paper = CGRect(x: 0, y: 0, width: job.page.width, height: job.page.height)
        let printable = paper.inset(by: job.page.insets)
        let renderer = UIPrintPageRenderer()
        renderer.addPrintFormatter(webView.viewPrintFormatter(), startingAtPageAt: 0)
        // Papier und bedruckbarer Bereich sind nur lesbar; so setzt man sie für eine Ausgabe ohne Drucker
        renderer.setValue(NSValue(cgRect: paper), forKey: "paperRect")
        renderer.setValue(NSValue(cgRect: printable), forKey: "printableRect")
        let data = NSMutableData()
        UIGraphicsBeginPDFContextToData(data, paper, nil)
        let pages = renderer.numberOfPages
        renderer.prepare(forDrawingPages: NSRange(location: 0, length: pages))
        for index in 0..<pages {
            UIGraphicsBeginPDFPage()
            renderer.drawPage(at: index, in: UIGraphicsGetPDFContextBounds())
        }
        UIGraphicsEndPDFContext()
        finish(pages > 0 ? .success(data as Data) : .failure(BridgeError("empty")))
    }

    private func finish(_ result: Result<Data, Error>) {
        timeout?.cancel()
        timeout = nil
        webView?.removeFromSuperview()
        webView = nil
        let job = current
        current = nil
        job?.done(result)
        next()
    }
}

enum Fonts {
    // Datei einer Schrift von iPadOS: nur genau dieser PostScript-Name, nur einzelne TrueType-/OpenType-Dateien
    static func fileURL(postscriptName: String) -> URL? {
        guard !postscriptName.isEmpty, postscriptName.count <= 100 else { return nil }
        let font = CTFontCreateWithName(postscriptName as CFString, 12, nil)
        guard CTFontCopyPostScriptName(font) as String == postscriptName,
              let url = CTFontCopyAttribute(font, kCTFontURLAttribute) as? URL,
              ["ttf", "otf"].contains(url.pathExtension.lowercased()),
              FileManager.default.isReadableFile(atPath: url.path)
        else { return nil }
        return url
    }
}

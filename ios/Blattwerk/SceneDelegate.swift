import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var controller: WebViewController?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let controller = WebViewController()
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
        self.controller = controller
        // Mit einer Datei gestartet (Dateien-App, „Öffnen mit“, Teilen)
        for context in connectionOptions.urlContexts {
            controller.host.openIncoming(context.url, inPlace: context.options.openInPlace)
        }
        #if DEBUG
        // Entwicklung im Simulator: SIMCTL_CHILD_BLATTWERK_OPEN=<Pfad> öffnet eine Datei beim Start
        if let path = ProcessInfo.processInfo.environment["BLATTWERK_OPEN"], !path.isEmpty {
            controller.host.openIncoming(URL(fileURLWithPath: path), inPlace: true)
        }
        #endif
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            controller?.host.openIncoming(context.url, inPlace: context.options.openInPlace)
        }
    }
}

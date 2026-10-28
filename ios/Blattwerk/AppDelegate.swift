import UIKit

// Blattwerk für das iPad (ADR 0029): eine Szene mit einer WebView, darin dieselbe Oberfläche wie auf dem Mac.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        Staging.removeLeftovers()
        MenuBar.configure()
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Blattwerk", sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }

    // Menüleiste bis iPadOS 18: Inhalt kommt aus der Oberfläche (MenuBar.swift); ab iPadOS 26 baut MenuBar.configure
    override func buildMenu(with builder: UIMenuBuilder) {
        super.buildMenu(with: builder)
        guard #unavailable(iOS 26.0), builder.system == .main else { return }
        MenuBar.shared.build(into: builder)
    }

    @objc func performMenuCommand(_ sender: UICommand) {
        MenuBar.shared.perform(sender)
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(performMenuCommand(_:)) {
            return MenuBar.shared.isEnabled(sender as? UICommand)
        }
        return super.canPerformAction(action, withSender: sender)
    }

    // Häkchen (Seitenleiste, Modi) setzt die Oberfläche
    override func validate(_ command: UICommand) {
        super.validate(command)
        if command.action == #selector(performMenuCommand(_:)) { MenuBar.shared.validate(command) }
    }
}

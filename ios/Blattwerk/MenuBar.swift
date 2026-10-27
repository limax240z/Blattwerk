import UIKit

// Menüleiste von iPadOS (ADR 0029). Inhalt und Zustand kommen aus der Oberfläche (src/ios/menu.ts), Klicks gehen als
// Ereignis „menu“ mit der Kennung zurück. Ausschneiden, Kopieren, Einsetzen und Alles auswählen sind die Befehle des
// Systems und wirken auf die WebView.
final class MenuBar {
    static let shared = MenuBar()

    private var menus: [[String: Any]] = []
    private var structure = ""
    private var enabled: [String: Bool] = [:]
    private var checked: [String: Bool] = [:]
    private var onCommand: ((String) -> Void)?

    func update(menus: [[String: Any]], onCommand: @escaping (String) -> Void) {
        self.onCommand = onCommand
        self.menus = menus
        enabled = [:]
        checked = [:]
        collectState(menus)
        // Nur Zustände geändert (aktiv, Häkchen): prüfen lassen; sonst neu aufbauen
        let next = Self.signature(menus)
        if next != structure {
            structure = next
            UIMenuSystem.main.setNeedsRebuild()
        } else {
            UIMenuSystem.main.setNeedsRevalidate()
        }
    }

    func build(into builder: UIMenuBuilder) {
        guard !menus.isEmpty else { return }
        for identifier: UIMenu.Identifier in [.file, .edit, .format, .view] {
            builder.remove(menu: identifier)
        }
        var previous: UIMenu.Identifier = .application
        for (index, item) in menus.enumerated() {
            guard let title = item["title"] as? String, let children = item["children"] as? [[String: Any]] else { continue }
            let elements = makeElements(children)
            if item["system"] as? String == "window" {
                builder.insertChild(UIMenu(title: "", options: .displayInline, children: elements), atStartOfMenu: .window)
                continue
            }
            let identifier = UIMenu.Identifier("de.blattwerk.menu.\(index)")
            builder.insertSibling(UIMenu(title: title, identifier: identifier, children: elements), afterMenu: previous)
            previous = identifier
        }
    }

    func perform(_ command: UICommand) {
        guard let id = command.propertyList as? String else { return }
        onCommand?(id)
    }

    func isEnabled(_ command: UICommand?) -> Bool {
        guard let id = command?.propertyList as? String else { return false }
        return enabled[id] ?? false
    }

    func validate(_ command: UICommand) {
        guard let id = command.propertyList as? String, let on = checked[id] else { return }
        command.state = on ? .on : .off
    }

    // Trennlinien gliedern die Einträge in Gruppen (inline-Menüs)
    private func makeElements(_ items: [[String: Any]]) -> [UIMenuElement] {
        var groups: [[UIMenuElement]] = [[]]
        for item in items {
            if item["separator"] as? Bool == true {
                groups.append([])
                continue
            }
            if let element = makeElement(item) { groups[groups.count - 1].append(element) }
        }
        let filled = groups.filter { !$0.isEmpty }
        if filled.count <= 1 { return filled.first ?? [] }
        return filled.map { UIMenu(title: "", options: .displayInline, children: $0) }
    }

    private func makeElement(_ item: [String: Any]) -> UIMenuElement? {
        if let role = item["role"] as? String {
            let title = item["title"] as? String ?? ""
            switch role {
            case "cut": return UIKeyCommand(title: title, action: #selector(UIResponderStandardEditActions.cut(_:)), input: "x", modifierFlags: .command)
            case "copy": return UIKeyCommand(title: title, action: #selector(UIResponderStandardEditActions.copy(_:)), input: "c", modifierFlags: .command)
            case "paste": return UIKeyCommand(title: title, action: #selector(UIResponderStandardEditActions.paste(_:)), input: "v", modifierFlags: .command)
            case "selectAll": return UIKeyCommand(title: title, action: #selector(UIResponderStandardEditActions.selectAll(_:)), input: "a", modifierFlags: .command)
            default: return nil
            }
        }
        guard let title = item["title"] as? String else { return nil }
        if let children = item["children"] as? [[String: Any]] {
            let elements = makeElements(children)
            return elements.isEmpty ? nil : UIMenu(title: title, children: elements)
        }
        guard let id = item["id"] as? String else { return nil }
        let action = #selector(AppDelegate.performMenuCommand(_:))
        if let key = item["key"] as? [String: Any], let input = Self.input(key["input"] as? String) {
            let command = UIKeyCommand(title: title, action: action, input: input, modifierFlags: Self.modifiers(key["modifiers"] as? [String] ?? []), propertyList: id)
            command.wantsPriorityOverSystemBehavior = true
            return command
        }
        return UICommand(title: title, action: action, propertyList: id)
    }

    private func collectState(_ items: [[String: Any]]) {
        for item in items {
            if let id = item["id"] as? String {
                enabled[id] = item["enabled"] as? Bool ?? true
                if let on = item["checked"] as? Bool { checked[id] = on }
            }
            if let children = item["children"] as? [[String: Any]] { collectState(children) }
        }
    }

    // Aufbau ohne Zustände (aktiv, Häkchen)
    private static func signature(_ items: [[String: Any]]) -> String {
        items.map { item in
            let title = item["title"] as? String ?? (item["separator"] != nil ? "—" : "")
            let children = (item["children"] as? [[String: Any]]).map { "[\(signature($0))]" } ?? ""
            return "\(title)|\(item["id"] as? String ?? "")|\(item["role"] as? String ?? "")\(children)"
        }.joined(separator: ";")
    }

    private static func input(_ value: String?) -> String? {
        switch value {
        case nil: return nil
        case "left": return UIKeyCommand.inputLeftArrow
        case "right": return UIKeyCommand.inputRightArrow
        case "up": return UIKeyCommand.inputUpArrow
        case "down": return UIKeyCommand.inputDownArrow
        case "home": return UIKeyCommand.inputHome
        case "end": return UIKeyCommand.inputEnd
        case "escape": return UIKeyCommand.inputEscape
        case "delete": return UIKeyCommand.inputDelete
        case "f4": return UIKeyCommand.f4
        case let value?: return value.count == 1 ? value : nil
        }
    }

    private static func modifiers(_ names: [String]) -> UIKeyModifierFlags {
        var flags: UIKeyModifierFlags = []
        for name in names {
            switch name {
            case "command": flags.insert(.command)
            case "control": flags.insert(.control)
            case "shift": flags.insert(.shift)
            case "alternate": flags.insert(.alternate)
            default: break
            }
        }
        return flags
    }
}

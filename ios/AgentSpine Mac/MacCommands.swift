import SwiftUI

/// The section the focused window is showing, so a menu command can change it.
private struct MacSectionKey: FocusedValueKey {
    typealias Value = Binding<MacSection>
}

extension FocusedValues {
    var macSection: Binding<MacSection>? {
        get { self[MacSectionKey.self] }
        set { self[MacSectionKey.self] = newValue }
    }
}

/// A Go menu: the sidebar's sections on Command-1 to 7, in the sidebar's order, so the app can
/// be driven from the keyboard without the sidebar.
struct MacGoCommands: Commands {
    @FocusedBinding(\.macSection) private var section

    var body: some Commands {
        CommandMenu("Go") {
            ForEach(Array(MacSection.primary.enumerated()), id: \.element) { index, target in
                Button(target.title) { section = target }
                    .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
                    .disabled(section == nil)
            }
        }
    }
}

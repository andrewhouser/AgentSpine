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

/// A Go menu: the first nine sections on Command-1 to 9, in the order chosen for the sidebar menu,
/// so the app can be driven from the keyboard without the sidebar.
struct MacGoCommands: Commands {
    @FocusedBinding(\.macSection) private var section
    @AppStorage(MacSection.orderKey) private var storedOrder = ""

    var body: some Commands {
        CommandMenu("Go") {
            ForEach(Array(MacSection.ordered(storedOrder).prefix(9).enumerated()), id: \.element) { index, target in
                Button(target.title) { section = target }
                    .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
                    .disabled(section == nil)
            }
        }
    }
}

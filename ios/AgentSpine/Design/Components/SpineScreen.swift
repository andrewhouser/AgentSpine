import SwiftUI

extension View {
    /// The ground a whole screen sits on: the token background, with the system's own list and
    /// form backgrounds hidden so it shows through. Apply it once, on a screen's navigation
    /// container, not on each list. Plain lists and the gaps between grouped sections take the
    /// token ground; the rows of grouped lists still use the system's cell fill until they are
    /// restyled one by one.
    ///
    /// On iOS 18 the ground is a navigation container background, which also
    /// covers screens pushed onto the stack. On iOS 17 a plain background only reaches the
    /// root screen of each tab; pushed screens keep the system ground there.
    @ViewBuilder func spineScreen() -> some View {
        #if os(iOS)
        if #available(iOS 18.0, *) {
            self
                .scrollContentBackground(.hidden)
                .containerBackground(Spine.Palette.bg, for: .navigation)
        } else {
            self
                .scrollContentBackground(.hidden)
                .background(Spine.Palette.bg.ignoresSafeArea())
        }
        #else
        // `.navigation` container backgrounds do not exist on macOS.
        self
            .scrollContentBackground(.hidden)
            .background(Spine.Palette.bg.ignoresSafeArea())
        #endif
    }
}

/// One place that holds two screens which used to be places of their own (the 2026-11-27 menu
/// review, PLAN-open-work section 15, R12): Heads-up holds the check-in, Knowledge holds the drop
/// zone, Activity holds the coding runs. A switch in the bar picks which; each screen keeps its own
/// code. The web's `TabbedPlace` is the same idea.
struct PlacePicker<First: View, Second: View>: View {
    let title: String
    let firstLabel: String
    let secondLabel: String
    @Binding var showSecond: Bool
    @ViewBuilder let first: () -> First
    @ViewBuilder let second: () -> Second

    var body: some View {
        Group {
            if showSecond { second() } else { first() }
        }
        .navigationTitle(title)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker(title, selection: $showSecond) {
                    Text(firstLabel).tag(false)
                    Text(secondLabel).tag(true)
                }
                .pickerStyle(.segmented)
                .fixedSize()
                .accessibilityLabel("\(title) section")
            }
        }
    }
}

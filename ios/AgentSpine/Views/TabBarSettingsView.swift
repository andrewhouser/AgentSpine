import SwiftUI

/// Settings → Tab bar: choose what sits in the bar and in what order.
///
/// iOS shows four tabs and "More", so the order is the whole choice: the first four are the
/// bar, the rest fold under More. Threads is first and fixed because it is where approvals are
/// asked. The preview above the list is the bar as it will look, and it updates as you drag.
///
/// Drag is not operable with VoiceOver, so every row also offers Move up and Move down as
/// accessibility actions. Nothing here talks to the server; the order lives in `UserDefaults`
/// through `Settings`, and a tab added by a later version arrives under More.
struct TabBarSettingsView: View {
    @Environment(Settings.self) private var settings

    private var order: [AppTab] { settings.tabs }
    /// Everything but Today and Threads: the part the user can rearrange.
    private var movable: [AppTab] { Array(order.dropFirst(2)) }

    var body: some View {
        List {
            Section {
                BarPreview(bar: TabLayout.bar(order), hasMore: !TabLayout.more(order).isEmpty)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
            }

            Section {
                row(.today, slot: 0, fixed: true)
                row(.threads, slot: 1, fixed: true)
                ForEach(Array(movable.enumerated()), id: \.element) { index, tab in
                    row(tab, slot: index + 2, fixed: false)
                        .accessibilityAction(named: "Move up") { move(index, by: -1) }
                        .accessibilityAction(named: "Move down") { move(index, by: 1) }
                }
                .onMove { source, destination in
                    var next = movable
                    next.move(fromOffsets: source, toOffset: destination)
                    save(next)
                }
            } header: {
                Text("Order")
            } footer: {
                // The web and Mac let you choose how many are pinned (2 to 8, 2026-11-27). On an iPhone
                // the system's tab bar shows four and folds the rest under More, so the count is fixed.
                Text("Drag to reorder. The first four are in the bar; the rest are under More. On iPhone the bar always holds four.")
            }

            Section {
                Button("Reset to default", role: .destructive) { settings.tabOrder = [] }
                    .disabled(settings.tabOrder.isEmpty)
            }
        }
        .environment(\.editMode, .constant(.active))
        .navigationTitle("Tab bar")
        .navigationBarTitleDisplayMode(.inline)
        .spineScreen()
    }

    private func row(_ tab: AppTab, slot: Int, fixed: Bool) -> some View {
        let inBar = slot < TabLayout.barSlots
        return HStack(spacing: Spine.Space.md) {
            Image(systemName: tab.symbol)
                .frame(width: 24)
                .foregroundStyle(inBar ? Spine.Palette.accent : Spine.Palette.textDim)
                .accessibilityHidden(true)
            Text(tab.title)
                .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body))
                .foregroundStyle(Spine.Palette.text)
            Spacer()
            if fixed {
                StatusChip(text: "fixed", symbol: "lock.fill")
            } else {
                StatusChip(text: inBar ? "bar" : "More", tone: inBar ? .accent : .neutral)
            }
        }
        .moveDisabled(fixed)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(tab.title), \(inBar ? "in the bar" : "under More")\(fixed ? ", fixed" : "")")
    }

    private func move(_ index: Int, by delta: Int) {
        let target = index + delta
        guard movable.indices.contains(target) else { return }
        var next = movable
        next.swapAt(index, target)
        save(next)
    }

    private func save(_ rest: [AppTab]) {
        settings.tabOrder = TabLayout.raw([.today, .threads] + rest)
    }
}

/// The bar as it will look: four tabs and More.
private struct BarPreview: View {
    let bar: [AppTab]
    let hasMore: Bool

    var body: some View {
        HStack(spacing: 0) {
            ForEach(bar, id: \.self) { tab in
                cell(symbol: tab.symbol, title: tab.title)
            }
            if hasMore { cell(symbol: "ellipsis", title: "More") }
        }
        .padding(.vertical, Spine.Space.sm)
        .background(Spine.Palette.bgElevated, in: RoundedRectangle(cornerRadius: Spine.Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Spine.Radius.lg).strokeBorder(Spine.Palette.border, lineWidth: 0.5))
        .padding(.vertical, Spine.Space.sm)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Tab bar preview: \(bar.map(\.title).joined(separator: ", ")), and More")
    }

    private func cell(symbol: String, title: String) -> some View {
        VStack(spacing: 3) {
            Image(systemName: symbol).font(.system(size: 18))
            Text(title)
                .font(SpineFont.sans(Spine.TypeSize.caption - 2, relativeTo: .caption2))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .foregroundStyle(Spine.Palette.textDim)
        .frame(maxWidth: .infinity)
    }
}

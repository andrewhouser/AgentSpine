import SwiftUI

/// The section menu at the foot of the sidebar, as on the web: six items, two to a row, then a full-width More.
/// It sits outside the threads list so the threads keep the scrolling space, and opening More
/// grows the menu upward instead of pushing the threads off the screen.
struct MacSidebarMenu: View {
    @Binding var selection: MacSidebarItem?

    @Environment(AppState.self) private var state
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(MacSection.orderKey) private var storedOrder = ""
    @AppStorage("sidebarMoreExpanded") private var moreExpanded = false

    private let columns = [GridItem(.flexible(), spacing: 2), GridItem(.flexible(), spacing: 2)]

    private var order: [MacSection] { MacSection.ordered(storedOrder) }
    private var pinned: [MacSection] { Array(order.prefix(MenuLayout.pinnedSlots)) }
    private var folded: [MacSection] { Array(order.dropFirst(MenuLayout.pinnedSlots)) }

    /// With More shut, the open section has no row of its own, so More carries the highlight.
    private var openSectionIsFolded: Bool {
        guard case .section(let open) = selection else { return false }
        return folded.contains(open)
    }

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            VStack(spacing: Spine.Space.xs) {
                LazyVGrid(columns: columns, spacing: 2) {
                    ForEach(pinned, id: \.self) { row($0) }
                }
                moreRow
                if moreExpanded {
                    // Tinted so the overflow reads as its own section. As a grid cell, More got
                    // lost among the items it had just opened (seen in the running app).
                    LazyVGrid(columns: columns, spacing: 2) {
                        ForEach(folded, id: \.self) { row($0) }
                    }
                    .padding(Spine.Space.xs)
                    .background(Spine.Palette.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: Spine.Radius.sm))
                }
            }
            .padding(Spine.Space.sm)
        }
    }

    private func row(_ item: MacSection) -> some View {
        Button {
            selection = .section(item)
        } label: {
            cell(title: item.title, symbol: item.symbol, count: count(for: item), active: selection == .section(item))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selection == .section(item) ? .isSelected : [])
    }

    private var moreRow: some View {
        Button {
            withAnimation(reduceMotion ? nil : .default) { moreExpanded.toggle() }
        } label: {
            let active = !moreExpanded && openSectionIsFolded
            HStack {
                Text("More")
                Spacer(minLength: 0)
                Image(systemName: moreExpanded ? "chevron.up" : "chevron.down")
                    .imageScale(.small)
                    .accessibilityHidden(true)
            }
            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
            .foregroundStyle(active || moreExpanded ? Spine.Palette.text : Spine.Palette.textDim)
            .padding(.horizontal, Spine.Space.sm)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity)
            .background(
                active ? Spine.Palette.accent.opacity(0.18) : Spine.Palette.bgElevated,
                in: RoundedRectangle(cornerRadius: Spine.Radius.sm)
            )
            .overlay(RoundedRectangle(cornerRadius: Spine.Radius.sm).strokeBorder(Spine.Palette.border, lineWidth: 0.5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(moreExpanded ? "Expanded" : "Collapsed")
    }

    private func cell(title: String, symbol: String, count: Int, active: Bool) -> some View {
        HStack(spacing: Spine.Space.xs + 2) {
            Image(systemName: symbol)
                .frame(width: 18)
                .foregroundStyle(Spine.Palette.accent)
                .accessibilityHidden(true)
            Text(title)
                .lineLimit(1)
                .truncationMode(.tail)
                .foregroundStyle(active ? Spine.Palette.text : Spine.Palette.textDim)
            Spacer(minLength: 0)
            if count > 0 {
                Text("\(count)")
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                    .foregroundStyle(Spine.Palette.textDim)
            }
        }
        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
        .padding(.horizontal, Spine.Space.sm)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(active ? Spine.Palette.accent.opacity(0.18) : .clear, in: RoundedRectangle(cornerRadius: Spine.Radius.sm))
        .contentShape(Rectangle())
    }

    /// Zero hides a badge. Builds has none: "a build" is a view over the actions log with no
    /// cheap count that means anything.
    private func count(for item: MacSection) -> Int {
        switch item {
        case .headsup: return state.headsupWaiting
        case .tasks: return state.openTaskCount ?? 0
        case .schedules: return state.scheduleCount ?? 0
        default: return 0
        }
    }
}

/// Settings → Assistant → Sidebar menu: what the six pinned items are and their order. It lives
/// in `UserDefaults` because it describes this Mac's window, not the assistant.
struct MacMenuSettingsView: View {
    @AppStorage(MacSection.orderKey) private var storedOrder = ""

    private var order: [MacSection] { MacSection.ordered(storedOrder) }

    var body: some View {
        List {
            Section {
                ForEach(Array(order.enumerated()), id: \.element) { index, item in
                    row(item, index: index)
                }
                .onMove { source, destination in
                    var next = order
                    next.move(fromOffsets: source, toOffset: destination)
                    save(next)
                }
            } header: {
                Text("Order")
            } footer: {
                Text("Drag, or use the arrows. The first six are in the sidebar menu; the rest are under More.")
            }

            Section {
                Button("Reset to default") { storedOrder = "" }
                    .disabled(storedOrder.isEmpty)
            }
        }
        .navigationTitle("Sidebar menu")
    }

    private func row(_ item: MacSection, index: Int) -> some View {
        let isPinned = index < MenuLayout.pinnedSlots
        return HStack(spacing: Spine.Space.md) {
            Image(systemName: item.symbol)
                .frame(width: 24)
                .foregroundStyle(isPinned ? Spine.Palette.accent : Spine.Palette.textDim)
                .accessibilityHidden(true)
            Text(item.title)
            Spacer()
            StatusChip(text: isPinned ? "Menu" : "More", tone: isPinned ? .accent : .neutral)
            Button { move(index, by: -1) } label: { Image(systemName: "chevron.up") }
                .buttonStyle(.borderless)
                .disabled(index == 0)
                .accessibilityLabel("Move \(item.title) up")
            Button { move(index, by: 1) } label: { Image(systemName: "chevron.down") }
                .buttonStyle(.borderless)
                .disabled(index == order.count - 1)
                .accessibilityLabel("Move \(item.title) down")
        }
    }

    private func move(_ index: Int, by delta: Int) {
        let target = index + delta
        guard order.indices.contains(target) else { return }
        var next = order
        next.swapAt(index, target)
        save(next)
    }

    private func save(_ next: [MacSection]) {
        storedOrder = MenuLayout.encode(next.map(\.rawValue))
    }
}

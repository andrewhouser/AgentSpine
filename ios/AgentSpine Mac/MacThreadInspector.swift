import SwiftUI

/// The panel beside a thread: what ran and what it ran on, as a read-only summary of the ledger
/// the thread view already holds, so it costs no request of its own.
///
/// Four cards: the tiers the turns ran at, what the latest turn had in front of it (grouped by
/// kind, because the server's list is a run of free-text lines), every tool call by tool, and the
/// child runs. It describes finished turns; the run in flight appears when it ends and the
/// thread reloads.
struct MacThreadInspector: View {
    let thread: Thread

    private var turns: [Turn] { thread.turns }
    private var actions: [Action] { turns.flatMap(\.actions) }
    private var children: [ChildRun] { turns.flatMap(\.children) }
    /// The newest turn that recorded its context; older servers record none.
    private var contextTurn: Turn? { turns.last { !($0.contextUsed ?? []).isEmpty } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spine.Space.lg) {
                tiersCard
                if let used = contextTurn?.contextUsed { contextCard(used) }
                toolsCard
                childrenCard
            }
            .padding(Spine.Space.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Spine.Palette.bgSidebar)
    }

    // MARK: - Tiers

    private var tiersCard: some View {
        card("Model", symbol: "cpu") {
            HStack {
                Text("Pinned to")
                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                    .foregroundStyle(Spine.Palette.textDim)
                Spacer()
                chip(pinnedLabel, tint: Spine.Palette.accent)
            }
            if tierCounts.isEmpty {
                empty("No turns yet")
            } else {
                // One bar, split by how many turns ran at each tier.
                GeometryReader { proxy in
                    HStack(spacing: 2) {
                        ForEach(tierCounts, id: \.tier) { entry in
                            Capsule()
                                .fill(tint(for: entry.tier))
                                .frame(width: max(6, proxy.size.width * CGFloat(entry.count) / CGFloat(turns.count)))
                        }
                    }
                }
                .frame(height: 6)
                HStack(spacing: Spine.Space.md) {
                    ForEach(tierCounts, id: \.tier) { entry in
                        HStack(spacing: 5) {
                            Circle().fill(tint(for: entry.tier)).frame(width: 7, height: 7)
                            Text("\(entry.tier) \(entry.count)")
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                .foregroundStyle(Spine.Palette.textDim)
                        }
                    }
                    Spacer()
                    Text("\(turns.count) turn\(turns.count == 1 ? "" : "s")")
                        .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textFaint)
                }
            }
        }
    }

    // MARK: - Context

    private func contextCard(_ used: [String]) -> some View {
        card("Context", symbol: "brain", trailing: "\(used.count)") {
            Text("What the latest turn had in front of it")
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                .foregroundStyle(Spine.Palette.textFaint)
            ForEach(contextGroups(used), id: \.title) { group in
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: Spine.Space.sm) {
                        ForEach(group.items, id: \.self) { item in
                            Text(item)
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                .foregroundStyle(Spine.Palette.textDim)
                                .lineLimit(3)
                                .help(item)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(.top, Spine.Space.xs)
                } label: {
                    HStack(spacing: Spine.Space.sm) {
                        Image(systemName: group.symbol)
                            .frame(width: 16)
                            .foregroundStyle(Spine.Palette.textDim)
                        Text(group.title)
                            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                            .foregroundStyle(Spine.Palette.text)
                        Spacer()
                        Text("\(group.items.count)")
                            .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                            .foregroundStyle(Spine.Palette.textFaint)
                    }
                }
            }
        }
    }

    private struct ContextGroup {
        let title: String
        let symbol: String
        let items: [String]
    }

    /// The server's lines read "memory: …", "earlier conversation: …", or plain words ("your
    /// profile"). Group by that prefix, strip it, and keep the server's order within a group.
    /// An unknown prefix falls into "Also in view" with the line intact.
    private func contextGroups(_ used: [String]) -> [ContextGroup] {
        func take(_ prefix: String) -> [String] {
            used.filter { $0.hasPrefix(prefix) }.map { String($0.dropFirst(prefix.count)) }
        }
        let memories = take("memory: ")
        let conversations = take("earlier conversation: ")
        let rest = used.filter { !$0.hasPrefix("memory: ") && !$0.hasPrefix("earlier conversation: ") }
        return [
            ContextGroup(title: "Memories", symbol: "tray.full", items: memories),
            ContextGroup(title: "Earlier conversations", symbol: "clock.arrow.circlepath", items: conversations),
            ContextGroup(title: "Also in view", symbol: "text.alignleft", items: rest),
        ].filter { !$0.items.isEmpty }
    }

    // MARK: - Tool calls

    private var toolsCard: some View {
        card("Tool calls", symbol: "wrench.and.screwdriver", trailing: "\(actions.count)") {
            if toolSummaries.isEmpty {
                empty("None yet")
            }
            let most = toolSummaries.map(\.count).max() ?? 1
            ForEach(toolSummaries, id: \.tool) { summary in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: Spine.Space.sm) {
                        Text(summary.tool)
                            .font(SpineFont.mono(Spine.TypeSize.footnote, relativeTo: .footnote))
                            .foregroundStyle(Spine.Palette.text)
                            .lineLimit(1)
                        Spacer(minLength: Spine.Space.sm)
                        Text(summary.worst.label)
                            .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2).weight(.medium))
                            .foregroundStyle(VerdictBadge.color(for: summary.worst))
                        Text("\(summary.count)")
                            .font(SpineFont.mono(Spine.TypeSize.footnote, relativeTo: .footnote))
                            .foregroundStyle(Spine.Palette.textDim)
                    }
                    GeometryReader { proxy in
                        Capsule()
                            .fill(VerdictBadge.color(for: summary.worst).opacity(0.7))
                            .frame(width: max(4, proxy.size.width * CGFloat(summary.count) / CGFloat(most)))
                    }
                    .frame(height: 4)
                }
            }
        }
    }

    // MARK: - Child runs

    private var childrenCard: some View {
        card("Child runs", symbol: "arrow.triangle.branch", trailing: "\(children.count)") {
            if children.isEmpty {
                empty("This thread has not handed anything to another agent.")
            }
            ForEach(children) { child in
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(child.agent ?? "agent")
                            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.semibold))
                            .foregroundStyle(Spine.Palette.text)
                        Spacer(minLength: Spine.Space.sm)
                        if let tier = child.tier { chip(tier, tint: tint(for: tier)) }
                    }
                    if let task = child.task, !task.isEmpty {
                        Text(task)
                            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                            .foregroundStyle(Spine.Palette.textDim)
                            .lineLimit(2)
                    }
                    Text("\(child.status) · \(child.actions.count) tool call\(child.actions.count == 1 ? "" : "s")")
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textFaint)
                }
            }
        }
    }

    // MARK: - Data

    private var pinnedLabel: String {
        thread.conversation.tier.map(label) ?? "Auto"
    }

    private func label(_ tier: String) -> String {
        switch tier {
        case "fast": return "Fast"
        case "standard": return "Local"
        case "deep": return "Cloud"
        default: return tier.capitalized
        }
    }

    /// Cloud is the one that leaves the machine, so it is the one with a warm colour.
    private func tint(for tier: String) -> Color {
        switch tier {
        case "fast", "Fast": return Spine.Palette.ok
        case "standard", "Local": return Spine.Palette.accent
        case "deep", "Cloud": return Spine.Palette.attention
        default: return Spine.Palette.textFaint
        }
    }

    /// How many turns ran at each tier, in a fixed order so the list does not shuffle.
    private var tierCounts: [(tier: String, count: Int)] {
        let order = ["fast", "standard", "deep"]
        let counts = Dictionary(grouping: turns.compactMap(\.tier), by: { $0 }).mapValues(\.count)
        let known = order.compactMap { tier in counts[tier].map { (tier: label(tier), count: $0) } }
        let others = counts.filter { !order.contains($0.key) }.sorted { $0.key < $1.key }.map { (tier: label($0.key), count: $0.value) }
        return known + others
    }

    private struct ToolSummary {
        let tool: String
        let count: Int
        /// The verdict worth a glance: an error or a denial beats a queue beats a clean run.
        let worst: BrokerStatus
    }

    private var toolSummaries: [ToolSummary] {
        let rank: [BrokerStatus: Int] = [.error: 4, .denied: 3, .queued: 2, .dryRun: 1, .executed: 0]
        return Dictionary(grouping: actions, by: \.tool)
            .map { tool, calls in
                ToolSummary(
                    tool: tool,
                    count: calls.count,
                    worst: calls.map(\.status).max { (rank[$0] ?? 0) < (rank[$1] ?? 0) } ?? .executed
                )
            }
            .sorted { $0.count == $1.count ? $0.tool < $1.tool : $0.count > $1.count }
    }

    // MARK: - Pieces

    private func card<Content: View>(
        _ title: String,
        symbol: String,
        trailing: String? = nil,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: Spine.Space.md) {
            HStack(spacing: Spine.Space.sm) {
                Image(systemName: symbol)
                    .foregroundStyle(Spine.Palette.textDim)
                Text(title)
                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.semibold))
                    .foregroundStyle(Spine.Palette.text)
                Spacer()
                if let trailing {
                    Text(trailing)
                        .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textFaint)
                }
            }
            content()
        }
        .padding(Spine.Space.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Spine.Palette.bgElevated, in: RoundedRectangle(cornerRadius: Spine.Radius.md))
        .overlay(RoundedRectangle(cornerRadius: Spine.Radius.md).strokeBorder(Spine.Palette.border))
    }

    private func chip(_ text: String, tint: Color) -> some View {
        Text(text)
            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).weight(.medium))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(tint.opacity(0.14), in: Capsule())
    }

    private func empty(_ text: String) -> some View {
        Text(text)
            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
            .foregroundStyle(Spine.Palette.textFaint)
    }
}

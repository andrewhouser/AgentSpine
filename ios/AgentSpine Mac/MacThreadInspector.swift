import SwiftUI

/// The panel beside a thread: what ran and what it ran on, as a read-only summary of the ledger
/// the thread view already holds, so it costs no request of its own.
///
/// Sections: the tier each turn ran at, what the latest turn had in front of it, every tool call
/// by tool (with how many were decided each way), and the child runs. It describes the finished
/// turns; the run in flight appears here when it ends and the thread reloads.
struct MacThreadInspector: View {
    let thread: Thread

    private var turns: [Turn] { thread.turns }
    private var actions: [Action] { turns.flatMap(\.actions) }
    private var children: [ChildRun] { turns.flatMap(\.children) }
    /// The newest turn that recorded its context; older servers record none.
    private var contextTurn: Turn? { turns.last { !($0.contextUsed ?? []).isEmpty } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spine.Space.xl) {
                section("Thread") {
                    row("Pinned tier", pinnedLabel)
                    row("Turns", "\(turns.count)")
                    ForEach(tierCounts, id: \.tier) { entry in
                        row("Ran at \(entry.tier)", "\(entry.count)")
                    }
                }

                if let contextTurn, let used = contextTurn.contextUsed {
                    section("Context", trailing: "\(used.count)") {
                        Text("What the latest turn had in front of it")
                            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                            .foregroundStyle(Spine.Palette.textFaint)
                        ForEach(used, id: \.self) { item in
                            Text(item)
                                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                                .foregroundStyle(Spine.Palette.textDim)
                                .lineLimit(2)
                        }
                    }
                }

                section("Tool calls", trailing: "\(actions.count)") {
                    if toolSummaries.isEmpty {
                        empty("None yet")
                    }
                    ForEach(toolSummaries, id: \.tool) { summary in
                        HStack(spacing: Spine.Space.sm) {
                            Circle().fill(VerdictBadge.color(for: summary.worst)).frame(width: 8, height: 8)
                            Text(summary.tool)
                                .font(SpineFont.mono(Spine.TypeSize.footnote, relativeTo: .footnote))
                                .foregroundStyle(Spine.Palette.text)
                                .lineLimit(1)
                            Spacer(minLength: Spine.Space.sm)
                            Text("\(summary.count)")
                                .font(SpineFont.mono(Spine.TypeSize.footnote, relativeTo: .footnote))
                                .foregroundStyle(Spine.Palette.textFaint)
                        }
                    }
                }

                section("Child runs", trailing: "\(children.count)") {
                    if children.isEmpty {
                        empty("None")
                    }
                    ForEach(children) { child in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(child.agent ?? "agent")
                                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.semibold))
                                    .foregroundStyle(Spine.Palette.text)
                                Spacer(minLength: Spine.Space.sm)
                                Text([child.tier, child.status].compactMap { $0 }.joined(separator: " · "))
                                    .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                                    .foregroundStyle(Spine.Palette.textFaint)
                            }
                            if let task = child.task, !task.isEmpty {
                                Text(task)
                                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                    .foregroundStyle(Spine.Palette.textDim)
                                    .lineLimit(2)
                            }
                            Text("\(child.actions.count) tool call\(child.actions.count == 1 ? "" : "s")")
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                .foregroundStyle(Spine.Palette.textFaint)
                        }
                    }
                }
            }
            .padding(Spine.Space.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Spine.Palette.bgSidebar)
    }

    // MARK: - Data

    private var pinnedLabel: String {
        switch thread.conversation.tier {
        case nil: return "Auto"
        case "fast": return "Fast"
        case "standard": return "Local"
        case "deep": return "Cloud"
        case .some(let other): return other.capitalized
        }
    }

    /// How many turns ran at each tier, in a fixed order so the list does not shuffle.
    private var tierCounts: [(tier: String, count: Int)] {
        let order = ["fast", "standard", "deep"]
        let counts = Dictionary(grouping: turns.compactMap(\.tier), by: { $0 }).mapValues(\.count)
        let known = order.compactMap { tier in counts[tier].map { (tier: label(tier), count: $0) } }
        let others = counts.filter { !order.contains($0.key) }.sorted { $0.key < $1.key }.map { (tier: $0.key, count: $0.value) }
        return known + others
    }

    private func label(_ tier: String) -> String {
        switch tier {
        case "fast": return "Fast"
        case "standard": return "Local"
        case "deep": return "Cloud"
        default: return tier
        }
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

    private func section<Content: View>(
        _ title: String,
        trailing: String? = nil,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: Spine.Space.sm) {
            HStack {
                Text(title.uppercased())
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).weight(.semibold))
                    .tracking(0.6)
                    .foregroundStyle(Spine.Palette.textFaint)
                Spacer()
                if let trailing {
                    Text(trailing)
                        .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textFaint)
                }
            }
            content()
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                .foregroundStyle(Spine.Palette.textDim)
            Spacer(minLength: Spine.Space.sm)
            Text(value)
                .font(SpineFont.mono(Spine.TypeSize.footnote, relativeTo: .footnote))
                .foregroundStyle(Spine.Palette.text)
        }
    }

    private func empty(_ text: String) -> some View {
        Text(text)
            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
            .foregroundStyle(Spine.Palette.textFaint)
    }
}

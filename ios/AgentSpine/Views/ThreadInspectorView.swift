import SwiftUI

/// Shared by the Mac app (the inspector column beside a thread) and the iPhone (a sheet from the thread's toolbar).
///
/// The panel beside a thread: what ran and what it ran on, as a read-only summary of the ledger
/// the thread view already holds, so it costs no request of its own.
///
/// Four cards: the tiers the turns ran at, what the latest turn had in front of it (grouped by
/// kind, because the server's list is a run of free-text lines), every tool call by tool, and the
/// child runs. It describes finished turns; the run in flight appears when it ends and the
/// thread reloads.
struct ThreadInspectorView: View {
    let thread: Thread

    @Environment(AppState.self) private var state

    private var turns: [Turn] { thread.turns }
    private var actions: [Action] { turns.flatMap(\.actions) }
    private var children: [ChildRun] { turns.flatMap(\.children) }
    /// The newest turn that recorded its context; older servers record none.
    private var contextTurn: Turn? { turns.last { !($0.contextUsed ?? []).isEmpty } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spine.Space.lg) {
                tiersCard
                tokensCard
                if let used = contextTurn?.contextUsed { contextCard(used) }
                toolsCard
                childrenCard
            }
            .padding(Spine.Space.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Spine.Palette.bgSidebar)
    }

    // MARK: - Model

    private var tiersCard: some View {
        card("Model", symbol: "cpu") {
            HStack {
                Text("Pinned to")
                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                    .foregroundStyle(Spine.Palette.textDim)
                Spacer()
                chip(pinnedLabel, tint: Spine.Palette.accent)
            }
            if let notice = pinnedCloudNotice {
                Label(notice, systemImage: "exclamationmark.triangle")
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                    .foregroundStyle(Spine.Palette.attention)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if servedGroups.isEmpty {
                empty("No turns yet")
            } else {
                // One bar, split by how many turns each model answered.
                GeometryReader { proxy in
                    HStack(spacing: 2) {
                        ForEach(servedGroups) { group in
                            Capsule()
                                .fill(group.tint)
                                .frame(width: max(6, proxy.size.width * CGFloat(group.count) / CGFloat(turns.count)))
                        }
                    }
                }
                .frame(height: 6)
                ForEach(Array(servedGroups.enumerated()), id: \.element.id) { index, group in
                    if index > 0 { Divider().overlay(Spine.Palette.border) }
                    HStack(alignment: .firstTextBaseline, spacing: Spine.Space.sm) {
                        Circle().fill(group.tint).frame(width: 8, height: 8)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(group.title)
                                .font(SpineFont.mono(Spine.TypeSize.footnote, relativeTo: .footnote))
                                .foregroundStyle(Spine.Palette.text)
                                .lineLimit(2)
                                .help(group.title)
                            Text(group.subtitle)
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                .foregroundStyle(Spine.Palette.textFaint)
                        }
                        Spacer(minLength: Spine.Space.sm)
                        Text("\(group.count) turn\(group.count == 1 ? "" : "s")")
                            .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                            .foregroundStyle(Spine.Palette.textDim)
                    }
                }
            }
        }
    }

    private struct ServedGroup: Identifiable {
        let id: String
        let title: String
        let subtitle: String
        let tint: Color
        let count: Int
    }

    /// Turns grouped by the model that answered. A turn recorded before the server kept that
    /// falls back to the tier it asked for, and says the model was not recorded.
    private var servedGroups: [ServedGroup] {
        var order: [String] = []
        var groups: [String: ServedGroup] = [:]
        for turn in turns {
            let key: String
            let title: String
            let subtitle: String
            let tint: Color
            if let served = turn.served {
                key = "\(served.via)|\(served.model)"
                title = served.model.replacingOccurrences(of: "mlx-community/", with: "")
                if served.via == "cloud" {
                    subtitle = ["Cloud", state.cloud?.host].compactMap { $0 }.joined(separator: " · ")
                    tint = Spine.Palette.attention
                } else {
                    subtitle = served.tier == "fast" ? "Local · fast tier" : "Local"
                    tint = served.tier == "fast" ? Spine.Palette.ok : Spine.Palette.accent
                }
            } else if let tier = turn.tier {
                key = "tier|\(tier)"
                title = label(tier)
                subtitle = "model not recorded"
                tint = tierTint(tier)
            } else {
                continue
            }
            if let existing = groups[key] {
                groups[key] = ServedGroup(id: key, title: title, subtitle: subtitle, tint: tint, count: existing.count + 1)
            } else {
                order.append(key)
                groups[key] = ServedGroup(id: key, title: title, subtitle: subtitle, tint: tint, count: 1)
            }
        }
        return order.compactMap { groups[$0] }
    }

    /// A thread pinned to Cloud on a server with no Cloud tier runs on the local model, and
    /// nothing in the thread said so. Also named: a turn that asked for Cloud and was served
    /// locally anyway (a private thread, or the router falling back after a failure).
    private var pinnedCloudNotice: String? {
        if thread.conversation.tier == "deep", state.cloud?.configured == false {
            return "Pinned to Cloud, but this server has no Cloud model configured, so these turns run on the local model."
        }
        if let miss = turns.last(where: { $0.tier == "deep" && $0.served != nil && $0.served?.cloud == false }),
           let model = miss.served?.model {
            return "Cloud was asked for, but the latest such turn ran on \(model.replacingOccurrences(of: "mlx-community/", with: ""))."
        }
        return nil
    }

    // MARK: - Tokens

    private struct ModelTokens: Identifiable {
        let id: String
        let model: String
        let tier: String?
        var calls: Int
        var prompt: Int
        var completion: Int
    }

    private var usages: [RunUsage] { turns.compactMap(\.usage) }
    private var totalCalls: Int { usages.reduce(0) { $0 + $1.calls } }
    private var totalIn: Int { usages.reduce(0) { $0 + $1.promptTokens } }
    private var totalOut: Int { usages.reduce(0) { $0 + $1.completionTokens } }
    private var totalUnreported: Int { usages.reduce(0) { $0 + $1.unreported } }
    /// The newest turn that made any model call, for the "latest turn" line.
    private var latestUsage: RunUsage? { usages.last { $0.calls > 0 } }

    /// Tokens grouped by model and tier across the thread, in the order each first appeared.
    private var modelTokens: [ModelTokens] {
        var order: [String] = []
        var rows: [String: ModelTokens] = [:]
        for usage in usages {
            for m in usage.byModel {
                let key = "\(m.tier ?? "")|\(m.model)"
                if var row = rows[key] {
                    row.calls += m.calls
                    row.prompt += m.promptTokens
                    row.completion += m.completionTokens
                    rows[key] = row
                } else {
                    order.append(key)
                    rows[key] = ModelTokens(id: key, model: m.model, tier: m.tier, calls: m.calls, prompt: m.promptTokens, completion: m.completionTokens)
                }
            }
        }
        return order.compactMap { rows[$0] }
    }

    private func count(_ n: Int) -> String {
        n.formatted(.number.grouping(.automatic))
    }

    private var totalModelMs: Int { usages.reduce(0) { $0 + $1.byModel.reduce(0) { $0 + $1.ms } } }

    /// "Effective" because no first-token time is recorded: `ms` is the whole request, prefill included,
    /// so on a 22k-token prompt this reads far below the model's 28 tok/s decode speed.
    private var effectiveSpeedLine: String? {
        guard totalModelMs > 0 else { return nil }
        let exactSeconds = Double(totalModelMs) / 1000
        let seconds = Int(exactSeconds.rounded())
        let time = seconds < 60 ? "\(seconds)s"
            : seconds < 3600 ? "\(seconds / 60)m \(seconds % 60)s"
            : "\(seconds / 3600)h \((seconds % 3600) / 60)m"
        let speed = (Double(totalOut) / exactSeconds).formatted(.number.precision(.fractionLength(1)))
        return "Effective: \(speed) tok/s · \(time) model time"
    }

    private var tokensCard: some View {
        card("Tokens", symbol: "number", trailing: totalCalls > 0 ? "\(count(totalCalls)) call\(totalCalls == 1 ? "" : "s")" : nil) {
            if totalCalls == 0 {
                empty("Not recorded for these turns")
            } else {
                HStack(alignment: .firstTextBaseline, spacing: Spine.Space.xl) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(count(totalIn))
                            .font(SpineFont.mono(Spine.TypeSize.body, relativeTo: .body))
                            .foregroundStyle(Spine.Palette.text)
                        Text("in")
                            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                            .foregroundStyle(Spine.Palette.textFaint)
                    }
                    VStack(alignment: .leading, spacing: 0) {
                        Text(count(totalOut))
                            .font(SpineFont.mono(Spine.TypeSize.body, relativeTo: .body))
                            .foregroundStyle(Spine.Palette.text)
                        Text("out")
                            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                            .foregroundStyle(Spine.Palette.textFaint)
                    }
                }
                if let latest = latestUsage {
                    Text("Latest turn: \(count(latest.promptTokens)) in, \(count(latest.completionTokens)) out")
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textFaint)
                }
                if let line = effectiveSpeedLine {
                    Text(line)
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textFaint)
                        .accessibilityHint("Output tokens divided by total model time, including prompt processing")
                }
                ForEach(Array(modelTokens.enumerated()), id: \.element.id) { index, row in
                    if index > 0 { Divider().overlay(Spine.Palette.border) }
                    HStack(alignment: .firstTextBaseline, spacing: Spine.Space.sm) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(row.model.replacingOccurrences(of: "mlx-community/", with: ""))
                                .font(SpineFont.mono(Spine.TypeSize.footnote, relativeTo: .footnote))
                                .foregroundStyle(Spine.Palette.text)
                                .lineLimit(2)
                                .help(row.model)
                            Text("\(row.tier.map(label) ?? "tier not recorded") · \(row.calls) call\(row.calls == 1 ? "" : "s")")
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                .foregroundStyle(Spine.Palette.textFaint)
                        }
                        Spacer(minLength: Spine.Space.sm)
                        Text("\(count(row.prompt)) / \(count(row.completion))")
                            .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                            .foregroundStyle(Spine.Palette.textDim)
                    }
                }
                if totalUnreported > 0 {
                    Text("\(totalUnreported) call\(totalUnreported == 1 ? "" : "s") reported no usage, so the totals are a floor.")
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textFaint)
                        .fixedSize(horizontal: false, vertical: true)
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
                    // Indented past the group's icon, with a hairline between items so
                    // neighbouring multi-line entries do not run together.
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(group.items.enumerated()), id: \.offset) { index, item in
                            if index > 0 { Divider().overlay(Spine.Palette.border) }
                            Text(item)
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                .foregroundStyle(Spine.Palette.textDim)
                                .lineLimit(3)
                                .help(item)
                                .padding(.vertical, Spine.Space.sm)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(.leading, Spine.Space.lg)
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
            ForEach(Array(toolSummaries.enumerated()), id: \.element.tool) { index, summary in
                if index > 0 { Divider().overlay(Spine.Palette.border) }
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
            ForEach(Array(children.enumerated()), id: \.element.id) { index, child in
                if index > 0 { Divider().overlay(Spine.Palette.border) }
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(child.agent ?? "agent")
                            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.semibold))
                            .foregroundStyle(Spine.Palette.text)
                        Spacer(minLength: Spine.Space.sm)
                        if let tier = child.tier { chip(label(tier), tint: tierTint(tier)) }
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
    private func tierTint(_ tier: String) -> Color {
        switch tier {
        case "fast": return Spine.Palette.ok
        case "standard": return Spine.Palette.accent
        case "deep": return Spine.Palette.attention
        default: return Spine.Palette.textFaint
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

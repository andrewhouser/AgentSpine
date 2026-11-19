import SwiftUI

/// Auto-approval proposals, ported from the web `PolicyProposals` component.
///
/// The contract is the same. The exact diff is on screen before the button is reachable;
/// the evidence resolves the cited confirmation ids lazily; accepting takes two steps
/// because it permanently stops the system asking about that shape; a failure is shown
/// rather than swallowed, and a success leaves a receipt after the card disappears.
struct ProposalsView: View {
    @State private var proposals: [PromotionProposal]?
    @State private var loadError: String?
    @State private var receipts: [String] = []
    @State private var approvals: [Int: Confirmation]?
    @State private var expanded: Set<String> = []
    @State private var evidenceError: String?
    @State private var pendingAccept: PromotionProposal?
    @State private var busy: String?
    @State private var failures: [String: String] = [:]

    var body: some View {
        List {
            Section {
                Text("Shapes you have approved again and again and never once rejected. "
                     + "Accepting one appends a single {tool, target} pair to "
                     + "policy.autoApprove, so that exact shape stops queueing and nothing "
                     + "broader does.")
                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).foregroundStyle(Spine.Palette.textDim)
            }
            ForEach(receipts, id: \.self) { receipt in
                Label(receipt, systemImage: "checkmark.circle.fill")
                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).foregroundStyle(Spine.Palette.ok)
            }
            if let loadError {
                ErrorNotice(message: loadError) { Task { await load() } }
            }
            if let proposals {
                if proposals.isEmpty && loadError == nil {
                    Text("Nothing has earned a proposal yet.").foregroundStyle(Spine.Palette.textDim)
                }
                ForEach(proposals) { proposal in card(proposal) }
            }
        }
        .navigationTitle("Proposals")
        .spineInlineTitle()
        .refreshable { await load() }
        .task { await load() }
        .overlay { if proposals == nil && loadError == nil { ProgressView() } }
        .alert(
            "Add this rule?",
            isPresented: Binding(get: { pendingAccept != nil }, set: { if !$0 { pendingAccept = nil } }),
            presenting: pendingAccept
        ) { proposal in
            Button("Add the rule") { Task { await accept(proposal) } }
            Button("Cancel", role: .cancel) {}
        } message: { proposal in
            Text("This stops asking you about \(proposal.tool) on "
                 + "\(label(proposal.target)). Undone by editing policy.json on the Mac.")
        }
    }

    @ViewBuilder
    private func card(_ proposal: PromotionProposal) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Text("\(proposal.tool) → \(label(proposal.target))")
                    .font(.system(.subheadline, design: .monospaced)).bold()
                Text("\(proposal.approvals) approval\(proposal.approvals == 1 ? "" : "s") · "
                     + "\(proposal.spanDays) day\(proposal.spanDays == 1 ? "" : "s") · no rejections")
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.textDim)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Most recent action of this shape").font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.textDim)
                Text(proposal.summary)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("What accepting changes").font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.textDim)
                Text(proposal.diff)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
            }
            DisclosureGroup(
                isExpanded: Binding(
                    get: { expanded.contains(proposal.id) },
                    set: { open in
                        if open {
                            expanded.insert(proposal.id)
                            Task { await loadEvidenceIfNeeded() }
                        } else {
                            expanded.remove(proposal.id)
                        }
                    }
                )
            ) {
                if let evidenceError {
                    Text("Could not read the ledger (\(evidenceError)); showing bare ids.")
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.warn)
                }
                ForEach(proposal.wouldHaveAutoRun, id: \.self) { id in
                    HStack(alignment: .firstTextBaseline) {
                        Text("#\(id)").font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.textDim)
                        if let row = approvals?[id] {
                            Text(row.summary).font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                        } else if approvals == nil {
                            Text("Reading the ledger…").font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).foregroundStyle(Spine.Palette.textDim)
                        } else {
                            Text("pruned from the ledger").font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).foregroundStyle(Spine.Palette.textDim)
                        }
                    }
                }
            } label: {
                Text("Would have auto-run \(proposal.wouldHaveAutoRun.count) past action"
                     + "\(proposal.wouldHaveAutoRun.count == 1 ? "" : "s"), and nothing else")
            }
            if let failure = failures[proposal.id] {
                Text(failure).font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).foregroundStyle(Spine.Palette.danger)
            }
            Button {
                pendingAccept = proposal
            } label: {
                HStack {
                    Text("Accept this proposal…")
                    Spacer()
                    if busy == proposal.id { ProgressView() }
                }
            }
            .disabled(busy != nil)
        }
    }

    private func label(_ target: String) -> String { target.isEmpty ? "(no target)" : target }

    private func load() async {
        do {
            proposals = try await APIClient.shared.proposals()
            loadError = nil
        } catch {
            proposals = []
            loadError = error.localizedDescription
        }
    }

    /// One request covers every card, so it is made once per visit and shared.
    private func loadEvidenceIfNeeded() async {
        guard approvals == nil else { return }
        do {
            let done = try await APIClient.shared.confirmations(state: "done")
            approvals = Dictionary(uniqueKeysWithValues: done.map { ($0.id, $0) })
            evidenceError = nil
        } catch {
            approvals = [:]
            evidenceError = error.localizedDescription
        }
    }

    private func accept(_ proposal: PromotionProposal) async {
        busy = proposal.id
        defer { busy = nil }
        do {
            let result = try await APIClient.shared.applyProposal(
                tool: proposal.tool, target: proposal.target
            )
            if result.ok {
                receipts.append(result.message)
                failures[proposal.id] = nil
                await load()
            } else {
                failures[proposal.id] = result.message
            }
        } catch {
            failures[proposal.id] = error.localizedDescription
        }
    }
}

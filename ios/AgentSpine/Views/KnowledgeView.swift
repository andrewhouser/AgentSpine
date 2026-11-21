//
//  KnowledgeView.swift
//  AgentSpine
//
//  Shared by the iPhone and Mac targets.
//

import SwiftUI

/// Review what was extracted, and read what is known. A machine-extracted claim is only a proposal until you accept
/// it or reject it; when an accepted decision replaces an earlier one, you say so. Briefs use reviewed claims only.
struct KnowledgeView: View {
    @Environment(AppState.self) private var state
    @State private var claims: [KnowledgeClaim] = []
    @State private var conflicts: [KnowledgeConflict] = []
    @State private var loaded = false
    @State private var loadError: String?
    @State private var actionError: String?
    @State private var replacing: (accepted: KnowledgeClaim, earlier: [KnowledgeClaim])?
    @State private var briefProject: Int?
    @State private var operation = "next-meeting"
    @State private var brief = ""

    private static let operations: [(key: String, label: String)] = [
        ("next-meeting", "Brief me for the next meeting"),
        ("what-changed", "What changed this week"),
        ("commitments", "Commitments, overdue first"),
        ("recurring-risks", "Risks that recur"),
        ("stale-topics", "Topics unresolved for a month"),
        ("weekly-summary", "Weekly summary"),
    ]

    var body: some View {
        List {
            if let loadError {
                ErrorNotice(message: loadError) { Task { await load() } }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            Section("Waiting for your review") {
                if claims.isEmpty { Text(loaded ? "Nothing is waiting." : "Loading…").foregroundStyle(Spine.Palette.textDim) }
                ForEach(claims) { claim in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(meta(claim)).font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.textFaint)
                        Text(claim.text).font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body).weight(.semibold))
                        Text("\u{201C}\(claim.passage)\u{201D} (\(claim.sourceText))")
                            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                            .foregroundStyle(Spine.Palette.textDim)
                        HStack {
                            Button("Accept") { Task { await accept(claim) } }.buttonStyle(.borderedProminent)
                            Button("Reject", role: .destructive) { Task { await review(claim, "reject") } }.buttonStyle(.bordered)
                        }
                        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                    }
                }
            }
            if !conflicts.isEmpty {
                Section("Conflicting information") {
                    ForEach(conflicts, id: \.topic) { group in
                        VStack(alignment: .leading, spacing: 6) {
                            Text("\(group.kind): \(group.topic)").font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body).weight(.semibold))
                            ForEach(group.claims) { claim in
                                HStack(alignment: .top) {
                                    Text("\(claim.text) (\(claim.sourceText))")
                                        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                                    Spacer()
                                    Button("Wrong") { Task { await retract(claim) } }.buttonStyle(.borderless)
                                }
                            }
                        }
                    }
                }
            }
            Section("Read a brief") {
                Picker("Project", selection: $briefProject) {
                    Text("Across everything").tag(Int?.none)
                    ForEach(state.projects) { project in Text(project.name).tag(Int?.some(project.id)) }
                }
                if briefProject == nil {
                    Picker("Operation", selection: $operation) {
                        ForEach(Self.operations, id: \.key) { Text($0.label).tag($0.key) }
                    }
                }
                Button(briefProject == nil ? "Show" : "Project brief") { Task { await readBrief() } }
                if !brief.isEmpty {
                    Text(brief).font(SpineFont.mono(Spine.TypeSize.footnote, relativeTo: .footnote)).textSelection(.enabled)
                }
            }
        }
        .navigationTitle("Knowledge")
        .refreshable { await load() }
        .task { await load() }
        .sheet(isPresented: Binding(get: { replacing != nil }, set: { if !$0 { replacing = nil } })) { replaceSheet }
        .alert(
            "That didn't work",
            isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(actionError ?? "")
        }
    }

    private var replaceSheet: some View {
        NavigationStack {
            List {
                Section {
                    Text("Choose what this replaces, or leave it. The earlier claim is kept, marked as replaced, with the trail.")
                        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                        .foregroundStyle(Spine.Palette.textDim)
                }
                ForEach(replacing?.earlier ?? []) { old in
                    Button(old.text) {
                        if let accepted = replacing?.accepted { Task { await replace(old, with: accepted) } }
                    }
                }
            }
            .navigationTitle("Does this replace one?")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Nothing is replaced") { replacing = nil } } }
        }
    }

    private func meta(_ c: KnowledgeClaim) -> String {
        var parts = [c.kind]
        if let owner = c.ownerName { parts.append("owner \(owner)") }
        if let due = c.due { parts.append("due \(due)") }
        if let said = c.saidOn { parts.append("said \(said)") }
        return parts.joined(separator: " · ")
    }

    private func load() async {
        do {
            async let list = APIClient.shared.knowledgeClaims(query: ["review": "proposed", "status": "active"])
            async let conf = try? APIClient.shared.knowledgeConflicts()
            claims = try await list
            conflicts = await conf ?? []
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
        loaded = true
    }

    private func review(_ claim: KnowledgeClaim, _ decision: String) async {
        do {
            try await APIClient.shared.knowledgeReview(claim.id, review: decision)
            await load()
        } catch { actionError = error.localizedDescription }
    }

    private func accept(_ claim: KnowledgeClaim) async {
        do {
            try await APIClient.shared.knowledgeReview(claim.id, review: "accept")
            if claim.kind == "decision" || claim.kind == "status" {
                var q = ["kind": claim.kind, "review": "reviewed", "status": "active"]
                if let project = claim.projectID { q["project"] = String(project) }
                let earlier = try await APIClient.shared.knowledgeClaims(query: q).filter { $0.id != claim.id }
                if !earlier.isEmpty { replacing = (claim, Array(earlier.prefix(8))) }
            }
            await load()
        } catch { actionError = error.localizedDescription }
    }

    private func replace(_ old: KnowledgeClaim, with newer: KnowledgeClaim) async {
        replacing = nil
        do {
            try await APIClient.shared.knowledgeSupersede(older: old.id, by: newer.id)
            await load()
        } catch { actionError = error.localizedDescription }
    }

    private func retract(_ claim: KnowledgeClaim) async {
        do {
            try await APIClient.shared.knowledgeReview(claim.id, status: "retracted")
            await load()
        } catch { actionError = error.localizedDescription }
    }

    private func readBrief() async {
        do {
            if let project = briefProject {
                brief = try await APIClient.shared.knowledgeBrief(kind: "project", subject: String(project))
            } else {
                brief = try await APIClient.shared.knowledgeBrief(kind: "op", subject: operation)
            }
        } catch { actionError = error.localizedDescription }
    }
}

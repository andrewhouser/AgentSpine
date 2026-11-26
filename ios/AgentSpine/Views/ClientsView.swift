import SwiftUI

/// A light client list, the next thing to do for each, and where the last 30 days went.
struct ClientsView: View {
    @State private var clients: [Client] = []
    @State private var totals: [TimeTotal] = []
    @State private var loaded = false
    @State private var loadError: String?
    @State private var actionError: String?
    @State private var adding = false
    @State private var newName = ""
    // Prospects (PLAN-open-work section 14, U4): ranked by the server, every sentence made there.
    @State private var prospects: [Client] = []
    @State private var pasting = false
    @State private var pasteText = ""
    /// What the last paste did, or what an outreach request started. Shown once, then cleared.
    @State private var notice: String?
    /// The prospect being audited or drafted for, so its row can say so.
    @State private var busyID: Int?

    /// Everyone who is not a prospect. Prospects have their own section, in ranked order.
    private var others: [Client] { clients.filter { !$0.isProspect } }

    var body: some View {
        List {
            if let loadError {
                ErrorNotice(message: loadError) { Task { await load() } }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }

            if !totals.isEmpty {
                Section("Last 30 days") {
                    ForEach(totals, id: \.self) { t in
                        HStack {
                            Text(t.client ?? "(no client)")
                            Spacer()
                            Text(t.label).foregroundStyle(Spine.Palette.textDim).monospacedDigit()
                        }
                    }
                }
            }

            if !prospects.isEmpty {
                Section {
                    ForEach(prospects) { p in prospectRow(p) }
                } header: {
                    Text("Prospects")
                } footer: {
                    Text("Ranked by what a look at each website found. Audit and Draft outreach are in each row's menu. Nothing is sent.")
                }
            }

            if clients.isEmpty && loadError == nil {
                EmptyNotice(
                    symbol: "person.crop.rectangle.stack",
                    title: loaded ? "No clients yet" : "Loading…",
                    detail: "Tell it in a thread — \"log 2 hours for Acme\" — or tap + to add one."
                )
                .listRowBackground(Color.clear)
            }

            Section(others.isEmpty ? "" : "Clients") {
                ForEach(others) { c in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(c.name).font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body).weight(.semibold))
                            Text(c.statusLabel ?? c.status)
                                .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                                .padding(.horizontal, 7).padding(.vertical, 2)
                                .background(.quaternary, in: Capsule())
                        }
                        if let next = c.nextAction {
                            let by = SpineDate.parse(c.nextActionDue).map {
                                " (by \($0.formatted(date: .abbreviated, time: .omitted)))"
                            } ?? ""
                            Label("\(next)\(by)", systemImage: "arrow.turn.down.right")
                                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).foregroundStyle(Spine.Palette.textDim)
                        }
                        if let email = c.email { Text(email).font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.textFaint) }
                        if let notes = c.notes, !notes.isEmpty {
                            Text(notes).font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.textDim).lineLimit(3)
                        }
                        ClientCommitmentsView(clientID: c.id)
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task { await remove(c) }
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }
            }
        }
        .navigationTitle("Clients")
        .refreshable { await load() }
        .task { await load() }
        .toolbar {
            ToolbarItem(placement: .spineTrailing) {
                Button { adding = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("New client")
            }
            ToolbarItem(placement: .spineTrailing) {
                Button { pasting = true } label: { Image(systemName: "doc.on.clipboard") }
                    .accessibilityLabel("Paste a list of prospects")
            }
        }
        .sheet(isPresented: $pasting) { prospectPasteSheet }
        .alert(
            "Prospects",
            isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(notice ?? "")
        }
        .alert("New client", isPresented: $adding) {
            TextField("Name", text: $newName)
            Button("Add") { Task { await add() } }
            Button("Cancel", role: .cancel) { newName = "" }
        }
        .alert(
            "That didn't work",
            isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(actionError ?? "")
        }
    }

    // MARK: - Prospects

    private func prospectRow(_ p: Client) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(p.name).font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body).weight(.semibold))
                Text(p.statusLabel ?? p.status)
                    .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(.quaternary, in: Capsule())
                Spacer()
                if busyID == p.id { ProgressView().controlSize(.small) }
                prospectMenu(p)
            }
            if let site = p.site {
                Text(site).font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.textFaint).lineLimit(1)
            }
            if let line = p.fitLine {
                Text(line).font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).foregroundStyle(Spine.Palette.textDim)
            }
            ForEach(p.fitReasons ?? [], id: \.self) { reason in
                Label(reason, systemImage: "circle.fill")
                    .labelStyle(ProspectReasonStyle())
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
            }
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) {
                Task { await remove(p) }
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    /// One menu a row, because a row has three things to do and a swipe has room for one.
    private func prospectMenu(_ p: Client) -> some View {
        Menu {
            Button(p.auditAt == nil ? "Audit the website" : "Audit again") { Task { await audit(p) } }
                .disabled(p.site == nil || busyID != nil)
            Button("Draft outreach") { Task { await outreach(p) } }
                .disabled(busyID != nil)
            Divider()
            ForEach(ClientStatus.all, id: \.value) { s in
                Button(statusTitle(s.label, current: s.value == p.status)) { Task { await setStatus(p, s.value) } }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("Actions for \(p.name)")
    }

    private func statusTitle(_ label: String, current: Bool) -> String {
        current ? "\(label) (now)" : "Mark as \(label)"
    }

    private var prospectPasteSheet: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $pasteText)
                        .frame(minHeight: 180)
                        .accessibilityLabel("Prospects to add, one per line")
                } footer: {
                    Text("One a line, as \"name, website\". For example: Rivera Plumbing, rivera-plumbing.example. A line it cannot read is reported and skipped.")
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Paste prospects")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { pasting = false } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { Task { await addPasted() } }
                        .disabled(pasteText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 380)
        #endif
    }

    private func addPasted() async {
        do {
            let r = try await APIClient.shared.addProspects(pasteText)
            var lines = ["Added \(r.added.count) of \(r.added.count + r.skipped.count)."]
            lines += r.skipped.map { "Skipped \"\($0.line)\": \($0.reason)." }
            pasting = false
            if r.skipped.isEmpty { pasteText = "" }
            notice = lines.joined(separator: "\n")
            await load()
        } catch {
            pasting = false
            actionError = error.localizedDescription
        }
    }

    private func audit(_ p: Client) async {
        busyID = p.id
        defer { busyID = nil }
        do {
            try await APIClient.shared.auditClient(p.id)
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func outreach(_ p: Client) async {
        busyID = p.id
        defer { busyID = nil }
        do {
            try await APIClient.shared.draftOutreach(p.id)
            notice = "A draft is being written in a new thread, \"Outreach: \(p.name)\". It will ask for your approval there. Nothing is sent."
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func setStatus(_ p: Client, _ status: String) async {
        do {
            try await APIClient.shared.upsertClient(name: p.name, status: status)
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func load() async {
        async let time = try? APIClient.shared.timeSummary(days: 30)
        // A server that predates prospects has no such route; the rest of the screen still loads.
        async let ranked = try? APIClient.shared.prospects()
        do {
            clients = try await APIClient.shared.clients()
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
        prospects = await ranked ?? []
        totals = await time?.totals ?? []
        loaded = true
    }

    private func add() async {
        let name = newName.trimmingCharacters(in: .whitespaces)
        newName = ""
        guard !name.isEmpty else { return }
        do {
            try await APIClient.shared.upsertClient(name: name, status: "lead")
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func remove(_ c: Client) async {
        do {
            try await APIClient.shared.deleteClient(c.id)
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }
}

/// A reason under a prospect: a small dot and the sentence, so three of them read as a list.
private struct ProspectReasonStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            configuration.icon.font(.system(size: 4)).foregroundStyle(Spine.Palette.textFaint)
            configuration.title.foregroundStyle(Spine.Palette.textDim)
        }
    }
}

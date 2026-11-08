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
                            Text(t.label).foregroundStyle(.secondary).monospacedDigit()
                        }
                    }
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

            Section(clients.isEmpty ? "" : "Clients") {
                ForEach(clients) { c in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(c.name).font(.body.weight(.semibold))
                            Text(c.status)
                                .font(.caption2)
                                .padding(.horizontal, 7).padding(.vertical, 2)
                                .background(.quaternary, in: Capsule())
                        }
                        if let next = c.nextAction {
                            let by = SpineDate.parse(c.nextActionDue).map {
                                " (by \($0.formatted(date: .abbreviated, time: .omitted)))"
                            } ?? ""
                            Label("\(next)\(by)", systemImage: "arrow.turn.down.right")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        if let email = c.email { Text(email).font(.caption).foregroundStyle(.tertiary) }
                        if let notes = c.notes, !notes.isEmpty {
                            Text(notes).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                        }
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
            ToolbarItem(placement: .topBarTrailing) {
                Button { adding = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("New client")
            }
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

    private func load() async {
        async let time = try? APIClient.shared.timeSummary(days: 30)
        do {
            clients = try await APIClient.shared.clients()
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
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

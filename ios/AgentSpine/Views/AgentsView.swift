import SwiftUI

/// The Dispatch units a delegation can go to, read off `agents/*.md` on the server.
struct AgentsView: View {
    @State private var agents: [AgentUnit] = []
    @State private var error: String?

    var body: some View {
        List {
            if let error {
                ErrorNotice(message: error) { Task { await load() } }
            }
            ForEach(agents) { agent in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(agent.name).font(.headline)
                        Spacer()
                        Text("\(agent.tier) · \(agent.maxSteps) steps")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Text(agent.description).font(.subheadline)
                    Text(agent.tools.joined(separator: ", "))
                        .font(.caption.monospaced()).foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
            }
        }
        .navigationTitle("Agents")
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        do {
            agents = try await APIClient.shared.agents()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

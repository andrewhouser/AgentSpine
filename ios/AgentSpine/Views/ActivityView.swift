import SwiftUI

/// Every recent run, whatever started it — a chat turn, a schedule, a watcher, the heartbeat.
///
/// This is the "is it actually doing anything" screen, and the reason it is a tab rather than
/// a section of the thread list is that most of what AgentSpine does has no thread: a watcher
/// firing every few minutes and a 6am brief are invisible everywhere else.
struct ActivityView: View {
    @Environment(AppState.self) private var state

    var body: some View {
        List {
            if let error = state.loadError {
                ErrorNotice(message: error) { Task { await state.refresh() } }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }

            if state.recentRuns.isEmpty && state.loadError == nil {
                EmptyNotice(
                    symbol: "list.bullet.rectangle",
                    title: state.lastLoaded == nil ? "Loading…" : "Nothing has run yet",
                    detail: "Chat turns, scheduled jobs and watchers all show up here."
                )
                .listRowBackground(Color.clear)
            }

            ForEach(state.recentRuns) { run in
                // Every row opens: a list of what ran is only half the point, and for a
                // watcher or a scheduled brief there is no thread to read it in instead.
                NavigationLink(value: run.id) {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: symbol(for: run))
                            .font(.caption)
                            .foregroundStyle(tint(for: run))
                            .frame(width: 18)

                        VStack(alignment: .leading, spacing: 3) {
                            Text(run.task ?? "(no task recorded)")
                                .font(.subheadline)
                                .lineLimit(2)
                            HStack(spacing: 6) {
                                Text(run.kind)
                                Text("·")
                                Text(run.status)
                                Text("·")
                                Text(SpineDate.relative(run.started))
                            }
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            if let note = run.note, !note.isEmpty, run.status == "failed" {
                                Text(note)
                                    .font(.caption2)
                                    .foregroundStyle(.red)
                                    .lineLimit(3)
                            }
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Activity")
        .navigationDestination(for: Int.self) { RunDetailView(runID: $0) }
        .refreshable { await state.refresh() }
    }

    private func symbol(for run: Run) -> String {
        switch run.status {
        case "running", "queued": return "circle.dotted"
        case "failed": return "exclamationmark.triangle.fill"
        default:
            switch run.kind {
            case "chat": return "bubble.left.fill"
            case "schedule": return "clock.fill"
            case "heartbeat": return "waveform.path.ecg"
            default: return "checkmark.circle.fill"
            }
        }
    }

    private func tint(for run: Run) -> Color {
        switch run.status {
        case "failed": return .red
        case "running", "queued": return .orange
        default: return .green
        }
    }
}

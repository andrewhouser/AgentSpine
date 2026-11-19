import SwiftUI

/// Every recent run on the left, the selected run in full on the right — the phone's Activity
/// list and its run screen side by side, so reading a trace does not mean losing your place in
/// the list. The run screen itself is the phone's, shared.
struct MacActivityView: View {
    @Environment(AppState.self) private var state
    @State private var selection: Int?

    var body: some View {
        HSplitView {
            list
                .frame(minWidth: 300, idealWidth: 360, maxWidth: 500)
            Group {
                if let selection {
                    RunDetailView(runID: selection).id(selection)
                } else {
                    EmptyNotice(symbol: "list.bullet.rectangle", title: "No run selected", detail: "Pick a run to see what it did.")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(minWidth: 420, maxWidth: .infinity)
            .background(Spine.Palette.bg)
        }
        .navigationTitle("Activity")
        .toolbar {
            ToolbarItem {
                Button { Task { await state.refresh() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .help("Refresh runs")
            }
        }
    }

    @ViewBuilder private var list: some View {
        if let error = state.loadError, state.recentRuns.isEmpty {
            ErrorNotice(message: error) { Task { await state.refresh() } }
        } else if state.recentRuns.isEmpty {
            EmptyNotice(
                symbol: "list.bullet.rectangle",
                title: state.lastLoaded == nil ? "Loading…" : "Nothing has run yet",
                detail: "Chat turns, scheduled jobs and watchers all show up here."
            )
        } else {
            List(state.recentRuns, selection: $selection) { run in
                row(run).tag(run.id)
            }
            .scrollContentBackground(.hidden)
        }
    }

    private func row(_ run: Run) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol(for: run))
                .accessibilityLabel(run.status == "failed" ? "Failed" : run.status == "running" || run.status == "queued" ? "In progress" : "Done")
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                .foregroundStyle(tint(for: run))
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 3) {
                Text(run.task ?? "(no task recorded)")
                    .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .subheadline))
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Text(run.kind)
                    Text("·")
                    Text(run.status)
                    Text("·")
                    Text(SpineDate.relative(run.started))
                }
                .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                .foregroundStyle(Spine.Palette.textDim)
                if let note = run.note, !note.isEmpty, run.status == "failed" {
                    Text(note)
                        .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                        .foregroundStyle(Spine.Palette.danger)
                        .lineLimit(3)
                }
            }
        }
        .padding(.vertical, 2)
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
        case "failed": return Spine.Palette.danger
        case "running", "queued": return Spine.Palette.warn
        default: return Spine.Palette.ok
        }
    }
}

import SwiftUI

/// The Mac's Check-in: what needs you right now, and what the check-in has said about it.
///
/// The same screen as the phone's `CheckinView`, and it says the same things because both take
/// every sentence from `CheckinWords` (Models.swift). It is a file of its own, not the phone's
/// view reused, because a new file belongs to one target until its Target Membership is ticked
/// in Xcode, and this one has to build without that step.
///
/// The list is the preview: reading it writes nothing and works with the check-in switched off.
/// "Check now" is the real thing: it records, and sends if the check-in is on.
struct MacCheckinView: View {
    @State private var status: CheckinStatus?
    @State private var preview: CheckinPreview?
    @State private var note: String?
    @State private var error: String?
    @State private var loaded = false
    @State private var busy = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spine.Space.md) {
                HStack(spacing: Spine.Space.sm) {
                    Button(busy ? "Checking…" : "Check now") { Task { await checkNow() } }
                        .buttonStyle(.borderedProminent)
                        // Switched off there is nothing to run; the list below still reads.
                        .disabled(busy || status?.mode == "off")
                        .help("Runs a real check now. It records, and sends if the check-in is on.")
                    Button("Refresh") { Task { await load() } }
                        .help("Reads again. Nothing is recorded or sent.")
                    if let last = status?.lastRun {
                        Text("Last check \(SpineDate.relative(last))").foregroundStyle(Spine.Palette.textDim)
                    }
                }
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))

                if let status { dim(CheckinWords.modeLine(mode: status.mode, intervalHours: status.intervalHours)) }
                if let note { Text(note).font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .subheadline)) }
                if let error { warning(error) }
                if let preview, !preview.errors.isEmpty { warning("Couldn't read everything: \(preview.errors.joined(separator: "; "))") }

                if let preview {
                    heading("If it checked now")
                    dim(CheckinWords.sendLine(wouldSend: preview.wouldSend, heldBy: preview.heldBy, mode: preview.mode))
                    if preview.wouldSend {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(preview.title).font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .subheadline).weight(.semibold))
                            dim(preview.body)
                        }
                        .padding(Spine.Space.sm + 2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Spine.Palette.bgElevated, in: RoundedRectangle(cornerRadius: Spine.Radius.md))
                    }

                    let groups = CheckinWords.groups(preview.items)
                    if groups.isEmpty { dim("Nothing is waiting on you.") }
                    ForEach(groups) { group in
                        heading("\(group.label) (\(group.items.count))")
                        ForEach(group.items) { item in
                            row(item.title, item.detail, mark: item.fresh && item.triggers ? "new" : nil)
                        }
                    }
                } else if !loaded {
                    dim("Reading mail and calendar on the server…")
                }

                if let runs = status?.runs, !runs.isEmpty {
                    heading("Past checks")
                    ForEach(runs) { run in
                        row(CheckinWords.runLabel(run.status), run.title.isEmpty ? "\(run.total) found" : run.title, mark: SpineDate.relative(run.at), markIsNew: false)
                    }
                }
            }
            .padding(Spine.Space.lg)
            .frame(maxWidth: 760, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle("Check-in")
        .task { await load() }
    }

    private func heading(_ text: String) -> some View {
        Text(text.uppercased())
            .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2).weight(.semibold))
            .tracking(0.6)
            .foregroundStyle(Spine.Palette.textFaint)
            .padding(.top, Spine.Space.sm)
    }

    private func dim(_ text: String) -> some View {
        Text(text)
            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
            .foregroundStyle(Spine.Palette.textDim)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func warning(_ text: String) -> some View {
        Text(text)
            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
            .foregroundStyle(Spine.Palette.danger)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// One line: who or what, a line of context, and a trailing mark ("new", or when a check ran).
    private func row(_ title: String, _ detail: String, mark: String?, markIsNew: Bool = true) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Spine.Space.sm) {
            Text(title).font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .subheadline).weight(.semibold))
            Text(detail)
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                .foregroundStyle(Spine.Palette.textDim)
                .lineLimit(1)
            Spacer(minLength: 0)
            if let mark {
                Text(mark)
                    .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2).weight(markIsNew ? .semibold : .regular))
                    .foregroundStyle(markIsNew ? Spine.Palette.accent : Spine.Palette.textFaint)
            }
        }
        .padding(.vertical, 3)
        .overlay(alignment: .bottom) { Divider() }
    }

    private func load() async {
        // Each on its own: a Gmail outage fails only the preview, and should not blank the log.
        status = (try? await APIClient.shared.checkinStatus()) ?? status
        do {
            preview = try await APIClient.shared.previewCheckin()
            error = nil
        } catch {
            if preview == nil { self.error = error.localizedDescription }
        }
        loaded = true
    }

    private func checkNow() async {
        busy = true
        defer { busy = false }
        do {
            let r = try await APIClient.shared.runCheckin()
            note = CheckinWords.runNote(status: r.status, title: r.title, errors: r.errors)
        } catch {
            note = error.localizedDescription
        }
        await load()
    }
}

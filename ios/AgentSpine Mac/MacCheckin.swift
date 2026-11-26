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
    /// The source switches after a change here, until the next status read catches up.
    @State private var switches: [String: Bool]?

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
                if !offLine.isEmpty { dim(offLine) }
                if !sortLine.isEmpty { dim(sortLine) }
                if let note { Text(note).font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .subheadline)) }
                if let error { warning(error) }
                if let preview, !preview.errors.isEmpty { warning("Couldn't read everything: \(preview.errors.joined(separator: "; "))") }

                if let preview {
                    heading("If it checked now")
                    dim(CheckinWords.sendLine(wouldSend: preview.wouldSend, heldBy: preview.heldBy, mode: preview.mode, off: CheckinWords.offKinds(switches ?? status?.sources)))
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
                        ForEach(rows(for: group, in: preview)) { item in
                            if item.kind == "mail" {
                                mailRow(item, bucket: preview.buckets?[item.key])
                            } else {
                                row(item.title, item.detail, mark: item.fresh && item.triggers ? "new" : nil)
                            }
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

                if status != nil {
                    heading("What it looks at")
                    ForEach(CheckinWords.sources, id: \.kind) { source in sourceRow(source.kind, source.label, source.hint) }
                    dim("Saved on the server. A source that is off is not read at all.")
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

    /// The switches as last read, with anything the server did not say read as on.
    private var offLine: String { CheckinWords.offLine(CheckinWords.offKinds(switches ?? status?.sources)) }

    /// One source: its switch, its name and what it reads.
    private func sourceRow(_ kind: String, _ label: String, _ hint: String) -> some View {
        Toggle(isOn: Binding(
            get: { (switches ?? status?.sources)?[kind] != false },
            set: { on in Task { await setSource(kind, on: on) } }
        )) {
            HStack(alignment: .firstTextBaseline, spacing: Spine.Space.sm) {
                Text(label).font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .subheadline).weight(.semibold))
                Text(hint)
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                    .foregroundStyle(Spine.Palette.textDim)
            }
        }
        .toggleStyle(.checkbox)
        .padding(.vertical, 3)
    }

    /// Sent at once, then the list is read again, because a source that is off is not read at all.
    /// A failure puts the switch back and says why.
    private func setSource(_ kind: String, on: Bool) async {
        var optimistic = switches ?? status?.sources ?? [:]
        optimistic[kind] = on
        switches = optimistic
        do {
            switches = try await APIClient.shared.setCheckinSource(kind, on: on)
            note = nil
        } catch {
            switches = nil
            note = error.localizedDescription
        }
        await load()
    }

    private func load() async {
        // Each on its own: a Gmail outage fails only the preview, and should not blank the log.
        if let fresh = try? await APIClient.shared.checkinStatus() {
            status = fresh
            switches = nil
        }
        do {
            preview = try await APIClient.shared.previewCheckin()
            error = nil
        } catch {
            if preview == nil { self.error = error.localizedDescription }
        }
        loaded = true
    }

    private var sortLine: String { CheckinWords.sortLine(status?.sortMode) }

    /// Mail is shown in bucket order when it has been sorted; every other section as it came.
    private func rows(for group: CheckinWords.Group, in preview: CheckinPreview) -> [CheckinItem] {
        group.kind == "mail" ? CheckinWords.mailOrder(group.items, buckets: preview.buckets) : group.items
    }

    private func bucketColor(_ bucket: CheckinBucket?) -> Color {
        bucket?.bucket == "urgent" ? Spine.Palette.warn : Spine.Palette.textDim
    }

    /// A mail row: the ordinary row, then its label in our words, and with sorting on a button
    /// that asks the server to draft a reply. The draft is read and approved like any other.
    private func mailRow(_ item: CheckinItem, bucket: CheckinBucket?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Spine.Space.sm) {
            Text(item.title).font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .subheadline).weight(.semibold))
            Text(item.detail)
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                .foregroundStyle(Spine.Palette.textDim)
                .lineLimit(1)
            Spacer(minLength: 0)
            if !CheckinWords.bucketLine(bucket).isEmpty {
                Text(CheckinWords.bucketLine(bucket))
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                    .foregroundStyle(bucketColor(bucket))
            }
            if item.fresh && item.triggers {
                Text("new")
                    .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2).weight(.semibold))
                    .foregroundStyle(Spine.Palette.accent)
            }
            if status?.sortMode == "on" {
                Button("Draft a reply") { Task { await draftReply(item) } }
                    .controlSize(.small)
                    .disabled(busy)
                    .help("Writes a reply for you to read and approve. Nothing is sent.")
            }
        }
        .padding(.vertical, 3)
        .overlay(alignment: .bottom) { Divider() }
    }

    private func draftReply(_ item: CheckinItem) async {
        busy = true
        defer { busy = false }
        note = "Drafting a reply to \(item.title)…"
        do {
            note = try await APIClient.shared.draftCheckinReply(messageId: CheckinWords.messageId(item.key)).message
        } catch {
            note = error.localizedDescription
        }
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

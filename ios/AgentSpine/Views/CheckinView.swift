import SwiftUI

/// What needs you right now, and what the check-in has said about it.
///
/// The list is the preview: it reads mail, calendar, tasks, approvals and Heads-up on the server
/// and writes nothing, so opening this screen never marks anything as seen, and it works with the
/// check-in switched off. "Check now" is the real thing: it records, and sends if it is on.
///
/// Every sentence comes from `CheckinWords` (Models.swift), so this, the Mac's `MacCheckinView`
/// and the web say the same thing. The two Swift screens are separate files because a new file is
/// in one target only until its Target Membership is ticked in Xcode; the shared part is the words.
struct CheckinView: View {
    @State private var status: CheckinStatus?
    @State private var preview: CheckinPreview?
    @State private var note: String?
    @State private var error: String?
    @State private var loaded = false
    @State private var busy = false
    /// The source switches after a change here, until the next status read catches up.
    @State private var switches: [String: Bool]?

    var body: some View {
        List {
            if let error {
                ErrorNotice(message: error) { Task { await load() } }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }

            Section {
                if let status {
                    Text(CheckinWords.modeLine(mode: status.mode, intervalHours: status.intervalHours))
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textDim)
                }
                if !offLine.isEmpty {
                    Text(offLine)
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textDim)
                }
                if !sortLine.isEmpty {
                    Text(sortLine)
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textDim)
                }
                if let note {
                    Text(note).font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .subheadline))
                }
                if let preview, !preview.errors.isEmpty {
                    Text("Couldn't read everything: \(preview.errors.joined(separator: "; "))")
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.danger)
                }
            }

            if let preview {
                Section("If it checked now") {
                    Text(CheckinWords.sendLine(wouldSend: preview.wouldSend, heldBy: preview.heldBy, mode: preview.mode, off: CheckinWords.offKinds(switches ?? status?.sources)))
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textDim)
                    if preview.wouldSend {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(preview.title).font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .subheadline).weight(.semibold))
                            Text(preview.body)
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                .foregroundStyle(Spine.Palette.textDim)
                        }
                    }
                }

                let groups = CheckinWords.groups(preview.items)
                if groups.isEmpty {
                    EmptyNotice(symbol: "envelope.badge", title: "Nothing is waiting on you", detail: "New mail from people, approvals, the next few hours, tasks due and open heads-ups show up here.")
                        .listRowBackground(Color.clear)
                }
                ForEach(groups) { group in
                    Section("\(group.label) (\(group.items.count))") {
                        ForEach(rows(for: group, in: preview)) { item in mailAwareRow(item, in: preview) }
                    }
                }
            } else if !loaded {
                EmptyNotice(symbol: "envelope.badge", title: "Loading…", detail: "Reading mail and calendar on the server.")
                    .listRowBackground(Color.clear)
            }

            if let runs = status?.runs, !runs.isEmpty {
                Section("Past checks") {
                    ForEach(runs) { run in CheckinRunRow(run: run) }
                }
            }

            if status != nil {
                Section {
                    ForEach(CheckinWords.sources, id: \.kind) { source in
                        Toggle(isOn: sourceBinding(source.kind)) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(source.label).font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .subheadline))
                                Text(source.hint)
                                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                    .foregroundStyle(Spine.Palette.textDim)
                            }
                        }
                    }
                } header: {
                    Text("What it looks at")
                } footer: {
                    Text("Saved on the server. A source that is off is not read at all.")
                }
            }
        }
        .navigationTitle("Check-in")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(busy ? "Checking…" : "Check now") { Task { await checkNow() } }
                    // Switched off there is nothing to run; the list above still reads.
                    .disabled(busy || status?.mode == "off")
            }
        }
        .task { await load() }
        .refreshable { await load() }
    }

    /// The switches as last read, with anything the server did not say read as on.
    private var offLine: String { CheckinWords.offLine(CheckinWords.offKinds(switches ?? status?.sources)) }

    /// One source's switch. The change is sent at once, and the list is read again because a
    /// source that is off is not read at all. A failure puts the switch back and says why.
    private func sourceBinding(_ kind: String) -> Binding<Bool> {
        Binding(
            get: { (switches ?? status?.sources)?[kind] != false },
            set: { on in Task { await setSource(kind, on: on) } }
        )
    }

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
        // Each is tried on its own: an older server has neither route, and a Gmail outage fails
        // only the preview, which should not blank the log of past checks.
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

    /// A mail row carries its label, and with sorting on a swipe that drafts a reply. The swipe
    /// only asks the server to write one: it is read and approved like any draft, and never sent.
    @ViewBuilder
    private func mailAwareRow(_ item: CheckinItem, in preview: CheckinPreview) -> some View {
        if item.kind == "mail" {
            CheckinItemRow(item: item, bucket: preview.buckets?[item.key])
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    if status?.sortMode == "on" {
                        Button("Draft a reply") { Task { await draftReply(item) } }
                            .tint(Spine.Palette.accent)
                            .disabled(busy)
                    }
                }
        } else {
            CheckinItemRow(item: item)
        }
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

/// One thing found: who or what, a line of context, and a mark if the next check would call it new.
struct CheckinItemRow: View {
    let item: CheckinItem
    /// The inbox bucket for a mail row, when sorting is on. Our words for it, never the sender's.
    var bucket: CheckinBucket? = nil

    private var bucketLine: String { CheckinWords.bucketLine(bucket) }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title).font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .subheadline).weight(.semibold))
                if !item.detail.isEmpty {
                    Text(item.detail)
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textDim)
                        .lineLimit(2)
                }
                if !bucketLine.isEmpty {
                    Text(bucketLine)
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).weight(bucket?.bucket == "urgent" ? .semibold : .regular))
                        .foregroundStyle(bucket?.bucket == "urgent" ? Spine.Palette.warn : Spine.Palette.textDim)
                }
            }
            Spacer(minLength: 0)
            if item.fresh && item.triggers {
                Text("new")
                    .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2).weight(.semibold))
                    .foregroundStyle(Spine.Palette.accent)
            }
        }
        .padding(.vertical, 2)
    }
}

/// One past check: when, what it did, and the title it used or would have.
struct CheckinRunRow: View {
    let run: CheckinRun

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(CheckinWords.runLabel(run.status))
                    .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .subheadline))
                    .foregroundStyle(run.status == "error" ? Spine.Palette.danger : Spine.Palette.text)
                Text("·")
                Text(SpineDate.relative(run.at))
            }
            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
            .foregroundStyle(Spine.Palette.textDim)
            Text(run.title.isEmpty ? "\(run.total) found" : run.title)
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                .foregroundStyle(Spine.Palette.textDim)
                .lineLimit(2)
        }
        .padding(.vertical, 2)
    }
}

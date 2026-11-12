import SwiftUI

/// Meetings: a live strip, the history, and a start button.
///
/// Capture binds to the Mac's microphone device list, which is odd remotely but not wrong:
/// there is one microphone and one session. Everything here is polled, never streamed.
struct MeetingsView: View {
    @State private var meetings: [Meeting] = []
    @State private var live: MeetingLiveStatus?
    @State private var error: String?
    @State private var loading = false
    @State private var showStart = false
    @State private var stopping = false
    /// The one tag the history is narrowed to, or nil for everything. The server can filter
    /// on several at once; one is all a phone-sized toolbar menu can express, and in practice
    /// one tag is already a short enough list to scroll.
    @State private var filterTag: String?
    @State private var tagCounts: [MeetingTagCount] = []

    var body: some View {
        List {
            if let error {
                ErrorNotice(message: error) { Task { await load() } }
            }
            if let live, live.recording, let id = live.meetingID {
                Section {
                    NavigationLink {
                        MeetingDetailView(meetingID: id)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Label("Recording", systemImage: "record.circle")
                                .foregroundStyle(.red)
                            Text("\(live.device ?? "microphone") · "
                                 + Self.clock(live.elapsedMs)
                                 + (live.pendingChunks > 0
                                    ? " · \(live.pendingChunks) chunk(s) behind" : ""))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Button("Stop recording", role: .destructive) {
                        Task { await stop() }
                    }
                    .disabled(stopping)
                }
            }
            Section {
                ForEach(meetings) { meeting in
                    NavigationLink {
                        MeetingDetailView(meetingID: meeting.id)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(meeting.displayTitle)
                            HStack(spacing: 6) {
                                Text(meeting.status)
                                Text("·")
                                Text("\(meeting.wordCount) words")
                                Text("·")
                                Text(SpineDate.relative(meeting.started))
                            }
                            .font(.caption).foregroundStyle(.secondary)
                            if !meeting.tagList.isEmpty {
                                Text(meeting.tagList.joined(separator: " · "))
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if meetings.isEmpty && !loading && error == nil {
                    Text(emptyMessage).foregroundStyle(.secondary)
                }
            } header: {
                if let filterTag { Text("Tagged “\(filterTag)”") }
            }
        }
        .navigationTitle("Meetings")
        .toolbar {
            if !tagCounts.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        // A Picker inside the menu gives the checkmark on the active tag for
                        // free, so the toolbar icon is not the only sign a filter is on.
                        Picker("Tag", selection: $filterTag) {
                            Text("All meetings").tag(String?.none)
                            ForEach(tagCounts) { entry in
                                Text("\(entry.tag) (\(entry.count))").tag(String?.some(entry.tag))
                            }
                        }
                    } label: {
                        Image(systemName: filterTag == nil
                              ? "line.3.horizontal.decrease.circle"
                              : "line.3.horizontal.decrease.circle.fill")
                    }
                    .accessibilityLabel("Filter by tag")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showStart = true } label: { Image(systemName: "mic.badge.plus") }
                    .disabled(live?.recording == true)
                    .accessibilityLabel("Start a meeting")
            }
        }
        .sheet(isPresented: $showStart) {
            StartMeetingSheet { await load() }
        }
        .onChange(of: filterTag) { Task { await load() } }
        .refreshable { await load() }
        .task {
            // Poll the live snapshot while this screen is up; `.task` cancels on disappear.
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(live?.recording == true ? 3 : 15))
            }
        }
        .task {
            // Not in the poll loop: the vocabulary only changes when someone edits tags, and
            // this re-runs on the way back from a detail screen, which is exactly when it did.
            tagCounts = (try? await APIClient.shared.meetingTags()) ?? []
        }
        .overlay { if loading && meetings.isEmpty { ProgressView() } }
    }

    static func clock(_ ms: Int) -> String {
        let total = ms / 1000
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    private var emptyMessage: String {
        if let filterTag { return "No meetings tagged “\(filterTag)”." }
        return "No meetings yet."
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            // Filtering happens on the server, not here: it is one query parameter, and it
            // means the `limit` window holds 50 matches rather than 50 of everything.
            async let list = APIClient.shared.meetings(tags: filterTag.map { [$0] } ?? [])
            async let status = APIClient.shared.meetingLive()
            (meetings, live) = try await (list, status)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func stop() async {
        stopping = true
        defer { stopping = false }
        do {
            try await APIClient.shared.stopMeeting()
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct StartMeetingSheet: View {
    let onStarted: () async -> Void
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss
    @State private var devices: AudioDevices?
    @State private var device = ""
    @State private var title = ""
    @State private var projectID: Int?
    @State private var error: String?
    @State private var starting = false

    var body: some View {
        NavigationStack {
            Form {
                if let error {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
                if let devices {
                    if !devices.enabled {
                        Text("Audio capture is off in policy.json on the server.")
                            .font(.footnote).foregroundStyle(.orange)
                    }
                    Section {
                        Picker("Microphone", selection: $device) {
                            ForEach(devices.devices, id: \.name) { d in
                                Text(d.allowed ? d.name : "\(d.name) (not allowlisted)").tag(d.name)
                            }
                        }
                    } footer: {
                        Text("These are the Mac's inputs, not the phone's.")
                    }
                }
                Section("Title (optional)") { TextField("Title", text: $title) }
                Section("Project (optional)") {
                    Picker("Project", selection: $projectID) {
                        Text("None").tag(Int?.none)
                        ForEach(state.projects) { Text($0.name).tag(Int?.some($0.id)) }
                    }
                }
            }
            .navigationTitle("Start a meeting")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Start") { Task { await start() } }
                        .disabled(starting || device.isEmpty)
                }
            }
            .task {
                do {
                    let found = try await APIClient.shared.meetingDevices()
                    devices = found
                    device = found.devices.first(where: \.allowed)?.name
                        ?? found.devices.first?.name ?? ""
                } catch {
                    self.error = error.localizedDescription
                }
            }
        }
    }

    private func start() async {
        starting = true
        defer { starting = false }
        do {
            try await APIClient.shared.startMeeting(device: device, projectID: projectID, title: title)
            await onStarted()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct MeetingDetailView: View {
    let meetingID: Int
    @Environment(AppState.self) private var state
    @State private var detail: MeetingDetail?
    @State private var cards: ContextCards?
    @State private var error: String?
    @State private var renaming = false
    @State private var newTitle = ""
    @State private var reprocessing = false
    @State private var headCount = ""
    @State private var renamingSpeaker: SpeakerTurn?
    @State private var speakerName = ""
    @State private var extracting = false
    @State private var coach: CoachState?
    @State private var asking = false
    /// What the server last said this meeting's tags are — set from a load or from the reply
    /// to an edit, never from what was typed. See `setTags`.
    @State private var tags: [String] = []
    @State private var tagCounts: [MeetingTagCount] = []
    @State private var addingTag = false
    @State private var newTag = ""
    @State private var savingTags = false

    private var recording: Bool { detail?.meeting.isRecording == true }
    /// The tags on offer when adding: in use somewhere, but not already on this meeting.
    private var offerableTags: [MeetingTagCount] {
        tagCounts.filter { !tags.contains($0.tag) }
    }

    var body: some View {
        List {
            if let error {
                ErrorNotice(message: error) { Task { await load() } }
            }
            if let detail {
                header(detail.meeting)
                tagsSection(detail.meeting)
                if recording { coachSection }
                if recording, let cards { contextSection(cards) }
                if let extraction = detail.extraction { summarySection(extraction) }
                workItemsSection(detail.workItems)
                transcriptSection(detail.segments)
            }
        }
        .navigationTitle(detail?.meeting.displayTitle ?? "Meeting")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let meeting = detail?.meeting {
                    Menu {
                        Button("Rename…") { newTitle = meeting.title ?? ""; renaming = true }
                        Menu("File under project") {
                            Button("None") { Task { await file(nil) } }
                            ForEach(state.projects) { project in
                                Button(project.name) { Task { await file(project.id) } }
                            }
                        }
                        Button("Re-run extraction") { Task { await extract() } }
                            .disabled(extracting || meeting.isRecording)
                        if meeting.hasKeptAudio {
                            Button("Re-run transcript…") { headCount = ""; reprocessing = true }
                                .disabled(meeting.isRecording || meeting.status == "transcribing")
                            Button("Delete kept audio", role: .destructive) { Task { await dropAudio() } }
                        }
                    } label: { Image(systemName: "ellipsis.circle") }
                }
            }
        }
        .alert("Rename meeting", isPresented: $renaming) {
            TextField("Title", text: $newTitle)
            Button("Save") { Task { await rename() } }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Add tag", isPresented: $addingTag) {
            TextField("Tag", text: $newTag)
            Button("Add") { Task { await setTags(tags + [newTag]) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("One label, like “standup”. The server lower-cases it and turns spaces into "
                 + "dashes, so what appears afterwards may not be exactly what you typed.")
        }
        .alert("Re-run transcript", isPresented: $reprocessing) {
            TextField("People in the meeting (blank = detect)", text: $headCount)
                .keyboardType(.numberPad)
            Button("Re-run") { Task { await reprocess() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Re-makes the transcript from the kept audio. Speaker names are reset and work items are not re-extracted.")
        }
        .alert(
            "Who is this?",
            isPresented: Binding(get: { renamingSpeaker != nil }, set: { if !$0 { renamingSpeaker = nil } })
        ) {
            TextField("Name", text: $speakerName)
            Button("Save") { Task { await renameSpeaker() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Renames every line by this speaker. Re-run extraction to use the name in work items.")
        }
        .refreshable { await load() }
        .task {
            // Fast while it is recording or being worked on, slow once settled.
            while !Task.isCancelled {
                await load()
                let busy = recording || extracting || coach?.thinking == true
                    || detail?.extraction?.status == "running"
                    || detail?.meeting.status == "transcribing"
                try? await Task.sleep(for: .seconds(busy ? 4 : 30))
            }
        }
        .task {
            // Fetched once rather than on every poll: this is only the list of tags to offer.
            tagCounts = (try? await APIClient.shared.meetingTags()) ?? []
        }
    }

    private func header(_ meeting: Meeting) -> some View {
        Section {
            LabeledContent("Status", value: meeting.status)
            LabeledContent("Started", value: SpineDate.relative(meeting.started))
            LabeledContent("Device", value: meeting.device)
            if meeting.hasKeptAudio, let until = SpineDate.parse(meeting.audioExpires) {
                LabeledContent("Audio kept until", value: until.formatted(date: .omitted, time: .shortened))
            }
            LabeledContent("Words", value: String(meeting.wordCount))
            if let id = meeting.projectID,
               let project = state.projects.first(where: { $0.id == id }) {
                LabeledContent("Project", value: project.name)
            }
            if let note = meeting.note, !note.isEmpty {
                Text(note).font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    /// A finished meeting's tags, with one add and one remove.
    ///
    /// Hidden while recording: tags are how you find a meeting again afterwards, and there is
    /// nothing to find until it has stopped. The server will happily tag a live one.
    @ViewBuilder
    private func tagsSection(_ meeting: Meeting) -> some View {
        if !meeting.isRecording {
            Section {
                ForEach(tags, id: \.self) { tag in
                    HStack {
                        Label(tag, systemImage: "tag")
                        Spacer()
                        Button(role: .destructive) {
                            Task { await setTags(tags.filter { $0 != tag }) }
                        } label: {
                            Image(systemName: "minus.circle")
                        }
                        .buttonStyle(.borderless)
                        .disabled(savingTags)
                        .accessibilityLabel("Remove tag \(tag)")
                    }
                }
                Menu {
                    // The tags already in use come first so the vocabulary stays small: left
                    // to retyping, "hooks" and "hook" both end up in the list within a week.
                    ForEach(offerableTags) { entry in
                        Button("\(entry.tag) (\(entry.count))") {
                            Task { await setTags(tags + [entry.tag]) }
                        }
                    }
                    Button("New tag…") { newTag = ""; addingTag = true }
                } label: {
                    HStack {
                        Label("Add tag", systemImage: "plus.circle")
                        Spacer()
                        if savingTags { ProgressView() }
                    }
                }
                .disabled(savingTags)
            } header: {
                Text("Tags")
            } footer: {
                Text("Lower-cased, de-duplicated and sorted by the server, up to 20 per "
                     + "meeting. They filter the meetings list here and in the dashboard, and "
                     + "narrow what the assistant searches.")
            }
        }
    }

    private var coachSection: some View {
        Section {
            Button {
                Task { await askCoach() }
            } label: {
                HStack {
                    Label("Ask the coach", systemImage: "sparkles")
                    Spacer()
                    if asking || coach?.thinking == true { ProgressView() }
                }
            }
            .disabled(asking || coach?.thinking == true)
            if let answer = coach?.answer {
                VStack(alignment: .leading, spacing: 4) {
                    if !answer.question.isEmpty {
                        Text(answer.question).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                    }
                    Text(answer.notes.isEmpty ? "The coach had nothing to add." : answer.notes)
                }
            }
        } header: {
            Text("Coach")
        } footer: {
            Text("Notes on what was just said. Needs MEETING_COACH_ENABLED on the server.")
        }
    }

    private func askCoach() async {
        asking = true
        defer { asking = false }
        do {
            try await APIClient.shared.askCoach(meetingID)
            coach = try? await APIClient.shared.coachState(meetingID)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func contextSection(_ cards: ContextCards) -> some View {
        Section("Related right now") {
            let all = cards.documents + cards.meetings + cards.memories
            if all.isEmpty {
                Text("Nothing relevant retrieved yet.").foregroundStyle(.secondary)
            }
            ForEach(Array(all.enumerated()), id: \.offset) { _, card in
                VStack(alignment: .leading, spacing: 2) {
                    Text(card.text).font(.footnote).lineLimit(4)
                    Text(card.source).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func summarySection(_ extraction: MeetingExtraction) -> some View {
        Section("Summary") {
            switch extraction.status {
            case "running":
                HStack { ProgressView(); Text("Extracting…") }
            case "failed":
                Text(extraction.note ?? "Extraction failed.").foregroundStyle(.red)
            default:
                if let summary = extraction.summary { Text(summary) }
                if !extraction.topics.isEmpty {
                    Text(extraction.topics.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary)
                }
                ForEach(extraction.decisions, id: \.text) { decision in
                    VStack(alignment: .leading, spacing: 2) {
                        Label(decision.text, systemImage: "checkmark.seal")
                        if let quote = decision.quote {
                            Text("“\(quote)”").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func workItemsSection(_ items: [MeetingWorkItem]) -> some View {
        if !items.isEmpty {
            Section {
                ForEach(items) { item in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(item.task)
                            Spacer()
                            Text(item.wasFiled ? "added to project tasks" : item.verdict)
                                .font(.caption2)
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(item.wasQueued || item.wasFiled ? Color.green.opacity(0.2)
                                                           : Color.secondary.opacity(0.2),
                                            in: Capsule())
                        }
                        if let owner = item.owner {
                            Text(owner).font(.caption).foregroundStyle(.secondary)
                        }
                        if let note = item.verdictNote, !note.isEmpty {
                            Text(note).font(.caption).foregroundStyle(.secondary)
                        }
                        if let quote = item.quote {
                            Text("“\(quote)”").font(.caption).italic().foregroundStyle(.secondary)
                        }
                    }
                }
            } header: {
                Text("Work items")
            } footer: {
                Text("“Queued” items are waiting in Approvals; “added to project tasks” went straight "
                     + "onto the project's list. The rest are kept, with their "
                     + "reasons, so the false-positive rate stays visible.")
            }
        }
    }

    private func transcriptSection(_ segments: [MeetingSegment]) -> some View {
        Section("Transcript") {
            if segments.isEmpty {
                Text("No transcript yet.").foregroundStyle(.secondary)
            }
            ForEach(SpeakerTurn.group(segments)) { turn in
                if let name = turn.speakerName {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 8) {
                            Button(name) {
                                speakerName = name.hasPrefix("Speaker ") ? "" : name
                                renamingSpeaker = turn
                            }
                            .font(.subheadline.weight(.semibold))
                            .buttonStyle(.borderless)
                            Text(turn.segments[0].timestamp)
                                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                        Text(turn.text)
                    }
                } else {
                    ForEach(turn.segments) { segment in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(segment.timestamp)
                                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            Text(segment.text)
                        }
                    }
                }
            }
        }
    }

    private func load() async {
        do {
            detail = try await APIClient.shared.meeting(meetingID)
            if let meeting = detail?.meeting { tags = meeting.tagList }
            if detail?.meeting.isRecording == true {
                cards = try? await APIClient.shared.meetingContext(meetingID)
                coach = try? await APIClient.shared.coachState(meetingID)
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func reprocess() async {
        do {
            try await APIClient.shared.reprocessMeeting(meetingID, speakers: Int(headCount))
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private func dropAudio() async {
        do {
            try await APIClient.shared.deleteMeetingAudio(meetingID)
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private func renameSpeaker() async {
        guard let turn = renamingSpeaker, let index = turn.speaker else { return }
        do {
            try await APIClient.shared.renameSpeaker(meetingID, index: index, to: speakerName)
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private func rename() async {
        do {
            try await APIClient.shared.retitleMeeting(meetingID, to: newTitle)
            await load()
        } catch { self.error = error.localizedDescription }
    }

    /// Send the whole set this meeting should have — adding and removing are both this call,
    /// because the route replaces the set wholesale.
    private func setTags(_ next: [String]) async {
        savingTags = true
        defer { savingTags = false }
        do {
            // Render the set the server stored, not the one just sent: typing "Standup " has
            // to show up as "standup", or the screen quietly disagrees with the database and
            // with every other client. Cheaper than a whole detail reload for the same truth.
            tags = try await APIClient.shared.setMeetingTags(meetingID, to: next)
            // A tag invented here has to appear in the offer list on the next meeting.
            tagCounts = (try? await APIClient.shared.meetingTags()) ?? tagCounts
        } catch { self.error = error.localizedDescription }
    }

    private func file(_ projectID: Int?) async {
        do {
            try await APIClient.shared.fileMeeting(meetingID, under: projectID)
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private func extract() async {
        extracting = true
        defer { extracting = false }
        do {
            try await APIClient.shared.extractMeeting(meetingID)
            await load()
        } catch { self.error = error.localizedDescription }
    }
}

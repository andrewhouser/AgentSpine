import SwiftUI

/// Meetings: a live strip, the history, and a start button.
///
/// A meeting is recorded either with this phone's own microphone (`PhoneRecorder`, which sends
/// audio to the server as it goes) or with one of the server Mac's inputs. There is one
/// recording at a time either way. Everything here is polled, never streamed.
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
    @State private var pendingDelete: Meeting?
    /// Recording from this phone's own microphone; see `PhoneRecorder`.
    private let phone = PhoneRecorder.shared

    var body: some View {
        List {
            if let error {
                ErrorNotice(message: error) { Task { await load() } }
            }
            if let notice = phone.notice {
                Text(notice)
                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                    .foregroundStyle(Spine.Palette.warn)
            }
            if phone.isRecording, case .buffering(let why) = phone.link {
                Text("Can't reach the server (\(why)). Audio is kept on this phone and sent when it's back"
                     + (phone.unsentSeconds > 0 ? " — \(phone.unsentSeconds) s waiting." : "."))
                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                    .foregroundStyle(Spine.Palette.warn)
            }
            if let live, live.recording, let id = live.meetingID {
                Section {
                    NavigationLink {
                        MeetingDetailView(meetingID: id)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Label("Recording", systemImage: "record.circle")
                                .foregroundStyle(Spine.Palette.danger)
                            Text("\(live.device == PhoneRecorder.source ? "this iPhone" : (live.device ?? "microphone")) · "
                                 + Self.clock(live.elapsedMs)
                                 + (live.pendingChunks > 0
                                    ? " · \(live.pendingChunks) chunk(s) behind" : ""))
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.textDim)
                        }
                    }
                    Button("Stop recording", role: .destructive) {
                        Task { await stop() }
                    }
                    .disabled(stopping)
                }
            } else if phone.isRecording {
                // Between starting on the phone and the first poll, or while the server is
                // unreachable: the phone still has a recording to finish.
                Section {
                    Label("Recording from this iPhone", systemImage: "record.circle")
                        .foregroundStyle(Spine.Palette.danger)
                    Button("Stop recording", role: .destructive) { Task { await stop() } }
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
                            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.textDim)
                            if !meeting.tagList.isEmpty {
                                Text(meeting.tagList.joined(separator: " · "))
                                    .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2)).foregroundStyle(Spine.Palette.textDim)
                            }
                        }
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) { pendingDelete = meeting } label: {
                            Label("Delete", systemImage: "trash")
                        }
                        .disabled(meeting.isRecording || meeting.status == "transcribing")
                    }
                }
                if meetings.isEmpty && !loading && error == nil {
                    Text(emptyMessage).foregroundStyle(Spine.Palette.textDim)
                }
            } header: {
                if let filterTag { Text("Tagged “\(filterTag)”") }
            }
        }
        .navigationTitle("Meetings")
        .toolbar {
            if !tagCounts.isEmpty {
                ToolbarItem(placement: .spineTrailing) {
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
            ToolbarItem(placement: .spineTrailing) {
                Button { showStart = true } label: { Image(systemName: "mic.badge.plus") }
                    .disabled(live?.recording == true)
                    .accessibilityLabel("Start a meeting")
            }
        }
        .sheet(isPresented: $showStart) {
            StartMeetingSheet { await load() }
        }
        .confirmationDialog(
            "Delete “\(pendingDelete?.displayTitle ?? "this meeting")”?",
            isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete meeting", role: .destructive) {
                if let meeting = pendingDelete { Task { await delete(meeting) } }
            }
        } message: {
            Text("Its transcript, summary, chat and kept audio are removed for good, along with the copy in its project. Tasks already added to a project stay.")
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

    private func delete(_ meeting: Meeting) async {
        do {
            try await APIClient.shared.deleteMeeting(meeting.id)
            meetings.removeAll { $0.id == meeting.id }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        pendingDelete = nil
    }

    private func stop() async {
        stopping = true
        defer { stopping = false }
        do {
            if phone.isRecording {
                // The phone has to finish sending what it captured before the server is told
                // to stop, so this goes through the recorder, not straight to the server.
                await phone.stop()
            } else {
                try await APIClient.shared.stopMeeting()
            }
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct StartMeetingSheet: View {
    static let phoneChoice = "\u{0}iphone"
    let onStarted: () async -> Void
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss
    @State private var devices: AudioDevices?
    /// `phoneChoice` records with this iPhone's own microphone; anything else is the name of one
    /// of the server Mac's inputs.
    #if os(iOS)
    @State private var device = StartMeetingSheet.phoneChoice
    #else
    @State private var device = ""
    #endif
    @State private var title = ""
    @State private var projectID: Int?
    @State private var error: String?
    @State private var starting = false

    var body: some View {
        NavigationStack {
            Form {
                if let error {
                    Text(error).font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).foregroundStyle(Spine.Palette.danger)
                }
                if let devices, !devices.enabled {
                    Text("Audio capture is off in policy.json on the server.")
                        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).foregroundStyle(Spine.Palette.warn)
                }
                Section {
                    Picker("Microphone", selection: $device) {
                        #if os(iOS)
                        Text("This iPhone").tag(Self.phoneChoice)
                        #endif
                        ForEach(devices?.devices ?? [], id: \.name) { d in
                            Text(d.allowed ? "Server Mac: \(d.name)" : "Server Mac: \(d.name) (not allowlisted)").tag(d.name)
                        }
                    }
                } footer: {
                    Text(device == Self.phoneChoice
                         ? "Records with the phone's built-in microphone and sends the audio to your server as it goes. Keep AgentSpine open or let it run in the background. The server's policy.json must list \"\(PhoneRecorder.source)\" under audio.remoteSources."
                         : "This is one of the server Mac's own inputs, not the phone's.")
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
            .spineInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Start") { Task { await start() } }
                        .disabled(starting || device.isEmpty)
                }
            }
            .task {
                // The phone is the default and needs no device list, so a failure here only
                // costs the Mac's inputs from the picker.
                devices = try? await APIClient.shared.meetingDevices()
                if device.isEmpty {
                    device = devices?.devices.first(where: \.allowed)?.name ?? devices?.devices.first?.name ?? ""
                }
            }
        }
    }

    private func start() async {
        starting = true
        defer { starting = false }
        do {
            if device == Self.phoneChoice {
                try await PhoneRecorder.shared.start(projectID: projectID, title: title)
            } else {
                try await APIClient.shared.startMeeting(device: device, projectID: projectID, title: title)
            }
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
    @Environment(\.dismiss) private var dismiss
    /// Called after the meeting is deleted, for a host (the Mac's split view) that has to drop
    /// its selection: `dismiss` does nothing when this view is the root of its stack.
    var onDeleted: (() -> Void)?
    @State private var confirmDelete = false
    @State private var detail: MeetingDetail?
    @State private var cards: ContextCards?
    @State private var error: String?
    @State private var renaming = false
    /// The project a meeting is about to be filed under, while the "what should it keep" question is open.
    @State private var filingUnder: Project?
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
    @State private var closingOut = false

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
                if detail.meeting.status == "done" {
                    Section { Button("Close out this meeting") { closingOut = true } }
                }
                if recording { coachSection }
                if recording, let cards { contextSection(cards) }
                if let extraction = detail.extraction { summarySection(extraction) }
                workItemsSection(detail.workItems)
                transcriptSection(detail.segments)
            }
        }
        .navigationTitle(detail?.meeting.displayTitle ?? "Meeting")
        .spineInlineTitle()
        .sheet(isPresented: $closingOut) {
            MeetingCloseoutView(meetingID: meetingID) { Task { await load() } }
        }
        .confirmationDialog(
            "What should \(filingUnder?.name ?? "the project") keep?",
            isPresented: Binding(get: { filingUnder != nil }, set: { if !$0 { filingUnder = nil } }),
            titleVisibility: .visible,
            presenting: filingUnder
        ) { project in
            Button("Keep the full transcript") { Task { await file(project.id, keepTranscript: true) } }
            Button("Summary, topics and decisions only") { Task { await file(project.id, keepTranscript: false) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("A kept transcript stays searchable in the project after the 30 day transcript retention window, until you delete the meeting.")
        }
        .toolbar {
            ToolbarItem(placement: .spineTrailing) {
                if let meeting = detail?.meeting {
                    Menu {
                        Button("Rename…") { newTitle = meeting.title ?? ""; renaming = true }
                        Menu("File under project") {
                            Button("None") { Task { await file(nil) } }
                            ForEach(state.projects) { project in
                                // Filing indexes the meeting, so it asks what the project should keep.
                                Button(project.name) { filingUnder = project }
                            }
                        }
                        if meeting.projectID != nil {
                            Button(meeting.keepTranscript == 0 ? "Keep the full transcript in the project" : "Keep only the summary in the project") {
                                Task { await setKeep(meeting.keepTranscript == 0) }
                            }
                        }
                        Button("Re-run extraction") { Task { await extract() } }
                            .disabled(extracting || meeting.isRecording)
                        if meeting.hasKeptAudio {
                            Button("Re-run transcript…") { headCount = ""; reprocessing = true }
                                .disabled(meeting.isRecording || meeting.status == "transcribing")
                            Button("Delete kept audio", role: .destructive) { Task { await dropAudio() } }
                        }
                        Button("Delete meeting…", role: .destructive) { confirmDelete = true }
                            .disabled(meeting.isRecording || meeting.status == "transcribing")
                    } label: { Image(systemName: "ellipsis.circle") }
                }
            }
        }
        .confirmationDialog("Delete this meeting?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete meeting", role: .destructive) { Task { await deleteMeeting() } }
        } message: {
            Text("Its transcript, summary, chat and kept audio are removed for good, along with the copy in its project. Tasks already added to a project stay.")
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
                .spineNumberPad()
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
                if let keeps = meeting.projectKeeps {
                    LabeledContent("Project keeps", value: keeps)
                }
            }
            if let note = meeting.note, !note.isEmpty {
                Text(note).font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).foregroundStyle(Spine.Palette.textDim)
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
                        Text(answer.question).font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.textDim).lineLimit(3)
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
                Text("Nothing relevant retrieved yet.").foregroundStyle(Spine.Palette.textDim)
            }
            ForEach(Array(all.enumerated()), id: \.offset) { _, card in
                VStack(alignment: .leading, spacing: 2) {
                    Text(card.text).font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).lineLimit(4)
                    Text(card.source).font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2)).foregroundStyle(Spine.Palette.textDim)
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
                Text(extraction.note ?? "Extraction failed.").foregroundStyle(Spine.Palette.danger)
            default:
                if let summary = extraction.summary { Text(summary) }
                if !extraction.topics.isEmpty {
                    Text(extraction.topics.joined(separator: " · "))
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.textDim)
                }
                ForEach(extraction.decisions, id: \.text) { decision in
                    VStack(alignment: .leading, spacing: 2) {
                        Label(decision.text, systemImage: "checkmark.seal")
                        if let quote = decision.quote {
                            Text("“\(quote)”").font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.textDim)
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
                                .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(item.wasQueued || item.wasFiled ? Color.green.opacity(0.2)
                                                           : Color.secondary.opacity(0.2),
                                            in: Capsule())
                        }
                        if let owner = item.owner {
                            Text(owner).font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.textDim)
                        }
                        if let note = item.verdictNote, !note.isEmpty {
                            Text(note).font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.textDim)
                        }
                        if let quote = item.quote {
                            Text("“\(quote)”").font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).italic().foregroundStyle(Spine.Palette.textDim)
                        }
                    }
                }
            } header: {
                Text("Work items")
            } footer: {
                Text("“Queued” items are waiting in the AgentSpine thread; “added to project tasks” went straight "
                     + "onto the project's list. The rest are kept, with their "
                     + "reasons, so the false-positive rate stays visible.")
            }
        }
    }

    private func transcriptSection(_ segments: [MeetingSegment]) -> some View {
        Section("Transcript") {
            if segments.isEmpty {
                Text("No transcript yet.").foregroundStyle(Spine.Palette.textDim)
            }
            ForEach(SpeakerTurn.group(segments)) { turn in
                if let name = turn.speakerName {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 8) {
                            Button(name) {
                                speakerName = name.hasPrefix("Speaker ") ? "" : name
                                renamingSpeaker = turn
                            }
                            .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .subheadline).weight(.semibold))
                            .buttonStyle(.borderless)
                            Text(turn.segments[0].timestamp)
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).monospacedDigit()).foregroundStyle(Spine.Palette.textDim)
                        }
                        Text(turn.text)
                    }
                } else {
                    ForEach(turn.segments) { segment in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(segment.timestamp)
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).monospacedDigit()).foregroundStyle(Spine.Palette.textDim)
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

    private func deleteMeeting() async {
        do {
            try await APIClient.shared.deleteMeeting(meetingID)
            onDeleted?()
            dismiss()
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

    private func file(_ projectID: Int?, keepTranscript: Bool? = nil) async {
        do {
            try await APIClient.shared.fileMeeting(meetingID, under: projectID, keepTranscript: keepTranscript)
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private func setKeep(_ keep: Bool) async {
        do {
            try await APIClient.shared.setMeetingKeep(meetingID, keepTranscript: keep)
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

/// One choice in a close-out, held on the device until it is saved.
private struct CloseoutDraft {
    var answer = "skip"
    var owner: String
    var replaces: Set<Int> = []
    var text: String
    var topic: String

    init(_ claim: CloseoutClaim) {
        owner = claim.ownerName ?? ""
        text = claim.text
        topic = claim.topic ?? ""
    }
}

/// Close out a finished meeting in one pass: name the speakers, choose the project, answer what was extracted, and say
/// what each decision replaces. Save stays locked until the preview has been shown for exactly these choices, because
/// accepting a replacement takes the earlier decision out of every brief. Shared by the iPhone and Mac targets.
struct MeetingCloseoutView: View {
    let meetingID: Int
    let onSaved: () -> Void
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss
    @State private var closeout: CloseoutState?
    @State private var names: [Int: String] = [:]
    @State private var projectID: Int?
    @State private var keepTranscript = true
    @State private var drafts: [Int: CloseoutDraft] = [:]
    @State private var preview: CloseoutPreview?
    @State private var busy = false
    @State private var error: String?
    @State private var saved: String?

    var body: some View {
        NavigationStack {
            Form {
                if let error { Section { Text(error).foregroundStyle(.red) } }
                if let saved { Section { Text(saved) } }
                if let closeout {
                    speakersSection(closeout)
                    projectSection(closeout)
                    claimsSection(closeout)
                    if let preview { previewSections(preview) }
                } else if error == nil {
                    ProgressView()
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Close out")
            .spineInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if preview == nil {
                        Button("Preview") { Task { await showPreview() } }.disabled(busy || closeout == nil)
                    } else {
                        Button("Save") { Task { await save() } }.disabled(busy)
                    }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 560)
        #endif
        .task {
            guard closeout == nil else { return }
            do {
                let first = try await APIClient.shared.meetingCloseout(meetingID, project: nil)
                projectID = first.meeting.projectId
                keepTranscript = first.meeting.keepTranscript != 0
                await load()
            } catch { self.error = error.localizedDescription }
        }
    }

    private func speakersSection(_ closeout: CloseoutState) -> some View {
        Section("Who was there") {
            if closeout.speakers.isEmpty { Text("No speakers were detected in this recording.") }
            ForEach(closeout.speakers, id: \.index) { speaker in
                TextField("Speaker \(speaker.index + 1)", text: Binding(
                    get: { names[speaker.index] ?? speaker.name },
                    set: { names[speaker.index] = $0; preview = nil }
                ))
            }
        }
    }

    private func projectSection(_ closeout: CloseoutState) -> some View {
        Section("Project") {
            Picker("Project", selection: Binding(
                get: { projectID },
                set: { next in
                    projectID = next
                    preview = nil
                    Task { await load() }
                }
            )) {
                Text("No project").tag(Int?.none)
                ForEach(state.projects) { Text($0.name).tag(Optional($0.id)) }
            }
            if projectID != nil, projectID != closeout.meeting.projectId {
                Toggle("Keep the full transcript searchable", isOn: $keepTranscript)
            }
        }
    }

    private func claimsSection(_ closeout: CloseoutState) -> some View {
        Section("Waiting for review (\(closeout.claims.count))") {
            if closeout.claims.isEmpty { Text("Nothing from this meeting is waiting for review.") }
            ForEach(closeout.claims) { claim in
                VStack(alignment: .leading, spacing: 8) {
                    Text(claim.kind.capitalized)
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textDim)
                    TextField("Text", text: draftBinding(claim, \.text), axis: .vertical)
                    Text("“\(claim.passage)”")
                        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                        .foregroundStyle(Spine.Palette.textDim)
                    TextField("Topic", text: draftBinding(claim, \.topic))
                    if claim.kind == "commitment" {
                        TextField("Owner", text: draftBinding(claim, \.owner))
                    }
                    Picker("Answer", selection: draftBinding(claim, \.answer)) {
                        Text("Accept").tag("accept")
                        Text("Reject").tag("reject")
                        Text("Later").tag("skip")
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    if drafts[claim.id]?.answer == "accept", !claim.canReplace.isEmpty {
                        Text("Does this replace an earlier one?")
                            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                            .foregroundStyle(Spine.Palette.textDim)
                        ForEach(claim.canReplace) { older in
                            Toggle(older.saidOn.map { "\(older.text) (\($0))" } ?? older.text, isOn: replaceBinding(claim, older.id))
                        }
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    @ViewBuilder
    private func previewSections(_ preview: CloseoutPreview) -> some View {
        Section("How the briefs will change") {
            Text("\(preview.accepted) accepted, \(preview.rejected) rejected, \(preview.replaced) replaced, \(preview.left) left for later.")
        }
        ForEach(preview.briefs, id: \.subject) { brief in
            Section("\(brief.subject): \(brief.waitingBefore) waiting now, \(brief.waitingAfter) after") {
                if brief.added.isEmpty && brief.removed.isEmpty { Text("No lines change.") }
                ForEach(brief.added, id: \.self) { Text("Adds to \($0.section): \($0.text) (\($0.evidence))") }
                ForEach(brief.removed, id: \.self) { Text("Leaves \($0.section): \($0.text)") }
            }
        }
    }

    private func draftBinding(_ claim: CloseoutClaim, _ field: WritableKeyPath<CloseoutDraft, String>) -> Binding<String> {
        Binding(
            get: { (drafts[claim.id] ?? CloseoutDraft(claim))[keyPath: field] },
            set: { value in
                var draft = drafts[claim.id] ?? CloseoutDraft(claim)
                draft[keyPath: field] = value
                drafts[claim.id] = draft
                preview = nil
            }
        )
    }

    private func replaceBinding(_ claim: CloseoutClaim, _ olderID: Int) -> Binding<Bool> {
        Binding(
            get: { drafts[claim.id]?.replaces.contains(olderID) == true },
            set: { on in
                var draft = drafts[claim.id] ?? CloseoutDraft(claim)
                if on { draft.replaces.insert(olderID) } else { draft.replaces.remove(olderID) }
                drafts[claim.id] = draft
                preview = nil
            }
        )
    }

    private func load() async {
        do {
            let next = try await APIClient.shared.meetingCloseout(meetingID, project: projectID)
            closeout = next
            error = nil
            names = Dictionary(uniqueKeysWithValues: next.speakers.map { ($0.index, names[$0.index] ?? $0.name) })
            // The earlier claims on offer belong to the project, so a choice made for another project is dropped.
            var kept: [Int: CloseoutDraft] = [:]
            for claim in next.claims {
                var draft = drafts[claim.id] ?? CloseoutDraft(claim)
                draft.replaces.formIntersection(claim.canReplace.map(\.id))
                kept[claim.id] = draft
            }
            drafts = kept
        } catch { self.error = error.localizedDescription }
    }

    private func plan(_ closeout: CloseoutState) -> [String: Any] {
        let claims: [[String: Any]] = closeout.claims.map { claim in
            let draft = drafts[claim.id] ?? CloseoutDraft(claim)
            let accepted = draft.answer == "accept"
            var row: [String: Any] = ["answer": draft.answer, "id": claim.id, "replaces": accepted ? Array(draft.replaces) : []]
            if accepted, draft.owner != (claim.ownerName ?? "") { row["owner"] = draft.owner }
            if accepted, draft.text != claim.text { row["text"] = draft.text }
            if accepted, draft.topic != (claim.topic ?? "") { row["topic"] = draft.topic }
            return row
        }
        let speakers: [[String: Any]] = closeout.speakers.compactMap { speaker in
            guard let name = names[speaker.index], name != speaker.name else { return nil }
            return ["index": speaker.index, "name": name]
        }
        return ["claims": claims, "projectId": projectID ?? NSNull(), "speakers": speakers]
    }

    private func showPreview() async {
        guard let closeout else { return }
        busy = true
        defer { busy = false }
        do {
            preview = try await APIClient.shared.previewMeetingCloseout(meetingID, plan: plan(closeout))
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func save() async {
        guard let closeout else { return }
        busy = true
        defer { busy = false }
        do {
            var body = plan(closeout)
            body["keepTranscript"] = keepTranscript
            let result = try await APIClient.shared.saveMeetingCloseout(meetingID, plan: body)
            preview = nil
            drafts = [:]
            error = nil
            saved = "Saved: \(result.accepted) accepted, \(result.rejected) rejected, \(result.replaced) replaced, \(result.left) left for later."
                + (result.filingError.map { " The project index was not updated: \($0)" } ?? "")
            await load()
            onSaved()
        } catch { self.error = error.localizedDescription }
    }
}

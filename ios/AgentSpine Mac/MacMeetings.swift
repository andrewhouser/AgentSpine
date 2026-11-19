import SwiftUI

/// Meetings on the Mac: the history on the left, and on the right either a meeting in progress
/// (the live transcript with the coach beside it, as in the UI Directions) or a finished one
/// (the phone's detail screen, which already knows summaries, work items and re-runs).
///
/// Recording itself is unchanged by this screen: it starts and stops the server-side capture the
/// phone uses. Capturing this Mac's own microphone and call audio is the rest of Phase 5 and
/// needs an ingest route on the server first.
struct MacMeetingsView: View {
    @State private var meetings: [Meeting] = []
    @State private var live: MeetingLiveStatus?
    @State private var selected: Int?
    @State private var error: String?
    @State private var showStart = false
    @State private var showRecord = false
    @State private var picked = false
    private let recorder = MacRecorder.shared

    var body: some View {
        HSplitView {
            list
                .frame(minWidth: 230, idealWidth: 260, maxWidth: 340)
            detail
                .frame(minWidth: 480, maxWidth: .infinity)
        }
        .navigationTitle("Meetings")
        .toolbar {
            ToolbarItem {
                Menu {
                    Button("Record from this Mac") { showRecord = true }
                    Button("Record from the server's microphone…") { showStart = true }
                } label: { Label("Start a meeting", systemImage: "mic.badge.plus") }
                    .disabled(live?.recording == true || recorder.isRecording)
                    .help("Start a meeting")
            }
        }
        .sheet(isPresented: $showStart) {
            StartMeetingSheet { await load() }
        }
        .sheet(isPresented: $showRecord) {
            MacRecordSheet { await load() }
        }
        .task {
            // Fast while something records, slow otherwise. `.task` ends with the screen.
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(live?.recording == true ? 3 : 15))
            }
        }
    }

    // MARK: List

    private var list: some View {
        List(selection: $selected) {
            if let error {
                Text(error)
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                    .foregroundStyle(Spine.Palette.danger)
            }
            if let live, live.recording, let id = live.meetingID {
                Section("Now") {
                    HStack(spacing: Spine.Space.sm) {
                        Circle().fill(Spine.Palette.danger).frame(width: 8, height: 8)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Recording")
                                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.semibold))
                            Text(live.device ?? "microphone")
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                .foregroundStyle(Spine.Palette.textDim)
                        }
                    }
                    .tag(id)
                }
            }
            Section("Recent meetings") {
                ForEach(meetings.filter { $0.id != live?.meetingID || live?.recording != true }) { meeting in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(meeting.displayTitle)
                            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                            .lineLimit(1)
                        Text("\(SpineDate.relative(meeting.started)) · \(meeting.wordCount) words")
                            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                            .foregroundStyle(Spine.Palette.textDim)
                    }
                    .tag(meeting.id)
                }
                if meetings.isEmpty && error == nil {
                    Text("No meetings yet.")
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textDim)
                }
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .background(Spine.Palette.bgSidebar)
    }

    // MARK: Detail

    @ViewBuilder private var detail: some View {
        if let selected {
            if live?.recording == true, live?.meetingID == selected {
                MacLiveMeeting(meetingID: selected) { await load() }
                    .id(selected)
            } else {
                NavigationStack { MeetingDetailView(meetingID: selected) }
                    .id(selected)
            }
        } else {
            EmptyNotice(
                symbol: "person.2.wave.2",
                title: "No meeting selected",
                detail: "Pick a meeting, or start one with the microphone button."
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Spine.Palette.bg)
        }
    }

    private func load() async {
        do {
            async let list = APIClient.shared.meetings()
            async let status = APIClient.shared.meetingLive()
            (meetings, live) = try await (list, status)
            error = nil
            // A meeting that just started is the one you want to see, once, not on every poll.
            if !picked, let id = live?.meetingID, live?.recording == true {
                selected = id
                picked = true
            }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: - A meeting in progress

/// The live transcript and the coach. Polled, never streamed, like the phone: a held connection
/// would not survive a sleeping laptop or a tailnet reconnect.
struct MacLiveMeeting: View {
    let meetingID: Int
    var onChanged: () async -> Void = {}

    @State private var detail: MeetingDetail?
    @State private var cards: ContextCards?
    @State private var coach: CoachState?
    @State private var error: String?
    @State private var asking = false
    @State private var stopping = false
    private let recorder = MacRecorder.shared

    private var meeting: Meeting? { detail?.meeting }
    private var recording: Bool { meeting?.isRecording == true }

    var body: some View {
        HSplitView {
            VStack(spacing: 0) {
                header
                Divider()
                captureStatus
                transcript
            }
            .frame(minWidth: 360, maxWidth: .infinity)
            coachColumn
                .frame(minWidth: 260, idealWidth: 300, maxWidth: 380)
        }
        .background(Spine.Palette.bg)
        .task {
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(recording ? 3 : 15))
            }
        }
    }

    // MARK: Capture status

    /// Only when this Mac is the microphone: whether the audio is getting through, and if not,
    /// that nothing is lost. The server's own capture has no such state to show.
    @ViewBuilder private var captureStatus: some View {
        if recorder.meetingID == meetingID, recorder.isRecording {
            HStack(spacing: Spine.Space.sm) {
                switch recorder.link {
                case .sending where recorder.phase == .finishing:
                    ProgressView().controlSize(.small)
                    Text("Sending the last of the audio… \(recorder.unsentSeconds) s left")
                case .sending:
                    Image(systemName: "mic.fill")
                    Text("Recording from this Mac")
                case .buffering:
                    Image(systemName: "externaldrive.badge.exclamationmark").foregroundStyle(Spine.Palette.warn)
                    Text("Can't reach the server. \(recorder.unsentSeconds) s of audio is kept on this Mac and will be sent when it's back.")
                }
                Spacer()
                if case .buffering = recorder.link, recorder.phase == .finishing {
                    Button("Stop without sending") { Task { await recorder.abandon(); await load(); await onChanged() } }
                        .buttonStyle(.link)
                }
            }
            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
            .foregroundStyle(Spine.Palette.textDim)
            .padding(.horizontal, Spine.Space.lg)
            .padding(.vertical, Spine.Space.sm)
            Divider()
        } else if let notice = recorder.notice, recorder.meetingID == nil, recording == false {
            Text(notice)
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                .foregroundStyle(Spine.Palette.warn)
                .padding(.horizontal, Spine.Space.lg)
                .padding(.vertical, Spine.Space.sm)
            Divider()
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: Spine.Space.md) {
            Circle().fill(recording ? Spine.Palette.danger : Spine.Palette.textFaint).frame(width: 9, height: 9)
            Text(meeting?.displayTitle ?? "Meeting")
                .font(SpineFont.display(Spine.TypeSize.title3, relativeTo: .title3))
                .foregroundStyle(Spine.Palette.text)
                .lineLimit(1)
            if let started = SpineDate.parse(meeting?.started) {
                // A clock that ticks on its own, so the header does not wait on the 3-second poll.
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(Self.clock(context.date.timeIntervalSince(started)))
                        .font(SpineFont.mono(Spine.TypeSize.footnote, relativeTo: .footnote))
                        .foregroundStyle(Spine.Palette.textDim)
                }
            }
            // Meeting work never leaves the machine: SPEC 15, and the cloud tier cannot see it.
            Text("Stays on your network")
                .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2).weight(.medium))
                .foregroundStyle(Spine.Palette.accent)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Spine.Palette.accent.opacity(0.14), in: Capsule())
            Spacer()
            if recording {
                Button(role: .destructive) { Task { await stop() } } label: {
                    Text(stopping ? "Stopping…" : "Stop recording")
                }
                .disabled(stopping)
            }
        }
        .padding(.horizontal, Spine.Space.lg)
        .padding(.vertical, Spine.Space.md)
    }

    private static func clock(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds))
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%02d:%02d", m, s)
    }

    // MARK: Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: Spine.Space.lg) {
                    if let error {
                        Text(error)
                            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                            .foregroundStyle(Spine.Palette.danger)
                    }
                    let segments = detail?.segments ?? []
                    if segments.isEmpty {
                        Text(recording ? "Listening. Words appear a few seconds after they are said." : "No transcript yet.")
                            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                            .foregroundStyle(Spine.Palette.textDim)
                    }
                    ForEach(SpeakerTurn.group(segments)) { turn in
                        HStack(alignment: .firstTextBaseline, spacing: Spine.Space.lg) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(turn.speakerName ?? "")
                                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.semibold))
                                    .foregroundStyle(color(for: turn.speaker))
                                Text(turn.segments[0].timestamp)
                                    .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                                    .foregroundStyle(Spine.Palette.textFaint)
                            }
                            .frame(width: 76, alignment: .leading)
                            Text(turn.text)
                                .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body))
                                .foregroundStyle(Spine.Palette.text)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    if recording {
                        HStack(spacing: Spine.Space.sm) {
                            ProgressView().controlSize(.small)
                            Text("Listening")
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                .foregroundStyle(Spine.Palette.textDim)
                        }
                        .padding(.leading, 76 + Spine.Space.lg)
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(Spine.Space.lg)
            }
            .onChange(of: detail?.segments.count) { _, _ in
                withAnimation { proxy.scrollTo("end", anchor: .bottom) }
            }
        }
    }

    /// A fixed handful of colours by speaker index; nil (the live pass, before speakers are
    /// told apart) is the plain dim colour.
    private func color(for speaker: Int?) -> Color {
        guard let speaker else { return Spine.Palette.textDim }
        let palette = [Spine.Palette.attention, Spine.Palette.accent, Spine.Palette.ok, Spine.Palette.danger]
        return palette[speaker % palette.count]
    }

    // MARK: Coach

    private var coachColumn: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spine.Space.lg) {
                HStack {
                    Text("Coach")
                        .font(SpineFont.display(Spine.TypeSize.title3, relativeTo: .title3))
                        .foregroundStyle(Spine.Palette.text)
                    Spacer()
                    Button {
                        Task { await askCoach() }
                    } label: {
                        if asking || coach?.thinking == true {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Ask now")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(!recording || asking || coach?.thinking == true)
                    .help("Notes on what was just said. Needs MEETING_COACH_ENABLED on the server.")
                }

                if let answer = coach?.answer {
                    label("Suggested for you")
                    VStack(alignment: .leading, spacing: Spine.Space.sm) {
                        if !answer.question.isEmpty {
                            Text(answer.question)
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                .foregroundStyle(Spine.Palette.textDim)
                                .lineLimit(3)
                        }
                        Text(answer.notes.isEmpty ? "The coach had nothing to add." : answer.notes)
                            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                            .foregroundStyle(Spine.Palette.text)
                            .textSelection(.enabled)
                    }
                    .padding(Spine.Space.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Spine.Palette.bgElevated, in: RoundedRectangle(cornerRadius: Spine.Radius.md))
                    .overlay(RoundedRectangle(cornerRadius: Spine.Radius.md).strokeBorder(Spine.Palette.border))
                }

                let related = (cards?.meetings ?? []) + (cards?.documents ?? []) + (cards?.memories ?? [])
                if !related.isEmpty {
                    label("From earlier notes")
                    ForEach(Array(related.enumerated()), id: \.offset) { _, card in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(card.source)
                                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.semibold))
                                .foregroundStyle(Spine.Palette.text)
                                .lineLimit(1)
                            Text(card.text)
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                .foregroundStyle(Spine.Palette.textDim)
                                .lineLimit(4)
                        }
                        .padding(Spine.Space.md)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Spine.Palette.bgElevated, in: RoundedRectangle(cornerRadius: Spine.Radius.md))
                        .overlay(RoundedRectangle(cornerRadius: Spine.Radius.md).strokeBorder(Spine.Palette.border))
                    }
                }

                let items = (detail?.workItems ?? []).filter(\.wasQueued)
                if !items.isEmpty {
                    HStack {
                        label("Possible action items")
                        Spacer()
                        Text("\(items.count) to review")
                            .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                            .foregroundStyle(Spine.Palette.attention)
                    }
                    ForEach(items) { item in
                        // Hollow amber, as on the spine: a question waiting on you, not a result.
                        HStack(alignment: .top, spacing: Spine.Space.sm) {
                            Circle().strokeBorder(Spine.Palette.attention, lineWidth: 2).frame(width: 10, height: 10).padding(.top, 4)
                            Text(item.task)
                                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                                .foregroundStyle(Spine.Palette.text)
                        }
                        .padding(Spine.Space.md)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Spine.Palette.bgElevated, in: RoundedRectangle(cornerRadius: Spine.Radius.md))
                        .overlay(RoundedRectangle(cornerRadius: Spine.Radius.md).strokeBorder(Spine.Palette.border))
                    }
                    Text("These go to your confirmation queue after the meeting. Nothing is saved until you approve it.")
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textFaint)
                }

                if coach?.answer == nil, related.isEmpty, items.isEmpty {
                    Text("Nothing yet. Notes and related material from earlier meetings appear here as the conversation goes.")
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textFaint)
                }
            }
            .padding(Spine.Space.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Spine.Palette.bgSidebar)
    }

    private func label(_ text: String) -> some View {
        Text(text.uppercased())
            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).weight(.semibold))
            .tracking(0.6)
            .foregroundStyle(Spine.Palette.textFaint)
    }

    // MARK: Loading

    private func load() async {
        do {
            detail = try await APIClient.shared.meeting(meetingID)
            if detail?.meeting.isRecording == true {
                cards = try? await APIClient.shared.meetingContext(meetingID)
                coach = try? await APIClient.shared.coachState(meetingID)
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
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

    private func stop() async {
        stopping = true
        defer { stopping = false }
        do {
            // A recording from this Mac must hand over its last chunks before the server stops.
            if recorder.meetingID == meetingID, recorder.isRecording {
                await recorder.stop()
            } else {
                try await APIClient.shared.stopMeeting()
            }
            await load()
            await onChanged()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

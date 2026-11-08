import SwiftUI

/// Jobs that run on a clock, and the one screen here you will reach for while away from the
/// Mac: "run the brief now", "pause that watcher, it's noisy".
///
/// **This tab can edit.** `PATCH /api/schedules/:id` has always accepted name, task and
/// spec, but until now every client sent only `enabled`, so changing a job meant deleting
/// and recreating it — losing its `last_run` and its id. There was no reason for that
/// beyond nobody having wired up the form, and a new client should not inherit it.
///
/// **Running now is a long request.** The route answers when the cycle finishes, not when
/// it starts, and a cycle on the local model takes minutes. It goes through `longSession`
/// for that reason; the button stays spinning and says so rather than timing out on a job
/// that is in fact running fine.
struct SchedulesView: View {
    @State private var schedules: [Schedule] = []
    /// Recent runs grouped by the schedule that started them, so a card can show its own
    /// history. `last_run` says a job ran; this says whether it worked.
    @State private var history: [Int: [Run]] = [:]
    @State private var loaded = false
    @State private var running: Int?
    @State private var editor: Editor?

    /// Two kinds of failure, shown two ways.
    ///
    /// `loadError` is the list failing to arrive — there is nothing on screen, so the
    /// notice belongs in the list. `actionError` is a Pause or a Delete that failed while
    /// the list is fine, and it has to be an alert: the notice would render at the top of a
    /// list you are scrolled four cards down in, and a destructive action that silently did
    /// nothing is the worst version of this screen.
    @State private var loadError: String?
    @State private var actionError: String?
    /// Programmatic, because a `NavigationLink` inside a `List` row draws its own
    /// disclosure chevron — fine for a row, wrong after each chip in a horizontal strip of
    /// them. A plain button plus `navigationDestination(item:)` navigates without the
    /// decoration.
    @State private var openRun: Int?

    /// Create and edit share one `.sheet`, and must.
    ///
    /// Two `.sheet` modifiers on the same view silently do not work in SwiftUI — the second
    /// wins and the first never presents. Driving both from one optional enum is the
    /// supported shape, and it is also the honest one: there is only ever one form open.
    private enum Editor: Identifiable {
        case create
        case edit(Schedule)

        var id: Int {
            switch self {
            case .create: return -1
            case .edit(let schedule): return schedule.id
            }
        }

        var schedule: Schedule? {
            switch self {
            case .create: return nil
            case .edit(let schedule): return schedule
            }
        }
    }

    var body: some View {
        List {
            if let loadError {
                ErrorNotice(message: loadError) { Task { await load() } }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }

            if schedules.isEmpty && loadError == nil {
                EmptyNotice(
                    symbol: "clock",
                    title: loaded ? "No schedules yet" : "Loading…",
                    detail: "A job that runs on a clock — a morning brief, or a watcher that "
                        + "stays quiet unless something changed."
                )
                .listRowBackground(Color.clear)
            }

            ForEach(schedules) { schedule in
                ScheduleCard(
                    schedule: schedule,
                    recent: history[schedule.id] ?? [],
                    openRun: { openRun = $0 },
                    isRunning: running == schedule.id,
                    edit: { editor = .edit(schedule) },
                    runNow: { Task { await runNow(schedule) } },
                    toggle: { Task { await setEnabled(schedule, to: !schedule.isEnabled) } }
                )
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                .listRowSeparator(.hidden)
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        Task { await remove(schedule) }
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Schedules")
        .navigationDestination(item: $openRun) { RunDetailView(runID: $0) }
        .refreshable { await load() }
        .task { await load() }
        .alert(
            "That didn't work",
            isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(actionError ?? "")
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { editor = .create } label: { Image(systemName: "plus") }
                    .accessibilityLabel("New schedule")
            }
        }
        .sheet(item: $editor) { editor in
            ScheduleForm(schedule: editor.schedule) { name, spec, task in
                if let existing = editor.schedule {
                    try await APIClient.shared.updateSchedule(
                        existing.id, name: name, spec: spec, task: task
                    )
                } else {
                    _ = try await APIClient.shared.createSchedule(name: name, spec: spec, task: task)
                }
                await load()
            }
        }
    }

    /// The jobs, and what they have been doing.
    ///
    /// The run list is fetched concurrently and allowed to fail on its own: it decorates
    /// the cards, and a server that cannot answer it should still show you the schedules.
    /// 200 covers a few days even on a tailnet busy with watchers; a job quieter than that
    /// simply shows no history, which is honest — the app has not seen any.
    private func load() async {
        async let fresh = APIClient.shared.schedules()
        async let runs = try? APIClient.shared.runs(limit: 200)

        do {
            schedules = try await fresh
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }

        let recent = await runs ?? []
        history = Dictionary(grouping: recent.compactMap { run -> (Int, Run)? in
            guard let id = run.scheduleID else { return nil }
            return (id, run)
        }) { $0.0 }.mapValues { pairs in Array(pairs.map(\.1).prefix(5)) }

        loaded = true
    }

    private func setEnabled(_ schedule: Schedule, to enabled: Bool) async {
        do {
            try await APIClient.shared.updateSchedule(schedule.id, enabled: enabled)
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func runNow(_ schedule: Schedule) async {
        running = schedule.id
        defer { running = nil }
        do {
            try await APIClient.shared.runScheduleNow(schedule.id)
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func remove(_ schedule: Schedule) async {
        do {
            try await APIClient.shared.deleteSchedule(schedule.id)
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }
}

// MARK: - One job

struct ScheduleCard: View {
    let schedule: Schedule
    /// Newest first, already trimmed to a handful by the caller.
    let recent: [Run]
    let openRun: (Int) -> Void
    let isRunning: Bool
    let edit: () -> Void
    let runNow: () -> Void
    let toggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(schedule.name)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text(schedule.isEnabled ? "enabled" : "paused")
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(
                        (schedule.isEnabled ? Color.green : Color.secondary).opacity(0.15),
                        in: Capsule()
                    )
                    .foregroundStyle(schedule.isEnabled ? .green : .secondary)
            }

            if let spec = schedule.spec, !spec.isEmpty {
                Label(spec, systemImage: "clock")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Text(schedule.task)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 6) {
                Text("last \(when(schedule.lastRun))")
                Text("·")
                Text("next \(when(schedule.nextRun))")
            }
            .font(.caption2)
            .foregroundStyle(.tertiary)

            // What it has actually been doing. `last_run` says a job ran; this says whether
            // it worked, which is the question that brings you to this screen. Each chip
            // opens the run in full — a watcher's output exists nowhere else.
            if !recent.isEmpty {
                HStack(spacing: 6) {
                    ForEach(recent) { run in
                        Button { openRun(run.id) } label: {
                            HStack(spacing: 4) {
                                Image(systemName: symbol(for: run))
                                    .font(.system(size: 9))
                                Text(SpineDate.relative(run.started))
                                    .font(.caption2)
                            }
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(tint(for: run).opacity(0.14), in: Capsule())
                            .foregroundStyle(tint(for: run))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Run from \(SpineDate.relative(run.started)), \(run.status)")
                        .accessibilityHint("Opens this run in full")
                    }
                    Spacer(minLength: 0)
                }
            }

            HStack(spacing: 10) {
                Button(schedule.isEnabled ? "Pause" : "Enable", action: toggle)
                    .buttonStyle(.bordered)
                    .controlSize(.small)

                Button(action: runNow) {
                    if isRunning {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.mini)
                            Text("Running…")
                        }
                    } else {
                        Text("Run now")
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(isRunning)

                Spacer()

                Button("Edit", action: edit)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
        .padding(14)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
    }

    private func symbol(for run: Run) -> String {
        switch run.status {
        case "failed": return "exclamationmark.triangle.fill"
        case "running", "queued": return "circle.dotted"
        default: return "checkmark"
        }
    }

    private func tint(for run: Run) -> Color {
        switch run.status {
        case "failed": return .red
        case "running", "queued": return .orange
        default: return .green
        }
    }

    private func when(_ iso: String?) -> String {
        guard let iso, !iso.isEmpty, SpineDate.parse(iso) != nil else { return "—" }
        return SpineDate.relative(iso)
    }
}

// MARK: - Create or edit

/// One form for both, because they differ only in what they start with and where they send
/// it. The spec field is free text rather than a picker: the server parses a small English
/// grammar and answers a bad spec with a message listing the forms that work, which is more
/// useful — and stays correct as the grammar grows — than a picker that can only offer what
/// this build happened to know about.
struct ScheduleForm: View {
    let schedule: Schedule?
    let submit: (String, String, String) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var spec: String
    @State private var task: String
    @State private var error: String?
    @State private var saving = false

    /// Seeded in `init`, not in `onAppear`.
    ///
    /// `onAppear` fires again when the sheet comes back — after a backgrounding, say — and
    /// seeding there would overwrite whatever had been typed with the values the schedule
    /// had when the form opened. `State(initialValue:)` runs exactly once, which is what
    /// "the form starts from the existing schedule" actually means.
    init(schedule: Schedule?, submit: @escaping (String, String, String) async throws -> Void) {
        self.schedule = schedule
        self.submit = submit
        _name = State(initialValue: schedule?.name ?? "")
        _spec = State(initialValue: schedule?.spec ?? "")
        _task = State(initialValue: schedule?.task ?? "")
    }

    private var isValid: Bool {
        ![name, spec, task].contains { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("morning-brief", text: $name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                Section {
                    TextField("weekdays at 8:00am", text: $spec)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("When")
                } footer: {
                    Text("Plain English: “every 30 minutes”, “weekdays at 8:00am”, "
                         + "“Mondays at 9am”. The server says so if it can't read one.")
                }

                Section {
                    TextField("What should it do?", text: $task, axis: .vertical)
                        .frame(minHeight: 90, alignment: .topLeading)
                } header: {
                    Text("Task")
                } footer: {
                    Text("Written the way you'd write it in chat. A watcher is just a task "
                         + "that compares against stored state and says nothing unless it changed.")
                }

                if let error {
                    Section {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(schedule == nil ? "New schedule" : "Edit schedule")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .disabled(!isValid)
                            .fontWeight(.semibold)
                    }
                }
            }
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            try await submit(
                name.trimmingCharacters(in: .whitespacesAndNewlines),
                spec.trimmingCharacters(in: .whitespacesAndNewlines),
                task.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            dismiss()
        } catch {
            // Stays on the form. A rejected spec is a typo to fix, not a reason to lose the
            // task text you just wrote.
            self.error = error.localizedDescription
        }
    }
}

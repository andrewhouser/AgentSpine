import SwiftUI

/// An error that says what to go and check, rather than a toast that vanishes.
struct ErrorNotice: View {
    let message: String
    var retry: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: Spine.Space.sm + 2) {
            Label("Can't load", systemImage: "exclamationmark.triangle.fill")
                .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .subheadline).weight(.semibold))
                .foregroundStyle(Spine.Palette.warn)
            Text(message)
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                .foregroundStyle(Spine.Palette.textDim)
                .fixedSize(horizontal: false, vertical: true)
            if let retry {
                Button("Try again", action: retry)
                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.semibold))
                    .buttonStyle(.bordered)
                    .tint(Spine.Palette.accent)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Spine.Space.md + 2)
        .background(Spine.Palette.warnSoft, in: RoundedRectangle(cornerRadius: Spine.Radius.md))
        .overlay(RoundedRectangle(cornerRadius: Spine.Radius.md).strokeBorder(Spine.Palette.warnLine, lineWidth: 0.5))
        .padding(.horizontal)
        .accessibilityElement(children: .contain)
    }
}

/// Said once, quietly, at the top of a thread that has touched private material: every reply in
/// it runs on the local model, and a new chat is the way back to the cloud tier. A standing fact
/// about the thread rather than an alert, so it uses the neutral inset colours, not the warning ones.
struct LocalOnlyNotice: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Label("Local only", systemImage: "lock.fill")
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.semibold))
                .foregroundStyle(Spine.Palette.text)
            Text("This thread has touched private material, so every reply runs on the local model. Start a new chat to use the cloud tier.")
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                .foregroundStyle(Spine.Palette.textFaint)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Spine.Space.md)
        .background(Spine.Palette.bgInset, in: RoundedRectangle(cornerRadius: Spine.Radius.md))
        .overlay(RoundedRectangle(cornerRadius: Spine.Radius.md).strokeBorder(Spine.Palette.border, lineWidth: 0.5))
        .padding(.horizontal)
        .accessibilityElement(children: .combine)
    }
}

/// This screen is the phone's saved copy, because the server cannot be reached. Always stated, with its age, so an old
/// answer is never read as the current one.
struct CachedNotice: View {
    let savedAt: Date
    var retry: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: Spine.Space.sm) {
            Label("Offline: saved copy", systemImage: "icloud.slash")
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.semibold))
                .foregroundStyle(Spine.Palette.warn)
            Text("From \(SpineDate.relative(ISO8601DateFormatter().string(from: savedAt))). Nothing here can be changed or answered until you reconnect.")
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                .foregroundStyle(Spine.Palette.textDim)
                .fixedSize(horizontal: false, vertical: true)
            if let retry {
                Button("Try again", action: retry)
                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.semibold))
                    .buttonStyle(.bordered)
                    .tint(Spine.Palette.accent)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Spine.Space.md)
        .background(Spine.Palette.warnSoft, in: RoundedRectangle(cornerRadius: Spine.Radius.md))
        .overlay(RoundedRectangle(cornerRadius: Spine.Radius.md).strokeBorder(Spine.Palette.warnLine, lineWidth: 0.5))
        .padding(.horizontal)
        .accessibilityElement(children: .contain)
    }
}

struct EmptyNotice: View {
    let symbol: String
    let title: String
    let detail: String

    @ScaledMetric(relativeTo: .largeTitle) private var glyph: CGFloat = 34

    var body: some View {
        VStack(spacing: Spine.Space.sm) {
            Image(systemName: symbol)
                .font(.system(size: glyph))
                .foregroundStyle(Spine.Palette.textFaint)
                .accessibilityHidden(true)
            Text(title)
                .font(SpineFont.display(Spine.TypeSize.title3, relativeTo: .headline))
                .foregroundStyle(Spine.Palette.text)
            Text(detail)
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                .foregroundStyle(Spine.Palette.textDim)
                .multilineTextAlignment(.center)
        }
        .padding(Spine.Space.xxl)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Today

/// What a tap on a Today row asks its screen to open. The iPhone pushes or switches tab and the
/// Mac changes its detail pane, so the rows only say what, never how.
enum TodayTarget: Hashable {
    case approval(TodayApproval)
    case thread(Int)
    case run(Int)
    case tasks
    case headsup
    case schedules
}

/// The sections of the Today screen, for a `List` (PLAN-open-work section 14, U1 and U2).
///
/// Here, in a file both targets compile, so the iPhone's `TodayView` and the Mac's `MacTodayView`
/// are the same rows in two frames. Every sentence is `TodayWords` (Models.swift), which
/// `test/today-screen.test.mjs` holds equal to the web's.
///
/// An approval's row has no Approve on it. A tap, or the swipe's Review, opens the whole
/// proposed action in the card a thread uses, and the button is there: a one-line preview with
/// Approve beside it would make approving a rubber stamp.
struct TodaySections: View {
    let store: TodayStore
    let open: (TodayTarget) -> Void
    /// Set where the client can speak; nil hides the button.
    var readAloud: ((String) -> Void)?
    var speaking = false

    private var now: Date { store.screen.flatMap { TodayWords.parse($0.now) } ?? Date() }

    var body: some View {
        if let screen = store.screen {
            Section {
                VStack(alignment: .leading, spacing: Spine.Space.sm) {
                    line(TodayWords.doneLine(screen.brief.done))
                    line(TodayWords.waitingLine(screen.brief.waiting))
                    Text(TodayWords.firstLine(screen.brief.first))
                        .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .subheadline).weight(.semibold))
                        .foregroundStyle(Spine.Palette.text)
                        .fixedSize(horizontal: false, vertical: true)
                    if let readAloud {
                        Button(speaking ? "Stop reading" : "Read aloud") { readAloud(TodayWords.briefText(screen.brief)) }
                            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).weight(.semibold))
                            .buttonStyle(.bordered)
                            .tint(Spine.Palette.accent)
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Brief")
            }

            if store.isEmpty {
                EmptyNotice(symbol: "sun.max", title: "Nothing needs you right now", detail: "Approvals, tasks due, heads-ups and what your scheduled jobs did will show here.")
                    .listRowBackground(Color.clear)
            }

            if !screen.approvals.isEmpty {
                Section("Waiting on you (\(screen.approvals.count))") {
                    ForEach(screen.approvals) { a in
                        row(title: a.summary, detail: expiry(a), urgent: a.expiringSoon, target: .approval(a)) {
                            action("Review", prominent: true) { open(.approval(a)) }
                            action("Later") { Task { await store.later("approval:\(a.id)") } }
                        }
                    }
                }
            }

            if !screen.mail.isEmpty {
                Section("Mail from people (\(screen.mail.count))") {
                    ForEach(screen.mail) { m in
                        HStack(alignment: .firstTextBaseline, spacing: Spine.Space.sm) {
                            label(title: m.sender, detail: m.subject, urgent: false)
                            Spacer(minLength: 0)
                            StatusChip(text: m.bucket, tone: m.bucket == "urgent" ? .warn : .neutral)
                        }
                    }
                }
            }

            if !screen.tasks.isEmpty {
                Section("Due (\(screen.tasks.count))") {
                    ForEach(screen.tasks) { t in
                        row(title: t.title, detail: taskDetail(t), urgent: t.overdue, target: .tasks) {
                            action("Done", prominent: true) { Task { await store.done(t) } }
                            action("Later") { Task { await store.later("task:\(t.id)") } }
                        }
                    }
                }
            }

            if !screen.headsups.isEmpty {
                Section("Heads-up (\(screen.headsups.count))") {
                    ForEach(screen.headsups) { h in
                        row(title: h.subject, detail: [h.kind, h.amount ?? ""].filter { !$0.isEmpty }.joined(separator: " · "), urgent: false, target: .headsup) {
                            action(h.yesLabel, prominent: true) { Task { await store.answer(h, "yes") } }
                            action("Tomorrow") { Task { await store.answer(h, "later") } }
                        }
                    }
                }
            }

            if !screen.threads.isEmpty {
                Section("Replies you have not read (\(screen.threads.count))") {
                    ForEach(screen.threads) { c in
                        row(title: c.title, detail: SpineDate.relative(c.updated), urgent: false, target: .thread(c.id)) {
                            action("Later") { Task { await store.later("thread:\(c.id)") } }
                        }
                    }
                }
            }

            if !screen.since.isEmpty {
                Section {
                    ForEach(screen.since) { s in
                        Button {
                            open(s.runId.map { .run($0) } ?? .schedules)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(alignment: .firstTextBaseline, spacing: Spine.Space.sm) {
                                    Text(s.title)
                                        .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .subheadline).weight(.semibold))
                                        .foregroundStyle(Spine.Palette.text)
                                    Text(TodayWords.sinceLabel(s.kind))
                                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).weight(.semibold))
                                        .foregroundStyle(s.kind == "ok" ? Spine.Palette.textDim : Spine.Palette.warn)
                                    Spacer(minLength: 0)
                                    Text(SpineDate.relative(s.at))
                                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                        .foregroundStyle(Spine.Palette.textFaint)
                                }
                                if !s.detail.isEmpty {
                                    Text(s.detail)
                                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                        .foregroundStyle(Spine.Palette.textDim)
                                        .lineLimit(3)
                                        .multilineTextAlignment(.leading)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                } header: {
                    HStack {
                        Text("Since you last looked (\(screen.since.count))")
                        Spacer()
                        Button("Seen") { Task { await store.seen() } }
                            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).weight(.semibold))
                            .accessibilityHint("Clears this list")
                    }
                }
            }

            if screen.later > 0 {
                Section {
                    HStack {
                        line(TodayWords.laterLine(screen.later))
                        Spacer(minLength: 0)
                        Button("Bring back") { Task { await store.bringBack() } }
                            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).weight(.semibold))
                            .buttonStyle(.bordered)
                    }
                }
            }
        }
    }

    private func line(_ text: String) -> some View {
        Text(text)
            .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .subheadline))
            .foregroundStyle(Spine.Palette.textDim)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func expiry(_ a: TodayApproval) -> String {
        let left = TodayWords.expiryLine(TodayWords.hoursUntil(a.expiresAt, now: now))
        return left.isEmpty ? a.tool : left
    }

    private func taskDetail(_ t: TodayTask) -> String {
        let base = TodayWords.taskLine(overdue: t.overdue, waitingOn: t.waitingOn)
        return t.overdue ? base : "\(base) · \(SpineDate.timeOfDay(t.due))"
    }

    private func label(title: String, detail: String, urgent: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .subheadline).weight(.semibold))
                .foregroundStyle(Spine.Palette.text)
                .multilineTextAlignment(.leading)
            if !detail.isEmpty {
                Text(detail)
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).weight(urgent ? .semibold : .regular))
                    .foregroundStyle(urgent ? Spine.Palette.warn : Spine.Palette.textDim)
                    .multilineTextAlignment(.leading)
            }
        }
    }

    /// One row. On the phone the actions are behind a swipe, which shows buttons and does nothing
    /// by itself; on the Mac, where there is room and no swipe, they sit at the end of the row.
    @ViewBuilder
    private func row<Actions: View>(title: String, detail: String, urgent: Bool, target: TodayTarget, @ViewBuilder actions: () -> Actions) -> some View {
        #if os(iOS)
        Button { open(target) } label: {
            label(title: title, detail: detail, urgent: urgent)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) { actions() }
        #else
        HStack(alignment: .center, spacing: Spine.Space.sm) {
            Button { open(target) } label: {
                label(title: title, detail: detail, urgent: urgent)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            actions()
        }
        #endif
    }

    @ViewBuilder
    private func action(_ title: String, prominent: Bool = false, _ run: @escaping () -> Void) -> some View {
        #if os(iOS)
        Button(title, action: run).tint(prominent ? Spine.Palette.accent : Spine.Palette.textDim)
        #else
        Button(title, action: run).controlSize(.small)
        #endif
    }
}

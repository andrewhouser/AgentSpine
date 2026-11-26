import AVFoundation
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
    case meetings
    /// A 1:1 on the line opens that person's page and its "For today" (section 15, R9).
    case person(Int)
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
            // The greeting (2026-11-26 redesign): the date, a serif line, then what happened and what needs you.
            Section {
                VStack(alignment: .leading, spacing: Spine.Space.sm) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(Self.eyebrow(screen.now))
                            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.semibold))
                            .tracking(2.4)
                            .foregroundStyle(Spine.Palette.textDim)
                        Spacer(minLength: 0)
                        if let readAloud {
                            Button(speaking ? "Stop reading" : "Read aloud") { readAloud(TodayWords.briefText(screen.brief)) }
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                .buttonStyle(.borderless)
                                .foregroundStyle(Spine.Palette.textDim)
                        }
                    }
                    Text("A little clarity for your day.")
                        .font(SpineFont.headline(Self.greetingSize))
                        .foregroundStyle(Spine.Palette.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.vertical, Spine.Space.xs)
                    Text(TodayWords.summaryLine(done: screen.brief.done, waiting: screen.brief.waiting))
                        .font(SpineFont.sans(Spine.TypeSize.title3, relativeTo: .title3).weight(.semibold))
                        .foregroundStyle(Spine.Palette.text)
                        .fixedSize(horizontal: false, vertical: true)
                    line(TodayWords.firstLine(screen.brief.first))
                }
                .padding(.vertical, Spine.Space.sm)
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Brief")
            }
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)

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
                        bandLabel("Behind")
                        Spacer()
                        Button("Seen") { Task { await store.seen() } }
                            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).weight(.semibold))
                            .accessibilityHint("Clears this list")
                    }
                }
            }
            if !store.undo.isEmpty {
                Section("Behind · just now") {
                    ForEach(store.undo) { u in
                        HStack(alignment: .firstTextBaseline, spacing: Spine.Space.sm) {
                            label(title: u.line, detail: SpineDate.timeOfDay(u.at), urgent: false)
                            Spacer(minLength: 0)
                            Button("Undo: \(u.undoLine)") { Task { await store.undoAction(u) } }
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).weight(.semibold))
                                .buttonStyle(.bordered)
                        }
                    }
                }
            }
            if screen.since.isEmpty {
                Section {
                    line("Nothing has run since you last looked.")
                }
            }

            // Now (section 15, R1): what needs you, in Today's order. The header stands alone as the band's label.
            Section {
                // A meeting recording now opens from its moment on the line (R4).
                if let live = screen.live {
                    Button { open(.meetings) } label: {
                        label(title: live.title, detail: MomentWords.liveLine(live.elapsedMs), urgent: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                if store.isEmpty {
                    line("Nothing needs you right now.")
                }
            } header: {
                HStack(spacing: Spine.Space.sm) {
                    bandLabel("Now")
                    let need = screen.approvals.count + screen.tasks.count + screen.headsups.count + screen.threads.count + screen.mail.count
                    if need > 0 {
                        Text("\(need) NEED YOU")
                            .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2).weight(.bold))
                            .tracking(1.2)
                            .foregroundStyle(Spine.Palette.attention)
                            .padding(.horizontal, Spine.Space.sm)
                            .padding(.vertical, 3)
                            .background(Spine.Palette.attentionSoft, in: Capsule())
                    }
                }
            }

            if !screen.approvals.isEmpty {
                Section {
                    // An approval is a card with the attention edge (2026-11-26 redesign); Approve is never on it.
                    ForEach(screen.approvals) { a in
                        HStack(spacing: Spine.Space.sm) {
                            row(title: a.summary, detail: expiry(a), urgent: a.expiringSoon, target: .approval(a)) {
                                action("Review", prominent: true) { open(.approval(a)) }
                                action("Later") { Task { await store.later("approval:\(a.id)") } }
                            }
                            Text("Needs approval")
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                .foregroundStyle(Spine.Palette.attention)
                                .padding(.horizontal, Spine.Space.sm)
                                .padding(.vertical, 3)
                                .background(Spine.Palette.attentionSoft, in: RoundedRectangle(cornerRadius: Spine.Radius.sm))
                                .overlay(RoundedRectangle(cornerRadius: Spine.Radius.sm).strokeBorder(Spine.Palette.attentionLine))
                        }
                        .listRowBackground(
                            HStack(spacing: 0) {
                                Rectangle().fill(Spine.Palette.attention).frame(width: 4)
                                Spine.Palette.attentionSoft
                            }
                        )
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

            // Ahead (section 15, R1): today's remaining schedule runs and calendar, as last read.
            Section {
                if store.ahead.isEmpty {
                    line(store.calendarAsOf == nil
                         ? "Nothing scheduled today. The calendar shows here once Heads-up or the check-in has read it."
                         : "Nothing else on the calendar or the schedules today.")
                }
                ForEach(store.ahead) { a in
                    Button {
                        if a.kind == "schedule" { open(.schedules) } else if let id = a.personId { open(.person(id)) }
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: Spine.Space.sm) {
                            Text(a.allDay ? "all day" : SpineDate.timeOfDay(a.at))
                                .font(SpineFont.mono(Spine.TypeSize.caption))
                                .foregroundStyle(Spine.Palette.textFaint)
                            label(title: a.title, detail: a.kind == "schedule" ? "runs: \(a.detail)" : a.prep.map { PeopleWords.prepLine(youOwe: $0.youOwe, theyOwe: $0.theyOwe) } ?? a.detail, urgent: false)
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(a.kind != "schedule" && a.personId == nil)
                }
            } header: {
                bandLabel("Ahead")
            } footer: {
                if let asOf = store.calendarAsOf { Text("Calendar as of \(SpineDate.relative(asOf))") }
            }
        }
    }

    /// "THURSDAY, NOVEMBER 26", from the screen's own clock.
    static func eyebrow(_ iso: String) -> String {
        guard let d = TodayWords.parse(iso) else { return "" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.dateFormat = "EEEE, MMMM d"
        return f.string(from: d).uppercased()
    }

    #if os(iOS)
    static let greetingSize: CGFloat = 34
    #else
    static let greetingSize: CGFloat = 44
    #endif

    /// A band's label on the line: BEHIND, NOW, AHEAD.
    private func bandLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.bold))
            .tracking(2.2)
            .foregroundStyle(Spine.Palette.text)
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

/// The ask bar (PLAN-open-work section 15, R1), shared by the iPhone and the Mac. It starts an
/// ordinary chat turn in a new conversation through `TodayStore.ask`. The scope is a project id
/// passed by the screen, never words added to the text; nothing on the screen is copied in.
struct AskBar: View {
    let placeholder: String
    var projectID: Int?
    var scopeLabel: String?
    /// Open the conversation the question started.
    let opened: (Int) -> Void

    @State private var text = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Spine.Space.xs) {
            HStack(spacing: Spine.Space.sm) {
                if let scopeLabel {
                    Text(scopeLabel)
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.accent)
                        .padding(.horizontal, Spine.Space.sm)
                        .padding(.vertical, 2)
                        .background(RoundedRectangle(cornerRadius: Spine.Radius.sm).fill(Spine.Palette.accentSoft))
                }
                TextField(placeholder, text: $text)
                    .textFieldStyle(.plain)
                    .disabled(busy)
                    .onSubmit { Task { await send() } }
                Button { Task { await send() } } label: {
                    Image(systemName: busy ? "ellipsis" : "arrow.right")
                        .font(.body.weight(.semibold))
                        .frame(width: 22, height: 22)
                }
                    .accessibilityLabel(busy ? "Asking" : "Ask")
                    .buttonStyle(.borderedProminent)
                    .tint(Spine.Palette.accent)
                    .disabled(busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(.leading, Spine.Space.md)
            .padding([.vertical, .trailing], Spine.Space.xs + 2)
            .background(RoundedRectangle(cornerRadius: Spine.Radius.lg).fill(Spine.Palette.bgElevated))
            .overlay(RoundedRectangle(cornerRadius: Spine.Radius.lg).stroke(Spine.Palette.borderStrong, lineWidth: 1))
            if let error {
                Text(error)
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                    .foregroundStyle(Spine.Palette.danger)
            }
        }
        .padding(.horizontal, Spine.Space.md)
        .padding(.vertical, Spine.Space.sm)
    }

    private func send() async {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let id = try await TodayStore.shared.ask(t, projectID: projectID)
            text = ""
            opened(id)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// The four facts of a decision card (PLAN-open-work section 15, R2), shared by the iPhone's
/// `ApprovalCard` and the Mac's `MacApprovalCard`. The sentences are the server's.
struct DecisionFactsView: View {
    let card: DecisionCard

    var body: some View {
        VStack(alignment: .leading, spacing: Spine.Space.sm) {
            fact("What leaves", card.facts.leavesLine, warn: false)
            fact("Where it ran", card.facts.whereLine, warn: false)
            fact("Can it be undone", card.facts.undoLine, warn: false)
            fact("Why it is asking", card.facts.whyLine, warn: card.facts.readOutside)
            if let leaves = card.facts.leaves, !leaves.isEmpty {
                DisclosureGroup("The text that leaves (\(leaves.count))") {
                    ForEach(Array(leaves.enumerated()), id: \.offset) { _, text in
                        Text(text)
                            .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(Spine.Space.sm)
                            .background(Spine.Palette.bgInset, in: RoundedRectangle(cornerRadius: Spine.Radius.sm))
                    }
                }
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                .tint(Spine.Palette.textDim)
            }
        }
        .padding(Spine.Space.sm + 2)
        .background(Spine.Palette.bgInset, in: RoundedRectangle(cornerRadius: Spine.Radius.sm + 2))
    }

    private func fact(_ title: String, _ text: String, warn: Bool) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title.uppercased())
                .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2).weight(.bold))
                .foregroundStyle(Spine.Palette.textFaint)
            Text(text)
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                .foregroundStyle(warn ? Spine.Palette.warn : Spine.Palette.text)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Approve, held rather than tapped (section 15, R2): it fires only after `DecisionWords.holdSeconds`
/// of pressing, and letting go early does nothing. No keyboard shortcut reaches it, on purpose: a
/// Return pressed out of habit must not approve. VoiceOver gets a named action, which is deliberate.
struct HoldToApprove: View {
    var busy = false
    let approve: () -> Void

    @State private var holding = false

    var body: some View {
        ZStack(alignment: .leading) {
            Capsule().fill(Color.attention)
            GeometryReader { geo in
                Capsule()
                    .fill(Color.white.opacity(0.28))
                    .frame(width: holding ? geo.size.width : 0)
                    .animation(holding ? .linear(duration: DecisionWords.holdSeconds) : .easeOut(duration: 0.15), value: holding)
            }
            Text(busy ? "Running…" : holding ? "Keep holding…" : "Hold to approve")
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.semibold))
                .foregroundStyle(Color.white)
                .frame(maxWidth: .infinity)
        }
        .frame(height: 34)
        .clipShape(Capsule())
        .contentShape(Capsule())
        .opacity(busy ? 0.6 : 1)
        .onLongPressGesture(minimumDuration: DecisionWords.holdSeconds, maximumDistance: 30) {
            if !busy { approve() }
        } onPressingChanged: { pressing in
            holding = pressing && !busy
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Hold to approve")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: "Approve") { if !busy { approve() } }
    }
}

/// "Always allow this", when the server offers it: the existing auto-approval proposal, applied
/// through `/api/proposals` by your tap. It applies from the next time; this card still needs an answer.
struct AlwaysAllowRow: View {
    let offer: DecisionCard.AlwaysAllow

    @State private var note: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Spine.Space.xs) {
            if let note {
                Text("\(note). It applies from the next time; this one still needs your answer.")
            } else {
                Text(DecisionWords.alwaysAllowLine(offer))
                Button("Always allow") {
                    Task {
                        do {
                            note = try await APIClient.shared.applyProposal(tool: offer.tool, target: offer.target).message
                        } catch {
                            note = error.localizedDescription
                        }
                    }
                }
                .buttonStyle(.bordered)
            }
        }
        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
        .foregroundStyle(Spine.Palette.textDim)
    }
}

/// Where a moment was said, with the way back to it (section 15, R4 and R5), shared by the iPhone and
/// the Mac: the transcript a minute either side, always, and playback from that second while the
/// recording is kept. The quote and transcript are someone's words: shown, never sent anywhere.
struct MomentLinkView: View {
    let moment: MomentRef

    @State private var lines: [AroundLine]?
    @State private var player: AVAudioPlayer?
    @State private var loadingAudio = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("\u{201C}\(moment.quote)\u{201D}")
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).italic())
                .foregroundStyle(Spine.Palette.textDim)
            HStack(spacing: Spine.Space.md) {
                Text([moment.meetingTitle, moment.speaker ?? "", MomentWords.atLine(moment.atMs)].filter { !$0.isEmpty }.joined(separator: " · "))
                    .foregroundStyle(Spine.Palette.textFaint)
                if moment.atMs != nil {
                    Button(lines == nil ? "Transcript around it" : "Hide transcript") { Task { await toggleTranscript() } }
                        .buttonStyle(.borderless)
                }
                if moment.audio, moment.atMs != nil {
                    Button(player?.isPlaying == true ? "Stop" : loadingAudio ? "Loading…" : "Play from here") { Task { await togglePlay() } }
                        .buttonStyle(.borderless)
                        .disabled(loadingAudio)
                }
            }
            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
            if let error {
                Text(error).font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.danger)
            }
            if let lines {
                VStack(alignment: .leading, spacing: 4) {
                    if lines.isEmpty { Text("No transcript is kept for this moment.").foregroundStyle(Spine.Palette.textDim) }
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
                        (Text("\(l.speaker ?? "?") ").bold().foregroundColor(Spine.Palette.textFaint) + Text(l.text))
                            .padding(.horizontal, 4)
                            .background(l.here ? Spine.Palette.accentSoft : Color.clear, in: RoundedRectangle(cornerRadius: 4))
                    }
                }
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                .padding(Spine.Space.sm)
                .background(Spine.Palette.bgInset, in: RoundedRectangle(cornerRadius: Spine.Radius.sm))
            }
        }
        .onDisappear { player?.stop() }
    }

    private func toggleTranscript() async {
        if lines != nil {
            lines = nil
            return
        }
        lines = (try? await APIClient.shared.meetingAround(moment.meetingId, atMs: moment.atMs ?? 0)) ?? []
    }

    private func togglePlay() async {
        if let player, player.isPlaying {
            player.stop()
            self.player = nil
            return
        }
        loadingAudio = true
        defer { loadingAudio = false }
        do {
            let file = try await APIClient.shared.meetingAudioFile(moment.meetingId)
            let p = try AVAudioPlayer(contentsOf: file)
            p.currentTime = Double(moment.atMs ?? 0) / 1000
            p.play()
            player = p
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// A turn's sources (section 15, R5): each claim with its moment, and the part nothing recorded.
struct TurnSourcesView: View {
    let sources: TurnSources

    var body: some View {
        VStack(alignment: .leading, spacing: Spine.Space.sm) {
            if !sources.notFound.isEmpty {
                Text(MomentWords.notFoundLine(sources.notFound))
                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                    .foregroundStyle(Spine.Palette.warn)
                    .padding(Spine.Space.sm)
                    .background(Spine.Palette.warnSoft, in: RoundedRectangle(cornerRadius: Spine.Radius.sm))
            }
            ForEach(sources.claims) { c in
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: Spine.Space.sm) {
                        Text(c.text).font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.semibold))
                        if !c.reviewed {
                            Text("lead, not reviewed")
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                .foregroundStyle(Spine.Palette.warn)
                        }
                    }
                    if let m = c.moment { MomentLinkView(moment: m) }
                }
            }
        }
        .padding(.leading, Spine.Space.md)
        .overlay(alignment: .leading) { Rectangle().fill(Spine.Palette.spine).frame(width: 3) }
    }
}

/// While a meeting records (section 15, R4), shared by the iPhone and the Mac: "Mark this moment",
/// which stores the server's own clock reading and nothing else, and what you still owe the people
/// named in the room, from reviewed claims. Code, not the coach; when nothing is open it says nothing.
struct LiveMomentsView: View {
    let meetingID: Int

    @State private var history: [HistoryLine] = []
    @State private var marks: [MeetingMark] = []
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Spine.Space.sm) {
            HStack(spacing: Spine.Space.md) {
                Button("Mark this moment") { Task { await mark() } }
                    .buttonStyle(.bordered)
                    .tint(Color.attention)
                if !marks.isEmpty {
                    Text("Marked at \(marks.map { MomentWords.atLine($0.atMs).replacingOccurrences(of: " into the meeting", with: "") }.joined(separator: ", "))")
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textFaint)
                }
            }
            if let error {
                Text(error).font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption)).foregroundStyle(Spine.Palette.danger)
            }
            ForEach(history) { h in
                VStack(alignment: .leading, spacing: 2) {
                    (Text("From your history ").bold() + Text(h.line + (h.late ? " (late)" : "")))
                        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                    if let m = h.moment { MomentLinkView(moment: m) }
                }
                .padding(Spine.Space.sm)
                .background(Spine.Palette.accentSoft, in: RoundedRectangle(cornerRadius: Spine.Radius.sm))
            }
        }
        .task(id: meetingID) { history = (try? await APIClient.shared.meetingHistory(meetingID)) ?? [] }
    }

    private func mark() async {
        do {
            let live = try await APIClient.shared.meetingLive()
            marks.append(try await APIClient.shared.addMeetingMark(meetingID, atMs: live.elapsedMs))
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

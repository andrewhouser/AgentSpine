import SwiftUI

/// Things the assistant noticed coming up: birthdays, anniversaries, bills, appointments.
///
/// The morning push summarises them; this is the full list, and where you answer. On a birthday or
/// an anniversary, "Yes" also sends the assistant off to find gift ideas or restaurants, and the
/// results appear under the item as cards you can scroll and tap. A card opens the real page in
/// the browser; its photo comes from the AgentSpine server, not the retailer, so this phone never
/// contacts a shop just because you looked at an idea.
struct HeadsupView: View {
    /// The Mac draws the dates in a column of their own beside this list (`MacHeadsupView`), so it
    /// turns them off here. The phone keeps them as sections.
    var showsDates = true

    @Environment(AppState.self) private var state
    @State private var items: [Headsup] = []
    @State private var dates = HeadsupDates(proposals: [], remembered: [])
    @State private var loaded = false
    @State private var loadError: String?
    @State private var actionError: String?
    @State private var checking = false
    @State private var note: String?

    /// Research is running in the background for something you said Yes to. Drives the polling.
    private var looking: Bool {
        items.contains {
            $0.researchesOnYes && $0.state == "accepted" && $0.cards.isEmpty && $0.researchError == nil
        }
    }

    var body: some View {
        List {
            if let loadError {
                ErrorNotice(message: loadError) { Task { await load() } }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }

            Section {
                Button {
                    Task { await checkNow() }
                } label: {
                    if checking {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("Checking…")
                        }
                    } else {
                        Label("Check now", systemImage: "arrow.clockwise")
                    }
                }
                .disabled(checking)
                if let note {
                    Text(note).font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).foregroundStyle(Spine.Palette.textDim)
                }
            }

            if items.isEmpty && loadError == nil {
                EmptyNotice(
                    symbol: "sparkles",
                    title: loaded ? "Nothing coming up" : "Loading…",
                    detail: "It looks at your calendar each morning. Tell it a date in a thread — \"Garrett's birthday is March 4\" — and it will remember."
                )
                .listRowBackground(Color.clear)
            }

            ForEach(items) { item in
                HeadsupRow(
                    item: item,
                    answer: { a in Task { await answer(item, a) } },
                    research: { Task { await research(item) } }
                )
            }

            if showsDates, !dates.proposals.isEmpty {
                Section("Dates it noticed") {
                    ForEach(dates.proposals) { proposal in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(proposal.title).font(SpineFont.sans(Spine.TypeSize.title3, relativeTo: .headline).weight(.semibold))
                            Text("You mentioned this in a thread. Nothing is remembered until you say so.")
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                .foregroundStyle(Spine.Palette.textDim)
                            HStack(spacing: 8) {
                                Button("Remember it") { Task { await decide(proposal, yes: true) } }
                                    .buttonStyle(.borderedProminent)
                                Button("Not a date") { Task { await decide(proposal, yes: false) } }
                                    .buttonStyle(.bordered)
                            }
                            .controlSize(.small)
                        }
                        .padding(.vertical, 4)
                    }
                }
            }

            if showsDates, !dates.remembered.isEmpty {
                Section("Dates it remembers") {
                    ForEach(dates.remembered) { date in
                        Text(date.title)
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) {
                                    Task { await forget(date) }
                                } label: {
                                    Label("Forget", systemImage: "trash")
                                }
                            }
                    }
                }
            }
        }
        .spineGroupedListStyle()
        .navigationTitle("Heads-up")
        .refreshable { await load() }
        .task { await load() }
        // Research finishes in the background after a Yes. Poll while any is still looking, and
        // stop after two minutes: an item accepted before research existed never gets cards, and
        // must not keep this screen polling for as long as it is open.
        .task(id: looking) {
            guard looking else { return }
            for _ in 0..<30 {
                try? await Task.sleep(for: .seconds(4))
                if Task.isCancelled { return }
                await load()
            }
        }
        .alert(
            "That didn't work",
            isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(actionError ?? "")
        }
    }

    // MARK: - Loading and acting

    private func load() async {
        do {
            items = try await APIClient.shared.headsups()
            // A failure to load the dates alone must not hide the list above it.
            if let latest = try? await APIClient.shared.headsupDates() { dates = latest }
            // Keep the tab's badge in step with what this screen just showed, without a second request.
            state.headsupWaiting = items.filter { $0.state == "offered" }.count + dates.proposals.count
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
        loaded = true
    }

    private func answer(_ item: Headsup, _ answer: String) async {
        do {
            try await APIClient.shared.answerHeadsup(item.id, answer: answer)
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func research(_ item: Headsup) async {
        do {
            _ = try await APIClient.shared.researchHeadsup(item.id)
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func checkNow() async {
        checking = true
        defer { checking = false }
        do {
            let r = try await APIClient.shared.runHeadsups()
            switch r.status {
            case "sent":
                note = "Sent \(r.offered) heads-up\(r.offered == 1 ? "" : "s")."
                    + (r.deferred > 0 ? " \(r.deferred) more waiting for tomorrow." : "")
            case "nothing":
                note = "Nothing new to mention right now."
            case "quiet":
                note = "It's quiet hours (9 pm to 7 am), so nothing was sent."
            case "disabled":
                note = "Heads-up is turned off on the server (HEADSUP_ENABLED)."
            default:
                note = "Couldn't check the calendar: \(r.errors.joined(separator: "; "))"
            }
            await load()
        } catch {
            note = error.localizedDescription
        }
    }

    private func decide(_ proposal: HeadsupProposal, yes: Bool) async {
        do {
            // notify: false. Answering a date proposal needs no push back to this phone.
            if yes {
                try await APIClient.shared.approve(proposal.confirmationID, notify: false)
            } else {
                try await APIClient.shared.reject(proposal.confirmationID, notify: false)
            }
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func forget(_ date: RememberedDate) async {
        do {
            try await APIClient.shared.deleteHeadsupDate(date.id)
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }
}

// MARK: - A row

private struct HeadsupRow: View {
    let item: Headsup
    let answer: (String) -> Void
    let research: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(item.subject).font(SpineFont.sans(Spine.TypeSize.title3, relativeTo: .headline).weight(.semibold))
                Spacer()
                Text(item.kindLabel)
                    .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2).weight(.semibold))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Spine.Palette.bgInset, in: Capsule())
                    .foregroundStyle(Spine.Palette.textDim)
            }
            Text(item.detailLine)
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                .foregroundStyle(Spine.Palette.textDim)

            if item.isOpen {
                HStack(spacing: 8) {
                    Button(item.yesLabel) { answer("yes") }
                        .buttonStyle(.borderedProminent)
                    Menu {
                        Button("Remind me tomorrow") { answer("later") }
                        Button("Don't suggest this", role: .destructive) { answer("never") }
                    } label: {
                        Text("Not now")
                    }
                    .buttonStyle(.bordered)
                }
                .controlSize(.small)
            }

            if let watch = item.watch {
                watchStatus(watch)
            }

            if item.researchesOnYes && (item.state == "accepted" || item.state == "researched") {
                results
            }
        }
        .padding(.vertical, 4)
    }

    /// Where a tracked flight or watched drive stands, in the server's own words, and what is
    /// blocking it when it cannot run yet (a missing key, a policy switch that is off).
    @ViewBuilder
    private func watchStatus(_ watch: HeadsupWatch) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Label(
                watch.active
                    ? (watch.kind == "flight" ? "Tracking this flight" : "Watching traffic")
                    : (watch.kind == "flight" ? "Flight tracking ended" : "Traffic watch ended"),
                systemImage: watch.kind == "flight" ? "airplane" : "car"
            )
            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.semibold))
            if let note = watch.note, !note.isEmpty {
                Text(note).font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).foregroundStyle(Spine.Palette.textDim)
            }
            if let polled = SpineDate.parse(watch.lastPolled) {
                Text("Last checked " + polled.formatted(date: .omitted, time: .shortened))
                    .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                    .foregroundStyle(Spine.Palette.textDim)
            }
        }
    }

    @ViewBuilder
    private var results: some View {
        if !item.cards.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 10) {
                    ForEach(item.cards) { card in
                        HeadsupCardTile(card: card)
                    }
                }
            }
            if let query = item.query {
                // Shown on purpose: what was asked is never a mystery.
                Text("Searched for: “\(query)”. No names are ever sent.")
                    .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                    .foregroundStyle(Spine.Palette.textDim)
            }
            if let note = item.researchNote, !note.isEmpty {
                Text("\(note).").font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2)).foregroundStyle(Spine.Palette.textDim)
            }
        } else if let error = item.researchError {
            Text("Couldn't finish looking: \(error)")
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                .foregroundStyle(Spine.Palette.warn)
        } else {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Looking…").font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote)).foregroundStyle(Spine.Palette.textDim)
            }
        }
        Button(item.cards.isEmpty ? "Try again" : "Look again", action: research)
            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
            .buttonStyle(.bordered)
            .controlSize(.small)
    }
}

// MARK: - A result card

private struct HeadsupCardTile: View {
    let card: HeadsupCard

    /// Only ever a web page. A card's URL is whatever the open web said it was, so anything that
    /// is not plain http(s) is shown but not made tappable.
    private var destination: URL? {
        guard let url = URL(string: card.url),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else { return nil }
        return url
    }

    var body: some View {
        let tile = VStack(alignment: .leading, spacing: 4) {
            HeadsupPhoto(path: card.imageURL)
            Text(card.title)
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.semibold))
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            if card.kind == "gift" {
                // Said out loud rather than hidden: a page that could not be read has no price.
                Text(card.priceText ?? "no price available")
                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                    .foregroundStyle(card.priceText == nil ? Color.secondary : Color.primary)
            }
            Text(card.host).font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2)).foregroundStyle(Spine.Palette.textDim)
            if let note = card.note, !note.isEmpty {
                Text(note)
                    .font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2))
                    .foregroundStyle(Spine.Palette.textDim)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
            }
        }
        .frame(width: 150, alignment: .leading)

        if let destination {
            Link(destination: destination) { tile }
                .buttonStyle(.plain)
        } else {
            tile
        }
    }
}

/// A product photo, fetched through the server with the token in a header (never in a URL) and
/// kept in memory only. `AsyncImage` cannot set a header, which is the same reason
/// `AttachmentImage` exists.
private struct HeadsupPhoto: View {
    let path: String?

    @State private var image: PlatformImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(platformImage: image)
                    .resizable()
                    .scaledToFill()
            } else if path == nil || failed {
                ZStack {
                    Spine.Palette.bgInset
                    Text("no photo").font(SpineFont.sans(Spine.TypeSize.caption - 1, relativeTo: .caption2)).foregroundStyle(Spine.Palette.textFaint)
                }
            } else {
                ZStack {
                    Spine.Palette.bgInset
                    ProgressView().controlSize(.small)
                }
            }
        }
        .frame(width: 150, height: 112)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .task(id: path) { await load() }
    }

    private func load() async {
        guard let path else { return }
        if let cached = HeadsupImageCache.shared.image(for: path) {
            image = cached
            return
        }
        do {
            let data = try await APIClient.shared.headsupImageData(path: path)
            guard let decoded = PlatformImage(data: data) else {
                failed = true
                return
            }
            HeadsupImageCache.shared.store(decoded, for: path)
            image = decoded
        } catch {
            failed = true
        }
    }
}

/// In memory only, like `AttachmentCache`: `NSCache` drops these under pressure and keeps nothing
/// on disk. A path names one set of bytes for as long as the server keeps them.
@MainActor
final class HeadsupImageCache {
    static let shared = HeadsupImageCache()

    private let cache = NSCache<NSString, PlatformImage>()

    private init() {
        cache.countLimit = 80
    }

    func image(for path: String) -> PlatformImage? { cache.object(forKey: path as NSString) }

    func store(_ image: PlatformImage, for path: String) {
        cache.setObject(image, forKey: path as NSString)
    }
}

// MARK: - Display helpers

extension HeadsupProposal {
    /// "Garrett's Birthday, every March 4". The server's card text, minus its shouting prefix.
    var title: String {
        let first = summary.split(separator: "\n").first.map(String.init) ?? who
        return first.replacingOccurrences(of: "REMEMBER A DATE: ", with: "")
    }
}

extension Headsup {
    /// Still needs an answer.
    var isOpen: Bool { state == "offered" || state == "snoozed" }

    /// "Yes" on these goes and looks things up. The server decides, so every client agrees.
    var researchesOnYes: Bool { yesAction == "research" }

    var kindLabel: String {
        switch kind {
        case "anniversary": return "Anniversary"
        case "appointment": return "Appointment"
        case "bill": return "Bill"
        case "birthday": return "Birthday"
        case "flight": return "Flight"
        case "recurring": return "Recurring"
        default: return kind.capitalized
        }
    }

    /// The due moment. A bare "2026-11-28" is a calendar day, so it is built from its parts in the
    /// current calendar rather than parsed as a UTC instant, which would land a day early west of
    /// Greenwich. Anything longer is a full timestamp.
    var dueDate: Date? {
        let parts = dueAt.split(separator: "-").compactMap { Int($0) }
        if dueAt.count == 10, parts.count == 3 {
            return Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
        }
        return SpineDate.parse(dueAt)
    }

    /// "in 10 days, Sat, Nov 28".
    var whenText: String {
        guard let due = dueDate else { return dueAt }
        let calendar = Calendar.current
        let days = calendar.dateComponents(
            [.day],
            from: calendar.startOfDay(for: Date()),
            to: calendar.startOfDay(for: due)
        ).day ?? 0
        let day = due.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
        switch days {
        case 0: return "today, \(day)"
        case 1: return "tomorrow, \(day)"
        case 2...: return "in \(days) days, \(day)"
        default: return day
        }
    }

    var detailLine: String {
        var parts = [whenText]
        if let amount { parts.append(amount) }
        if let location, !location.isEmpty { parts.append(location) }
        if state == "snoozed", let until = SpineDate.parse(snoozeUntil) {
            parts.append("snoozed until " + until.formatted(date: .abbreviated, time: .shortened))
        }
        return parts.joined(separator: " · ")
    }
}

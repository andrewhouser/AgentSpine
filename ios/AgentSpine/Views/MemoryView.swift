import SwiftUI

/// What the assistant has learned, with a way to make it forget.
///
/// Deleting is the human-facing correction for a wrong or stale fact; the agent has no tool
/// that reaches it, so this list is where a bad memory gets retracted.
struct MemoryView: View {
    @State private var memories: [Memory] = []
    @State private var query = ""
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        List {
            if let error {
                ErrorNotice(message: error) { Task { await load() } }
            }
            ForEach(memories) { memory in
                VStack(alignment: .leading, spacing: 4) {
                    Text(memory.text)
                    HStack(spacing: 6) {
                        Text(memory.kind)
                        Text("·")
                        Text(SpineDate.relative(memory.ts))
                    }
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                    .foregroundStyle(Spine.Palette.textDim)
                    provenance(memory)
                }
                .swipeActions {
                    Button("Forget", role: .destructive) { Task { await forget(memory) } }
                }
            }
            if memories.isEmpty && !loading && error == nil {
                Text(query.isEmpty ? "Nothing remembered yet." : "No matches.")
                    .foregroundStyle(Spine.Palette.textDim)
            }
        }
        .navigationTitle("Memory")
        .searchable(text: $query)
        .onSubmit(of: .search) { Task { await load() } }
        .onChange(of: query) { _, new in
            if new.isEmpty { Task { await load() } }
        }
        .refreshable { await load() }
        .task { await load() }
        .overlay { if loading && memories.isEmpty { ProgressView() } }
    }

    /// Where this memory came from, with a way into the run that wrote it. A pruned run says so rather
    /// than offering a link that would 404; a memory from before provenance says that and nothing more.
    @ViewBuilder
    private func provenance(_ memory: Memory) -> some View {
        HStack(spacing: 6) {
            Text(memory.originLabel)
            if let runId = memory.runId {
                Text("·")
                if memory.runPruned == true {
                    Text("run pruned")
                } else {
                    NavigationLink("run #\(runId)") { RunDetailView(runID: runId) }
                        .buttonStyle(.plain)
                        .underline()
                }
            }
        }
        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
        .foregroundStyle(Spine.Palette.textDim)
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            memories = try await APIClient.shared.memories(query: query)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func forget(_ memory: Memory) async {
        do {
            try await APIClient.shared.forgetMemory(memory.id)
            memories.removeAll { $0.id == memory.id }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// What was sent to you in the last week, with Useful and Skip this kind on each, and a box for
/// something you wish you had been told. An answer writes memory only: it never edits profile.md,
/// goals.md, policy.json or a schedule, so "skip" quietens a topic without switching anything off.
struct WeeklyReviewView: View {
    @State private var review: OutboxReview?
    @State private var wish = ""
    @State private var message: String?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        List {
            if let error {
                ErrorNotice(message: error) { Task { await load() } }
            }
            if let review {
                Section {
                    ForEach(review.tally, id: \.self) { t in
                        Text(tallyLine(t))
                            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                            .foregroundStyle(Spine.Palette.textDim)
                    }
                } header: {
                    Text("Last \(review.days) days")
                } footer: {
                    Text("Skipping saves a note that I should not interrupt you about that kind again unless it is "
                         + "clearly more important. It does not switch anything off, and you can forget the note "
                         + "under Memory. Looking at this list marks it as seen.")
                }

                if let quiet = review.quiet, !quiet.isEmpty {
                    Section {
                        ForEach(quiet, id: \.self) { q in
                            Text("\(q.topic): skipped \(q.skipped) of \(q.counted) (\(Int((q.rate * 100).rounded()))%)")
                                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                                .foregroundStyle(Spine.Palette.textDim)
                        }
                    } header: {
                        Text("Kinds you mostly skip")
                    } footer: {
                        Text("Over the last 90 days. Nothing is switched off. For a scheduled job at the top of the list, "
                             + "a proposal to turn it off waits in Approvals.")
                    }
                }

                Section("Something I wish I'd been told") {
                    TextField("For example: a snow day notice", text: $wish, axis: .vertical)
                    Button("Save") { Task { await sendWish() } }
                        .disabled(busy || wish.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                if let message {
                    Section { Text(message).foregroundStyle(Spine.Palette.textDim) }
                }

                Section {
                    if review.items.isEmpty {
                        Text("Nothing to review yet.").foregroundStyle(Spine.Palette.textDim)
                    }
                    ForEach(review.items) { item in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(item.title)
                            Text("\(item.sourceLabel) · \(SpineDate.relative(item.created)) · \(item.outcomeLabel)")
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                .foregroundStyle(Spine.Palette.textDim)
                            if !item.body.isEmpty {
                                Text(item.body)
                                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                                    .foregroundStyle(Spine.Palette.textDim)
                            }
                            HStack {
                                verdictButton("Useful", item: item, answer: "useful")
                                verdictButton("Skip this kind", item: item, answer: "skip")
                            }
                        }
                        .padding(.vertical, 2)
                    }
                } header: {
                    Text("Messages")
                } footer: {
                    Text("Useful also clears an earlier Skip for that kind of message.")
                }
            } else if error == nil {
                ProgressView()
            }
        }
        .navigationTitle("Weekly review")
        .spineInlineTitle()
        .refreshable { await load() }
        .task { await load() }
    }

    private func verdictButton(_ label: String, item: ReviewItem, answer: String) -> some View {
        Button(label) { Task { await send(item, answer: answer) } }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .fontWeight(item.feedback == answer ? .bold : .regular)
            .disabled(busy)
    }

    private func tallyLine(_ t: ReviewTally) -> String {
        var parts = ["\(t.sent) sent"]
        if t.held > 0 { parts.append("\(t.held) held") }
        if t.deduped > 0 { parts.append("\(t.deduped) repeats removed") }
        if t.opened > 0 { parts.append("\(t.opened) opened") }
        if t.dismissed > 0 { parts.append("\(t.dismissed) dismissed") }
        if t.ignored > 0 { parts.append("\(t.ignored) ignored") }
        let name = ReviewItem(body: "", created: "", feedback: nil, id: 0, kind: "", outcome: "", source: t.source,
                              title: "", topic: "").sourceLabel
        return "\(name): " + parts.joined(separator: ", ")
    }

    /// "the daily digest: morning" reads better in a sentence as "the daily digest (morning)".
    private static func sayTopic(_ topic: String) -> String {
        guard let range = topic.range(of: ": ", options: .backwards) else { return topic }
        return "\(topic[..<range.lowerBound]) (\(topic[range.upperBound...]))"
    }

    private func send(_ item: ReviewItem, answer: String) async {
        busy = true
        defer { busy = false }
        do {
            let result = try await APIClient.shared.answerOutbox(item.id, answer: answer)
            if answer == "useful" {
                message = "Noted."
            } else {
                message = result.remembered
                    ? "Noted. I will be quieter about \(Self.sayTopic(result.topic))."
                    : "Already noted: I am quieter about \(Self.sayTopic(result.topic))."
            }
            error = nil
            if let index = review?.items.firstIndex(where: { $0.id == item.id }) {
                review?.items[index].feedback = answer
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func sendWish() async {
        busy = true
        defer { busy = false }
        do {
            let result = try await APIClient.shared.sendOutboxWish(wish)
            message = result.remembered ? "Noted. I will bring up things like that." : "I already had that one."
            wish = ""
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func load() async {
        do {
            review = try await APIClient.shared.outboxReview()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Cloud tokens today and this month against the caps in `.env`.
///
/// Read-only on purpose: a control that raised the limit would put the fence within reach of
/// the loop it exists to stop, and the numbers are config, not preferences.
struct CloudUsageView: View {
    @State private var usage: CloudUsage?
    @State private var error: String?

    var body: some View {
        List {
            if let error {
                ErrorNotice(message: error) { Task { await load() } }
            }
            if let usage {
                Section {
                    row("Today", used: usage.used.day, cap: usage.caps.day)
                    row("This month", used: usage.used.month, cap: usage.caps.month)
                    HStack {
                        Text("Per run")
                        Spacer()
                        Text(usage.caps.run > 0 ? "cap \(count(usage.caps.run))" : "no cap")
                            .foregroundStyle(Spine.Palette.textDim)
                    }
                } header: {
                    Text(usage.enabled ? "Cloud tokens (\(usage.model ?? "cloud"))" : "Cloud tokens")
                } footer: {
                    Text(usage.enabled
                         ? "Local model calls are free and never counted. A call over a cap is refused before anything is sent."
                         : "The cloud is off, because no OPENAI_API_KEY is set, so nothing is being spent.")
                }

                if !usage.recent.isEmpty {
                    Section("Recent refusals") {
                        ForEach(usage.recent, id: \.self) { refusal in
                            VStack(alignment: .leading, spacing: 2) {
                                Text("The \(refusal.cap) cap: \(count(refusal.used)) of \(count(refusal.limit)) tokens")
                                Text(SpineDate.relative(refusal.ts) + (refusal.runId.map { " · run #\($0)" } ?? ""))
                                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                                    .foregroundStyle(Spine.Palette.textDim)
                            }
                        }
                    }
                }

                Section {
                } footer: {
                    Text("Set CLOUD_TOKENS_PER_DAY, CLOUD_TOKENS_PER_MONTH and CLOUD_TOKENS_PER_RUN in .env on the "
                         + "AgentSpine host, then restart it. 0 or unset means no cap.")
                }
            } else if error == nil {
                ProgressView()
            }
        }
        .navigationTitle("Cloud usage")
        .spineInlineTitle()
        .refreshable { await load() }
        .task { await load() }
    }

    private func row(_ label: String, used: Int, cap: Int) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text(cap > 0 ? "\(count(used)) of \(count(cap))" : "\(count(used)), no cap")
                .foregroundStyle(cap > 0 && used >= cap ? Spine.Palette.warn : Spine.Palette.textDim)
                .monospacedDigit()
        }
    }

    private func count(_ n: Int) -> String {
        n.formatted(.number.grouping(.automatic))
    }

    private func load() async {
        do {
            usage = try await APIClient.shared.cloudUsage()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// `policy.json`, read-only. Editing it stays a text-editor job on the Mac on purpose.
struct PolicyView: View {
    @State private var text: String?
    @State private var error: String?

    var body: some View {
        ScrollView {
            if let error {
                ErrorNotice(message: error) { Task { await load() } }.padding()
            } else if let text {
                Text(text)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            } else {
                ProgressView().padding()
            }
        }
        .navigationTitle("Policy")
        .spineInlineTitle()
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        do {
            text = try await APIClient.shared.policyText()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

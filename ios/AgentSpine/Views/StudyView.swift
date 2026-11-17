import SwiftUI

/// Study: review the cards that are due, and see where each topic stands.
///
/// The same screen as the web's Study page, for the same reason. Spaced repetition lives on a
/// short daily review, and as a chat that was a round trip per card. The daily "N cards due"
/// push opens this screen.
///
/// You type, or dictate with the keyboard's microphone, your recall before the answer is
/// shown. A self-rated "I knew that" is the feeling rereading produces, so the server grades
/// what you actually wrote, exactly as `study_cards review` does in chat. Interview, map,
/// quiz, explain-back and sparring stay in a thread, where the back and forth is the point.
struct StudyView: View {
    @State private var overview: StudyOverview?
    @State private var loadError: String?

    var body: some View {
        List {
            if let loadError {
                ErrorNotice(message: loadError) { Task { await load() } }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }

            if let overview {
                Section {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("\(overview.due)").font(.largeTitle.weight(.semibold)).monospacedDigit()
                        Text(overview.due == 1 ? "card due" : "cards due").foregroundStyle(.secondary)
                    }
                    if overview.due > 0 {
                        NavigationLink {
                            StudyReviewView(topicID: nil, title: "All topics")
                        } label: {
                            Label("Review all", systemImage: "rectangle.stack")
                        }
                        ForEach(overview.topics.filter { $0.due > 0 }) { topic in
                            NavigationLink {
                                StudyReviewView(topicID: topic.id, title: topic.name)
                            } label: {
                                LabeledContent(topic.name, value: "\(topic.due)")
                            }
                        }
                    } else {
                        Text("Nothing due. Cards come back when their interval runs out.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Review")
                }

                Section {
                    if overview.topics.isEmpty {
                        Text("No topics yet. In a thread, try \u{201C}I'm learning statistics, interview me\u{201D}.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(overview.topics) { topic in
                        StudyTopicRow(topic: topic)
                    }
                } header: {
                    Text("Topics")
                }
            } else if loadError == nil {
                EmptyNotice(symbol: "brain.head.profile", title: "Loading…", detail: "")
                    .listRowBackground(Color.clear)
            }
        }
        .navigationTitle("Study")
        .refreshable { await load() }
        // Reload on every appearance, so coming back from a review shows the new due counts.
        .onAppear { Task { await load() } }
    }

    private func load() async {
        do {
            overview = try await APIClient.shared.studyOverview()
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }
}

private struct StudyTopicRow: View {
    let topic: StudyTopic

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(topic.name).font(.headline)
                if topic.projectID != nil {
                    Image(systemName: "lock.fill")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Linked to a project, graded locally")
                }
                Spacer()
                LevelPips(level: topic.level)
            }
            if let goal = topic.goal, !goal.isEmpty {
                Text(goal).font(.subheadline).foregroundStyle(.secondary)
            }
            Text("\(topic.cards) card\(topic.cards == 1 ? "" : "s") · \(topic.due) due · 14 days: \(topic.produced) produced, \(topic.consumed) read")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
            if !topic.map.isEmpty {
                DisclosureGroup("Curriculum · \(topic.map.count) modules") {
                    ForEach(Array(topic.map.enumerated()), id: \.offset) { index, module in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(index + 1). \(module.name)").font(.subheadline.weight(.medium))
                            if !module.summary.isEmpty {
                                Text(module.summary).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
                .font(.subheadline)
            }
            Text(suggestion)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    /// The next thing to ask for in a thread, in the order the study tools build on each other.
    private var suggestion: String {
        if topic.goal == nil { return "Next: \u{201C}interview me about this\u{201D} sets the goal and level." }
        if topic.map.isEmpty { return "Next: \u{201C}map this out\u{201D} builds the curriculum." }
        if topic.level == nil { return "Next: \u{201C}quiz me\u{201D} finds your level." }
        if topic.consumed > topic.produced { return "You've read more than you've produced. Try \u{201C}quiz me\u{201D}." }
        return "Keep going: \u{201C}quiz me\u{201D}, explain a module back, or spar on it."
    }
}

private struct LevelPips: View {
    let level: Int?

    var body: some View {
        HStack(spacing: 3) {
            ForEach(1...5, id: \.self) { n in
                RoundedRectangle(cornerRadius: 2)
                    .fill(level.map { n <= $0 } ?? false ? Color.accentColor : Color.secondary.opacity(0.2))
                    .frame(width: 12, height: 7)
            }
        }
        .accessibilityElement()
        .accessibilityLabel(level.map { "Level \($0) of 5" } ?? "Level unknown")
    }
}

/// One review sitting: question, your recall, the grade and the answer, next.
struct StudyReviewView: View {
    let topicID: Int?
    let title: String

    @State private var queue: [StudyDueCard] = []
    @State private var loaded = false
    @State private var answer = ""
    @State private var result: StudyReview?
    @State private var busy = false
    @State private var error: String?
    @State private var reviewed = 0
    @FocusState private var answerFocused: Bool

    private var card: StudyDueCard? { queue.first }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let card {
                    HStack {
                        Text(card.topicName)
                            .font(.caption)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(Color.accentColor.opacity(0.12), in: Capsule())
                            .foregroundStyle(Color.accentColor)
                        Spacer()
                        Text("\(reviewed) done · \(queue.count - (result == nil ? 0 : 1)) left")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }

                    Text(card.front)
                        .font(.title3)
                        .fixedSize(horizontal: false, vertical: true)

                    if let result {
                        resultView(result)
                    } else {
                        recallView
                    }
                } else if loaded {
                    EmptyNotice(
                        symbol: "checkmark.seal",
                        title: reviewed > 0 ? "Done" : "Nothing due",
                        detail: reviewed > 0
                            ? "\(reviewed) card\(reviewed == 1 ? "" : "s") reviewed. Missed ones come back in about 10 minutes."
                            : "Cards come back when their interval runs out."
                    )
                    .frame(maxWidth: .infinity)
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }

                if let error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            .padding()
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
    }

    private var recallView: some View {
        VStack(alignment: .leading, spacing: 12) {
            TextField("Answer from memory", text: $answer, axis: .vertical)
                .lineLimit(3...8)
                .textFieldStyle(.roundedBorder)
                .focused($answerFocused)
                .disabled(busy)
            HStack {
                Button {
                    Task { await submit(answer) }
                } label: {
                    if busy { ProgressView() } else { Text("Check") }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy || answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Button("I don't know") { Task { await submit("") } }
                    .buttonStyle(.bordered)
                    .disabled(busy)
            }
        }
        .onAppear { answerFocused = true }
    }

    private func resultView(_ r: StudyReview) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            let recalled = r.score >= 0.7
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(Int((r.score * 100).rounded()))%").font(.headline).monospacedDigit()
                Text(r.feedback).font(.subheadline)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background((recalled ? Color.green : Color.orange).opacity(0.12), in: RoundedRectangle(cornerRadius: 8))

            Text("ANSWER").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            Text(r.back).fixedSize(horizontal: false, vertical: true)
            Text(nextText(r)).font(.footnote).foregroundStyle(.secondary)

            Button("Next card") { Task { await next() } }
                .buttonStyle(.borderedProminent)
        }
    }

    private func nextText(_ r: StudyReview) -> String {
        let days = Int(r.interval.rounded())
        return days > 0 ? "Next review in \(days) day\(days == 1 ? "" : "s")." : "It comes back in about 10 minutes."
    }

    private func reload() async {
        do {
            queue = try await APIClient.shared.studyDue(topicID: topicID)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func submit(_ given: String) async {
        guard let card, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            result = try await APIClient.shared.reviewStudyCard(card.id, answer: given)
            reviewed += 1
            error = nil
        } catch {
            // A 503 leaves the card untouched; the typed answer stays so Check can be tapped again.
            self.error = error.localizedDescription
        }
    }

    private func next() async {
        result = nil
        answer = ""
        queue.removeFirst()
        // At the end of the list, ask again: a card missed earlier is due again after 10 minutes.
        if queue.isEmpty { await reload() }
        answerFocused = true
    }
}

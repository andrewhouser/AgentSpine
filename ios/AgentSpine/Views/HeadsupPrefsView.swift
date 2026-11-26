import SwiftUI

/// Settings → Heads-up: which kinds you want, how many per morning, and when it must stay quiet.
///
/// Every change goes to the server, which validates it and answers with the state it kept. A bad
/// value is refused with a sentence and nothing is applied, so what this screen shows is always a
/// state somebody chose. The 30 minute floor on watches is shown but is not a control: it exists to
/// stop a mistake becoming a polling storm against a free-tier API, and a setting you can lower
/// defeats it.
struct HeadsupPrefsView: View {
    @State private var prefs: HeadsupPrefs?
    @State private var loadError: String?
    @State private var actionError: String?

    private struct Kind: Identifiable {
        let id: String
        let label: String
    }

    private static let kinds: [Kind] = [
        Kind(id: "birthday", label: "Birthdays"),
        Kind(id: "anniversary", label: "Anniversaries"),
        Kind(id: "bill", label: "Bills"),
        Kind(id: "appointment", label: "Appointments"),
        Kind(id: "booking", label: "Bookings (calls and gigs)"),
        Kind(id: "flight", label: "Flights"),
        Kind(id: "recurring", label: "Recurring events"),
    ]

    private static func learningLine(_ label: String, _ l: HeadsupKindLearning, on: Bool) -> String {
        var line = "\(label): offered \(l.offered), you acted on \(l.yes)"
        if on && l.tier == "quiet" { line += ". Reminders are off for this kind." }
        if on && l.tier == "off" { line += ". Reminders are off, and it has asked whether to turn the kind off." }
        return line
    }

    private func hourLabel(_ hour: Int) -> String {
        Calendar.current.date(from: DateComponents(hour: hour))?
            .formatted(date: .omitted, time: .shortened) ?? "\(hour):00"
    }

    var body: some View {
        Form {
            if let loadError {
                Section {
                    ErrorNotice(message: loadError) { Task { await load() } }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
            }

            if let prefs {
                Section {
                    ForEach(Self.kinds) { kind in
                        Toggle(kind.label, isOn: Binding(
                            get: { prefs.kinds[kind.id] ?? true },
                            set: { on in Task { await change(["kinds": [kind.id: on]]) } }
                        ))
                    }
                } header: {
                    Text("What to bring up")
                } footer: {
                    Text("Turning a kind off stops new offers of it. Anything you are already tracking keeps going.")
                }

                if let learning = prefs.learning, !learning.isEmpty {
                    Section {
                        ForEach(Self.kinds.filter { k in learning.contains { $0.kind == k.id } }) { kind in
                            if let l = learning.first(where: { $0.kind == kind.id }) {
                                Text(Self.learningLine(kind.label, l, on: prefs.kinds[kind.id] ?? true))
                                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                                    .foregroundStyle(Spine.Palette.textDim)
                            }
                        }
                    } header: {
                        Text("Last 90 days")
                    } footer: {
                        Text("A kind you pass on most of the time gets only its first mention, and past that it asks "
                             + "whether to turn the kind off. It never turns one off on its own.")
                    }
                }

                if let lead = prefs.leadDays {
                    Section {
                        ForEach(Self.kinds.filter { lead[$0.id] != nil }) { kind in
                            LeadDaysRow(
                                label: kind.label,
                                days: lead[kind.id] ?? [],
                                defaults: prefs.leadDaysDefault?[kind.id] ?? lead[kind.id] ?? []
                            ) { value in
                                Task { await change(["leadDays": [kind.id: value ?? NSNull()]]) }
                            }
                            // A new list means a new row, so the text field starts from what the server kept.
                            .id("\(kind.id):\((lead[kind.id] ?? []).map(String.init).joined(separator: ","))")
                        }
                    } header: {
                        Text("When to mention each kind")
                    } footer: {
                        Text("Days before the date, largest first, up to three, each 0 to 45. The first is the first "
                             + "mention and the rest are reminders. A change applies to what has not been mentioned "
                             + "yet and never repeats a mention you already got.")
                    }
                }

                Section("Each morning") {
                    Stepper(
                        "At most \(prefs.dailyCap) per morning",
                        value: Binding(
                            get: { prefs.dailyCap },
                            set: { value in Task { await change(["dailyCap": value]) } }
                        ),
                        in: 1...10
                    )
                }

                Section {
                    Picker("From", selection: Binding(
                        get: { prefs.quietStartHour },
                        set: { hour in Task { await change(["quietStartHour": hour]) } }
                    )) {
                        ForEach(0..<24, id: \.self) { Text(hourLabel($0)).tag($0) }
                    }
                    Picker("Until", selection: Binding(
                        get: { prefs.quietEndHour },
                        set: { hour in Task { await change(["quietEndHour": hour]) } }
                    )) {
                        ForEach(0..<24, id: \.self) { Text(hourLabel($0)).tag($0) }
                    }
                } header: {
                    Text("Quiet hours")
                } footer: {
                    Text("Only a cancellation, or a long delay on a flight leaving within hours, may break through. "
                         + "Pick the same hour twice for no quiet hours.")
                }

                Section {
                    Text("Watched flights and drives are checked at most every \(prefs.floorMinutes) minutes. "
                         + "That is not adjustable.")
                        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                        .foregroundStyle(Spine.Palette.textDim)
                    if let reason = prefs.unavailable.flights {
                        Label("Flight tracking is not set up: \(reason)", systemImage: "airplane")
                            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                            .foregroundStyle(Spine.Palette.textDim)
                    }
                    if let reason = prefs.unavailable.drive {
                        Label("Drive watching is not set up: \(reason)", systemImage: "car")
                            .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                            .foregroundStyle(Spine.Palette.textDim)
                    }
                } header: {
                    Text("Watches")
                }
            }
        }
        // The Mac's default form is two columns: section text took the wide column and ran past the
        // pane's edge, and footers cut off. Grouped matches the phone and wraps inside the pane.
        .formStyle(.grouped)
        .navigationTitle("Heads-up")
        .spineInlineTitle()
        .task { await load() }
        .alert(
            "That didn't work",
            isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(actionError ?? "")
        }
    }

    private func load() async {
        do {
            prefs = try await APIClient.shared.headsupPrefs()
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func change(_ patch: [String: Any]) async {
        do {
            prefs = try await APIClient.shared.setHeadsupPrefs(patch)
        } catch {
            actionError = error.localizedDescription
            // Reload, so the control snaps back to what the server actually holds.
            await load()
        }
    }
}

/// One kind's lead times as text ("5, 1, 0"), sent when you press return. The server validates the
/// whole list; a refused one reloads the screen so the field goes back to what is kept.
private struct LeadDaysRow: View {
    let label: String
    let days: [Int]
    let defaults: [Int]
    let save: (Any?) -> Void
    @State private var text: String

    init(label: String, days: [Int], defaults: [Int], save: @escaping (Any?) -> Void) {
        self.label = label
        self.days = days
        self.defaults = defaults
        self.save = save
        _text = State(initialValue: days.map(String.init).joined(separator: ", "))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label)
                Spacer()
                // A prompt, not a title: macOS draws a title as a visible label, so every row read
                // "5, 1, 0" beside its real value. The width stops the field filling a wide pane.
                TextField(label, text: $text, prompt: Text("5, 1, 0"))
                    .labelsHidden()
                    .frame(maxWidth: 120)
                    .multilineTextAlignment(.trailing)
                    .submitLabel(.done)
                    .onSubmit {
                        let parsed = text.split(whereSeparator: { $0 == "," || $0 == " " }).compactMap { Int($0) }
                        let pieces = text.split(whereSeparator: { $0 == "," || $0 == " " })
                        // A piece that is not a whole number goes to the server as-is and is refused there.
                        save(parsed.count == pieces.count ? parsed : pieces.map(String.init))
                    }
            }
            if days != defaults {
                Button("Use \(defaults.map(String.init).joined(separator: ", "))") { save(nil) }
                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
            }
        }
    }
}

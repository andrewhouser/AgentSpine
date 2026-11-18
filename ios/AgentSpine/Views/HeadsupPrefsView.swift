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
        Kind(id: "flight", label: "Flights"),
        Kind(id: "recurring", label: "Recurring events"),
    ]

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
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if let reason = prefs.unavailable.flights {
                        Label("Flight tracking is not set up: \(reason)", systemImage: "airplane")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    if let reason = prefs.unavailable.drive {
                        Label("Drive watching is not set up: \(reason)", systemImage: "car")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Watches")
                }
            }
        }
        .navigationTitle("Heads-up")
        .navigationBarTitleDisplayMode(.inline)
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

import SwiftUI

/// Settings → What it may do: Off, Watch or On per feature (PLAN-open-work section 15, R3).
/// Shared by the iPhone and the Mac. The server decides which levels a dial may take (`.env` is a
/// feature's ceiling and a guard's floor, src/modes.ts), so a level it would refuse is shown but
/// disabled. The words come from `DialWords`, which the web says the same way.
struct DialsView: View {
    @State private var dials: [Dial] = []
    @State private var error: String?
    @State private var open: String?
    @State private var rows: [WouldHave] = []

    var body: some View {
        List {
            if let error {
                ErrorNotice(message: error) { Task { await load() } }
            }
            Section {
                ForEach(dials) { dial in
                    VStack(alignment: .leading, spacing: Spine.Space.sm) {
                        header(dial)
                        levels(dial)
                        if let agreement = dial.agreement {
                            Button {
                                Task { await toggle(dial.feature) }
                            } label: {
                                Text(DialWords.agreementLine(agreement) + (open == dial.feature ? " Hide" : " What it would have done"))
                                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                            }
                            .buttonStyle(.borderless)
                        }
                        if open == dial.feature { wouldHaveList }
                    }
                    .padding(.vertical, Spine.Space.xs)
                }
            } header: {
                Text("What it may do")
            } footer: {
                Text("Off does nothing. Watch runs and records what it would have done, and does not do it. "
                     + "On does it. A feature can go as high as .env allows; a guard can only be tightened here.")
            }
        }
        .navigationTitle("What it may do")
        .spineInlineTitle()
        .refreshable { await load() }
        .task { await load() }
    }

    private func header(_ dial: Dial) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: Spine.Space.sm) {
                Text(dial.label).fontWeight(.semibold)
                if dial.guard_ {
                    Text("guard")
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textDim)
                }
            }
            Text(dial.hint)
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                .foregroundStyle(Spine.Palette.textDim)
            Text(DialWords.envLine(allowed: dial.allowed, env: dial.env, envName: dial.envName, guard: dial.guard_))
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                .foregroundStyle(Spine.Palette.textFaint)
        }
    }

    private func levels(_ dial: Dial) -> some View {
        HStack(spacing: Spine.Space.xs) {
            ForEach(dial.levels, id: \.self) { level in
                let on = dial.mode == level
                Button {
                    Task { await move(dial, to: level) }
                } label: {
                    Text(DialWords.levelLabel(level))
                        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote).weight(.semibold))
                        .padding(.horizontal, Spine.Space.md)
                        .padding(.vertical, Spine.Space.xs)
                        .foregroundStyle(on ? Spine.Palette.bg : Spine.Palette.textDim)
                        .background(Capsule().fill(on ? Spine.Palette.text : Color.clear))
                        .overlay(Capsule().stroke(Spine.Palette.border, lineWidth: 1))
                }
                .buttonStyle(.borderless)
                .disabled(on || !dial.allowed.contains(level))
                .opacity(dial.allowed.contains(level) ? 1 : 0.35)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
    }

    @ViewBuilder private var wouldHaveList: some View {
        if rows.isEmpty {
            Text("Nothing recorded yet.")
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                .foregroundStyle(Spine.Palette.textDim)
        }
        ForEach(rows) { row in
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(row.action): \(row.subject)")
                        .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                    Text(SpineDate.relative(row.at) + (row.detail.isEmpty ? "" : " · \(row.detail)"))
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textFaint)
                }
                Spacer()
                Button {
                    Task { await mark(row) }
                } label: {
                    Image(systemName: row.thumbsDown ? "hand.thumbsdown.fill" : "hand.thumbsdown")
                        .foregroundStyle(row.thumbsDown ? Spine.Palette.danger : Spine.Palette.textFaint)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(row.thumbsDown ? "Take back: this was right" : "This was wrong")
            }
        }
    }

    private func load() async {
        do {
            dials = try await APIClient.shared.dials()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func move(_ dial: Dial, to level: String) async {
        do {
            _ = try await APIClient.shared.setDial(dial.feature, mode: level)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func toggle(_ feature: String) async {
        if open == feature {
            open = nil
            return
        }
        open = feature
        rows = []
        rows = (try? await APIClient.shared.wouldHave(feature)) ?? []
    }

    private func mark(_ row: WouldHave) async {
        do {
            _ = try await APIClient.shared.thumbsDown(row.feature, key: row.key, down: !row.thumbsDown)
            if let i = rows.firstIndex(where: { $0.key == row.key }) { rows[i].thumbsDown.toggle() }
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

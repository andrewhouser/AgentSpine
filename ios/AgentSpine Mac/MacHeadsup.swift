import SwiftUI

/// Heads-up as the UI Directions draw it on the Mac: the list of what is coming up, and beside it
/// a Dates column ("It noticed" / "It remembers"). The list is the phone's own screen with its
/// date sections switched off, so nothing about how a heads-up is answered is duplicated.
struct MacHeadsupView: View {
    var body: some View {
        HSplitView {
            HeadsupView(showsDates: false, timeline: true)
                .frame(minWidth: 420, maxWidth: .infinity)
            MacHeadsupDates()
                .frame(minWidth: 240, idealWidth: 280, maxWidth: 340)
        }
    }
}

/// Dates it noticed in something you said (waiting on a yes) and dates it remembers.
/// Answering goes through the ordinary confirmations routes, as on the phone.
struct MacHeadsupDates: View {
    @Environment(AppState.self) private var state

    @State private var dates = HeadsupDates(proposals: [], remembered: [])
    @State private var loaded = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spine.Space.lg) {
                Text("Dates")
                    .font(SpineFont.display(Spine.TypeSize.title3, relativeTo: .title3))
                    .foregroundStyle(Spine.Palette.text)

                if let error {
                    Text(error)
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.danger)
                }

                if !dates.proposals.isEmpty {
                    sectionLabel("It noticed")
                    ForEach(dates.proposals) { proposal in proposalCard(proposal) }
                }

                sectionLabel("It remembers")
                if dates.remembered.isEmpty {
                    Text(loaded ? "Nothing yet. Tell it a birthday or anniversary in a thread." : "")
                        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                        .foregroundStyle(Spine.Palette.textDim)
                } else {
                    VStack(spacing: 0) {
                        ForEach(dates.remembered) { date in rememberedRow(date) }
                    }
                    .background(Spine.Palette.bgElevated, in: RoundedRectangle(cornerRadius: Spine.Radius.md))
                    .overlay(RoundedRectangle(cornerRadius: Spine.Radius.md).strokeBorder(Spine.Palette.border))
                }
            }
            .padding(Spine.Space.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Spine.Palette.bgSidebar)
        .task { await load() }
        // A date proposal is a confirmation, so the waiting count moving is the cue to look again.
        .onChange(of: state.headsupWaiting) { _, _ in Task { await load() } }
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).weight(.semibold))
            .tracking(0.6)
            .foregroundStyle(Spine.Palette.textFaint)
    }

    private func proposalCard(_ proposal: HeadsupProposal) -> some View {
        VStack(alignment: .leading, spacing: Spine.Space.sm) {
            Text(proposal.title)
                .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body).weight(.semibold))
                .foregroundStyle(Spine.Palette.text)
            Text("You mentioned this in a thread. Nothing is remembered until you say so.")
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                .foregroundStyle(Spine.Palette.textDim)
            HStack(spacing: Spine.Space.sm) {
                Button("Remember it") { Task { await decide(proposal, yes: true) } }
                    .buttonStyle(.borderedProminent)
                Button("Not a date") { Task { await decide(proposal, yes: false) } }
                    .buttonStyle(.bordered)
            }
            .controlSize(.small)
        }
        .padding(Spine.Space.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Spine.Palette.bgElevated, in: RoundedRectangle(cornerRadius: Spine.Radius.md))
        .overlay(RoundedRectangle(cornerRadius: Spine.Radius.md).strokeBorder(Spine.Palette.border))
    }

    private func rememberedRow(_ date: RememberedDate) -> some View {
        HStack {
            Text(date.title)
                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                .foregroundStyle(Spine.Palette.text)
                .lineLimit(1)
            Spacer(minLength: Spine.Space.sm)
            Text(shortDate(month: date.month, day: date.day))
                .font(SpineFont.mono(Spine.TypeSize.caption, relativeTo: .caption))
                .foregroundStyle(Spine.Palette.textFaint)
        }
        .padding(.horizontal, Spine.Space.md)
        .padding(.vertical, Spine.Space.sm)
        .contentShape(Rectangle())
        .contextMenu {
            Button("Forget this date", role: .destructive) { Task { await forget(date) } }
        }
    }

    private func shortDate(month: Int, day: Int) -> String {
        let months = Calendar.current.shortMonthSymbols
        guard (1...months.count).contains(month) else { return "\(month)/\(day)" }
        return "\(months[month - 1]) \(day)"
    }

    private func load() async {
        do {
            dates = try await APIClient.shared.headsupDates()
            error = nil
        } catch {
            // Keep what is on screen: a failed refresh is not a reason to empty the column.
            self.error = loaded ? nil : error.localizedDescription
        }
        loaded = true
    }

    private func decide(_ proposal: HeadsupProposal, yes: Bool) async {
        do {
            // notify: false. Answering a date proposal needs no push back to this Mac.
            if yes {
                try await APIClient.shared.approve(proposal.confirmationID, notify: false)
            } else {
                try await APIClient.shared.reject(proposal.confirmationID, notify: false)
            }
            await load()
            await state.refreshHeadsups()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func forget(_ date: RememberedDate) async {
        do {
            try await APIClient.shared.deleteHeadsupDate(date.id)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

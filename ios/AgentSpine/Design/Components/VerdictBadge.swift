import SwiftUI

/// The broker's verdict, as a badge. The same five states the dashboard shows, in the same
/// words, because the point is that this decision is legible wherever you see the call.
///
/// Colour is never the only signal: each state has its own symbol and word, so the badge reads
/// the same in greyscale and under VoiceOver.
struct VerdictBadge: View {
    let status: BrokerStatus?

    var body: some View {
        let style = Self.style(for: status)
        Label(style.label, systemImage: style.symbol)
            .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(style.color.opacity(0.14), in: Capsule())
            .foregroundStyle(style.color)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Broker verdict: \(style.label)")
    }

    /// The colour a verdict gets. Public to the module so the spine's nodes use the same mapping.
    static func color(for status: BrokerStatus?) -> Color { style(for: status).color }

    private static func style(for status: BrokerStatus?) -> (label: String, symbol: String, color: Color) {
        switch status {
        case .executed: return ("ran", "checkmark.circle.fill", Spine.Verdict.executed)
        case .denied: return ("denied", "hand.raised.fill", Spine.Verdict.denied)
        case .queued: return ("needs approval", "clock.badge.questionmark", Spine.Verdict.queued)
        case .dryRun: return ("dry run", "eyeglasses", Spine.Verdict.dryRun)
        case .error: return ("error", "exclamationmark.triangle.fill", Spine.Verdict.error)
        case nil: return ("running", "circle.dotted", Spine.Palette.textFaint)
        }
    }
}

/// A neutral or semantic label that is not a broker verdict: schedule state, "tracking",
/// "researched". Kept apart from `VerdictBadge` so a verdict colour always means a verdict.
struct StatusChip: View {
    enum Tone { case neutral, accent, ok, warn, danger }

    let text: String
    var symbol: String?
    var tone: Tone = .neutral

    var body: some View {
        HStack(spacing: 4) {
            if let symbol { Image(systemName: symbol).imageScale(.small) }
            Text(text)
        }
        .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).weight(.medium))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .foregroundStyle(foreground)
        .background(soft, in: Capsule())
        .overlay(Capsule().strokeBorder(line, lineWidth: 0.5))
        .accessibilityElement(children: .combine)
    }

    private var foreground: Color {
        switch tone {
        case .neutral: return Spine.Palette.textDim
        case .accent: return Spine.Palette.accent
        case .ok: return Spine.Palette.ok
        case .warn: return Spine.Palette.warn
        case .danger: return Spine.Palette.danger
        }
    }

    private var soft: Color {
        switch tone {
        case .neutral: return Spine.Palette.bgInset
        case .accent: return Spine.Palette.accentSoft
        case .ok: return Spine.Palette.okSoft
        case .warn: return Spine.Palette.warnSoft
        case .danger: return Spine.Palette.dangerSoft
        }
    }

    private var line: Color {
        switch tone {
        case .neutral: return Spine.Palette.border
        case .accent: return Spine.Palette.accentLine
        case .ok: return Spine.Palette.okLine
        case .warn: return Spine.Palette.warnLine
        case .danger: return Spine.Palette.dangerLine
        }
    }
}

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

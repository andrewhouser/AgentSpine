import SwiftUI

/// Every shared component in one place, for Xcode previews: light, dark and large type.
/// This is the deliverable that lets the look be judged before screens adopt it.
struct ComponentGallery: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spine.Space.xl) {
                section("Verdict badge") {
                    FlowLayout {
                        VerdictBadge(status: .executed)
                        VerdictBadge(status: .denied)
                        VerdictBadge(status: .queued)
                        VerdictBadge(status: .dryRun)
                        VerdictBadge(status: .error)
                        VerdictBadge(status: nil)
                    }
                }
                section("Status chip") {
                    FlowLayout {
                        StatusChip(text: "paused")
                        StatusChip(text: "researched", symbol: "checkmark", tone: .accent)
                        StatusChip(text: "tracking", symbol: "eye", tone: .ok)
                        StatusChip(text: "due soon", tone: .warn)
                        StatusChip(text: "failed", tone: .danger)
                    }
                }
                section("Thread bubble") {
                    ThreadBubble(text: "What is on my calendar Friday, and is the flight still on time?")
                }
                section("Spine") {
                    VStack(spacing: 0) {
                        SpineRow(node: .plain, isFirst: true) {
                            Text("Check the flight for Friday").font(SpineFont.sans())
                        }
                        SpineRow(node: .verdict(.executed)) {
                            Text("calendar_list").font(SpineFont.mono())
                        }
                        SpineRow(node: .verdict(.denied)) {
                            Text("shell_exec").font(SpineFont.mono())
                        }
                        SpineRow(node: .waiting, isLast: true) {
                            ApprovalPrompt(
                                tool: "draft_email",
                                summary: "Create a draft to the landlord about the lease renewal.",
                                detail: "{\n  \"to\": \"landlord@example.com\"\n}",
                                onApprove: {}, onReject: {}
                            )
                        }
                    }
                }
                section("Tool call row") {
                    ToolCallRow(tool: "web_fetch", target: "example.com", args: "{\"url\":\"https://example.com\"}", output: "200 OK", status: .executed)
                }
                section("Markdown") {
                    MarkdownText("## Plan\nThe **flight** is `UA 212`, see [status](https://example.com).\n\n- one\n- two\n\n> a quote\n\n```\nlet x = 1\n```")
                }
                section("Notices") {
                    ErrorNotice(message: "The server did not answer. Check that the dashboard is running.") {}
                    EmptyNotice(symbol: "tray", title: "Nothing here", detail: "New items show up as the agent works.")
                }
            }
            .padding()
        }
        .background(Spine.Palette.bg)
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: Spine.Space.sm) {
            Text(title.uppercased())
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).weight(.semibold))
                .foregroundStyle(Spine.Palette.textFaint)
            content()
        }
    }
}

/// Wraps its children onto new lines, so badges do not clip at large type sizes.
struct FlowLayout: Layout {
    var spacing: CGFloat = Spine.Space.sm

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(width: proposal.width ?? .infinity, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrange(width: bounds.width, subviews: subviews)
        for (index, origin) in result.origins.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y), proposal: .unspecified)
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> (size: CGSize, origins: [CGPoint]) {
        var origins: [CGPoint] = []
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, maxX: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            origins.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            maxX = max(maxX, x - spacing)
        }
        return (CGSize(width: maxX, height: y + rowHeight), origins)
    }
}

#Preview("Light") { ComponentGallery().preferredColorScheme(.light) }
#Preview("Dark") { ComponentGallery().preferredColorScheme(.dark) }
#Preview("Large type") { ComponentGallery().dynamicTypeSize(.accessibility2) }

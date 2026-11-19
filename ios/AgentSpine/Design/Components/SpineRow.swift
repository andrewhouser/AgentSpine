import SwiftUI

/// The motif: content hangs on a thin vertical line, and each item has a node on it.
///
/// A node is solid for a decided verdict, and hollow amber for a question waiting on the user.
/// Hollow versus solid is a shape difference, not only a colour one. The line is drawn per row
/// and joins its neighbours because rows have no spacing between them; use `isFirst` / `isLast`
/// to start and end the line at the node.
struct SpineRow<Content: View>: View {
    enum Node {
        /// `recovered`: an error the turn got past, drawn muted instead of in the failure colour.
        case verdict(BrokerStatus?, recovered: Bool = false)
        case waiting
        case plain
    }

    let node: Node
    var isFirst = false
    var isLast = false
    @ViewBuilder var content: () -> Content

    @ScaledMetric(relativeTo: .body) private var nodeSize: CGFloat = 10
    @ScaledMetric(relativeTo: .body) private var gutter: CGFloat = 24

    var body: some View {
        HStack(alignment: .top, spacing: Spine.Space.sm) {
            ZStack(alignment: .top) {
                // The line runs the full row height, starts at the node on the first row and
                // stops at it on the last, so a list of rows reads as one continuous spine.
                Rectangle()
                    .fill(Spine.Palette.spine)
                    .frame(width: 1.5)
                    .frame(maxHeight: isLast ? nodeSize + 6 : .infinity, alignment: .top)
                    .padding(.top, isFirst ? nodeSize : 0)
                nodeShape
                    .frame(width: nodeSize, height: nodeSize)
                    .padding(.top, 6)
            }
            .frame(width: gutter)
            .accessibilityHidden(true)

            content()
                .padding(.vertical, Spine.Space.sm)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var nodeShape: some View {
        switch node {
        case .verdict(let status, let recovered):
            Circle().fill(VerdictBadge.color(for: status, recovered: recovered))
        case .waiting:
            Circle()
                .strokeBorder(Spine.Palette.attention, lineWidth: 2)
                .background(Circle().fill(Spine.Palette.bg))
        case .plain:
            Circle().fill(Spine.Palette.spine)
        }
    }
}

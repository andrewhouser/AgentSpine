import AppKit

/// The app's mark (the stack of rounded bars from the icon) as a menu bar template image: black
/// on clear, and macOS tints it for the light or dark bar and the highlighted state. A template
/// is also what keeps it legible under Increase Contrast.
///
/// Built in code rather than shipped as a file so it has no resolution to go wrong, and
/// `nonisolated` so the drawing closure, which AppKit runs when it draws, is not tied to the main
/// actor.
nonisolated enum SpineMenuMark {
    static let image: NSImage = {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: false) { _ in
            // Widths follow the icon: short, medium, long, longest, long, medium, short.
            let widths: [CGFloat] = [8, 11, 13, 16, 13, 11, 8]
            let bar: CGFloat = 1.6, gap: CGFloat = 0.9
            let total = CGFloat(widths.count) * bar + CGFloat(widths.count - 1) * gap
            var y = (size.height - total) / 2
            NSColor.black.setFill()
            for w in widths {
                let rect = NSRect(x: (size.width - w) / 2, y: y, width: w, height: bar)
                NSBezierPath(roundedRect: rect, xRadius: bar / 2, yRadius: bar / 2).fill()
                y += bar + gap
            }
            return true
        }
        image.isTemplate = true
        return image
    }()
}

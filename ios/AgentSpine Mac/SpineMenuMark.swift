import AppKit

/// The app's spine mark (a thin spine, a bulb at each end and a hollow ring in the middle, from
/// "AgentSpine UI Directions") as a menu bar template image: black on clear, and macOS tints it
/// for the light or dark bar and the highlighted state. A template is also what keeps it legible
/// under Increase Contrast. The proportions are the ones in `ios/tools/make-icons.swift`.
///
/// Built in code rather than shipped as a file so it has no resolution to go wrong, and
/// `nonisolated` so the drawing closure, which AppKit runs when it draws, is not tied to the main
/// actor.
nonisolated enum SpineMenuMark {
    static let image: NSImage = {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: false) { _ in
            let height: CGFloat = 17, k = height / 132
            let cx = size.width / 2, top = (size.height - height) / 2

            func circle(_ cy: CGFloat, _ r: CGFloat) -> NSBezierPath {
                NSBezierPath(ovalIn: NSRect(x: cx - r * k, y: top + cy * k - r * k, width: 2 * r * k, height: 2 * r * k))
            }
            func capsule(_ y0: CGFloat, _ y1: CGFloat, _ w: CGFloat) -> NSBezierPath {
                let r = NSRect(x: cx - w / 2 * k, y: top + y0 * k, width: w * k, height: (y1 - y0) * k)
                return NSBezierPath(roundedRect: r, xRadius: w / 2 * k, yRadius: w / 2 * k)
            }

            NSColor.black.setFill()
            for shape in [capsule(0, 40, 12), circle(35, 20), circle(67, 25), circle(97, 20), capsule(92, 132, 12)] {
                shape.fill()
            }
            // The open node. Cleared rather than drawn in a second colour so it stays a hole
            // whatever the bar is tinted.
            NSGraphicsContext.current?.compositingOperation = .clear
            circle(67, 12).fill()
            return true
        }
        image.isTemplate = true
        return image
    }()
}

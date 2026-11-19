import SwiftUI

/// The spine mark (spine, a bulb at each end, a hollow ring between them) as a filled shape, so
/// it takes whatever colour the view gives it. Proportions are the mock's, 132 tall by 50 wide;
/// `SpineMenuMark.swift` and `ios/tools/make-icons.swift` draw the same shape.
struct SpineMark: Shape {
    func path(in rect: CGRect) -> Path {
        let k = min(rect.height / 132, rect.width / 50)
        let cx = rect.midX, top = rect.midY - 66 * k
        func circle(_ cy: CGFloat, _ r: CGFloat) -> Path {
            Path(ellipseIn: CGRect(x: cx - r * k, y: top + (cy - r) * k, width: 2 * r * k, height: 2 * r * k))
        }
        func capsule(_ y0: CGFloat, _ y1: CGFloat, _ w: CGFloat) -> Path {
            Path(roundedRect: CGRect(x: cx - w / 2 * k, y: top + y0 * k, width: w * k, height: (y1 - y0) * k),
                 cornerRadius: w / 2 * k)
        }
        var p = Path()
        for part in [capsule(0, 40, 12), circle(35, 20), circle(67, 25), circle(97, 20), capsule(92, 132, 12)] {
            p.addPath(part)
        }
        return p.subtracting(circle(67, 12))
    }
}

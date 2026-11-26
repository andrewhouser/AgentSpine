// Regenerates the app icons from the spine mark in "AgentSpine UI Directions".
//
//   swiftc -o /tmp/make-icons ios/tools/make-icons.swift && /tmp/make-icons ios web/public
//
// Writes the iPhone icon, the Mac icon set and the web client's favicon and touch icon. The mark is five stacked shapes: a thin spine
// with a bulb near each end and a hollow ring (the open node, the one waiting on you) in the
// middle. Units below are the mock's, 132 tall and 50 wide; keep SpineMenuMark.swift in step.
import AppKit

/// A colour from a token hex value, tagged sRGB so it is the same colour the app draws.
func srgb(_ hex: Int, _ a: CGFloat = 1) -> CGColor {
    CGColor(colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
            components: [CGFloat(hex >> 16 & 255) / 255, CGFloat(hex >> 8 & 255) / 255, CGFloat(hex & 255) / 255, a])!
}

func spinePath(height: CGFloat, centerX: CGFloat, top: CGFloat) -> CGPath {
    let k = height / 132
    func y(_ u: CGFloat) -> CGFloat { top + u * k }
    let p = CGMutablePath()
    func circle(_ cy: CGFloat, _ r: CGFloat, clockwise: Bool = false) {
        p.addPath(CGPath(ellipseIn: CGRect(x: centerX - r * k, y: y(cy) - r * k, width: 2 * r * k, height: 2 * r * k),
                         transform: nil))
    }
    func capsule(_ y0: CGFloat, _ y1: CGFloat, _ w: CGFloat) {
        let r = CGRect(x: centerX - w / 2 * k, y: y(y0), width: w * k, height: (y1 - y0) * k)
        p.addPath(CGPath(roundedRect: r, cornerWidth: w / 2 * k, cornerHeight: w / 2 * k, transform: nil))
    }
    capsule(0, 40, 12)          // top nub into the upper bulb
    circle(35, 20)              // upper bulb
    circle(67, 25)              // ring, hole cut below
    circle(97, 20)              // lower bulb
    capsule(92, 132, 12)        // lower bulb into the bottom nub
    return p
}

func fillMark(_ c: CGContext, height: CGFloat, centerX: CGFloat, top: CGFloat) {
    let k = height / 132
    // The hole is cut by filling the outer shapes, then the hole with the destination-out
    // blend on a separate layer, so it works over any background.
    c.beginTransparencyLayer(auxiliaryInfo: nil)
    c.addPath(spinePath(height: height, centerX: centerX, top: top)); c.fillPath()
    c.setBlendMode(.clear)
    c.fillEllipse(in: CGRect(x: centerX - 12 * k, y: top + 55 * k, width: 24 * k, height: 24 * k))
    c.setBlendMode(.normal)
    c.endTransparencyLayer()
}

func master() -> CGImage {
    let n = 1024
    let c = CGContext(data: nil, width: n, height: n, bitsPerComponent: 8, bytesPerRow: 0,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    // Background: the rail's green, sidebarActive at the top to bgSidebar at the bottom (design/tokens.json,
    // light), so the icon is the menu rail the apps open on (2026-11-26 redesign).
    let g = CGGradient(colorsSpace: space, colors: [
        srgb(0x2F5A45),   // sidebarActive, top
        srgb(0x1F4232)] as CFArray, locations: [0, 1])!
    c.drawLinearGradient(g, start: CGPoint(x: 0, y: CGFloat(n)), end: CGPoint(x: 0, y: 0), options: [])
    let h: CGFloat = 600, top = (CGFloat(n) - h) / 2
    // A soft shadow, then the mark in the rail's text colour, as the sidebar draws it.
    c.saveGState()
    c.setShadow(offset: CGSize(width: 0, height: -8), blur: 40, color: srgb(0x0B1812, 0.45))
    c.setFillColor(srgb(0xF3EFE6))
    fillMark(c, height: h, centerX: CGFloat(n) / 2, top: top)
    c.restoreGState()
    return c.makeImage()!
}

func write(_ img: CGImage, _ path: String) {
    let rep = NSBitmapImageRep(cgImage: img)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

/// Opaque copy for the iPhone icon, which must have no alpha.
func opaque(_ img: CGImage) -> CGImage {
    let n = img.width
    let c = CGContext(data: nil, width: n, height: n, bitsPerComponent: 8, bytesPerRow: 0,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    c.draw(img, in: CGRect(x: 0, y: 0, width: n, height: n))
    return c.makeImage()!
}

/// The standard macOS shape: art in an 824 px rounded square on a 1024 canvas, soft shadow.
func macIcon(_ art: CGImage, size: Int) -> CGImage {
    let c = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    c.interpolationQuality = .high
    let s = CGFloat(size) / 1024
    let rect = CGRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s)
    let shape = CGPath(roundedRect: rect, cornerWidth: 185 * s, cornerHeight: 185 * s, transform: nil)
    c.saveGState()
    c.setShadow(offset: CGSize(width: 0, height: -10 * s), blur: 24 * s, color: srgb(0x000000, 0.5))
    c.addPath(shape); c.setFillColor(srgb(0x000000)); c.fillPath()
    c.restoreGState()
    c.saveGState()
    c.addPath(shape); c.clip()
    c.draw(art, in: rect)
    c.restoreGState()
    return c.makeImage()!
}

let root = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "ios"
let art = master()
write(opaque(art), "\(root)/AgentSpine/Assets.xcassets/AppIcon.appiconset/AppIcon.png")
for n in [16, 32, 64, 128, 256, 512, 1024] {
    write(macIcon(art, size: n), "\(root)/AgentSpine Mac/Assets.xcassets/AppIcon.appiconset/icon_\(n).png")
}

/// The web client's favicon and touch icon: the square art, scaled.
func scaled(_ img: CGImage, to n: Int) -> CGImage {
    let c = CGContext(data: nil, width: n, height: n, bitsPerComponent: 8, bytesPerRow: 0,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    c.interpolationQuality = .high
    c.draw(img, in: CGRect(x: 0, y: 0, width: n, height: n))
    return c.makeImage()!
}
let web = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "web/public"
try? FileManager.default.createDirectory(atPath: web, withIntermediateDirectories: true)
write(scaled(art, to: 32), "\(web)/favicon.png")
write(scaled(art, to: 180), "\(web)/apple-touch-icon.png")
print("wrote icons")

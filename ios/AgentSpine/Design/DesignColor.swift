import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// A colour as the token file states it: 24 bits of sRGB and an alpha.
///
/// Hand-written, not generated. `Tokens.generated.swift` is plain data and this is the one
/// place that knows how each platform makes a colour that follows light and dark mode, so the
/// generator never has to change when a platform detail does.
struct SpineRGBA {
    let rgb: UInt32
    let alpha: Double

    init(_ rgb: UInt32, _ alpha: Double = 1) {
        self.rgb = rgb
        self.alpha = alpha
    }

    private var red: Double { Double((rgb >> 16) & 0xFF) / 255 }
    private var green: Double { Double((rgb >> 8) & 0xFF) / 255 }
    private var blue: Double { Double(rgb & 0xFF) / 255 }

    #if canImport(UIKit)
    var platformColor: UIColor { UIColor(red: red, green: green, blue: blue, alpha: alpha) }
    #elseif canImport(AppKit)
    var platformColor: NSColor { NSColor(srgbRed: red, green: green, blue: blue, alpha: alpha) }
    #endif
}

extension Color {
    /// A colour that resolves against the current appearance, so a view never has to ask
    /// `colorScheme` just to pick between two values. The user can still pin light or dark in
    /// Settings: that sets the window's appearance, and this follows it.
    init(light: SpineRGBA, dark: SpineRGBA) {
        #if canImport(UIKit)
        self = Color(UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark.platformColor : light.platformColor
        })
        #elseif canImport(AppKit)
        self = Color(NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark.platformColor : light.platformColor
        })
        #endif
    }
}

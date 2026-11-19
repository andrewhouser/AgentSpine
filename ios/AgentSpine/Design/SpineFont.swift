import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Fonts from the token file's families, with the system font as the fallback.
///
/// The families are not bundled yet (see PLAN-native-apps-and-ui-refresh.md, phase 2), and
/// `Font.custom` with a missing family silently gives proportional system text, which would turn
/// tool names into the wrong face. So each helper asks whether the family exists and otherwise
/// picks the closest system design. When the files are bundled nothing here changes.
///
/// Every helper takes a text style, so sizes follow Dynamic Type on both platforms.
enum SpineFont {
    private static func installed(_ family: String) -> Bool {
        #if canImport(UIKit)
        return !UIFont.fontNames(forFamilyName: family).isEmpty
        #elseif canImport(AppKit)
        return NSFontManager.shared.availableMembers(ofFontFamily: family)?.isEmpty == false
        #else
        return false
        #endif
    }

    /// Titles and the spine's headings.
    static func display(_ size: CGFloat = Spine.TypeSize.title2, relativeTo style: Font.TextStyle = .title2) -> Font {
        installed(Spine.Family.display)
            ? .custom(Spine.Family.display, size: size, relativeTo: style)
            : .system(style, design: .default).weight(.semibold)
    }

    /// Reading text.
    static func sans(_ size: CGFloat = Spine.TypeSize.body, relativeTo style: Font.TextStyle = .body) -> Font {
        installed(Spine.Family.sans)
            ? .custom(Spine.Family.sans, size: size, relativeTo: style)
            : .system(style)
    }

    /// Tool names, arguments and numbers.
    static func mono(_ size: CGFloat = Spine.TypeSize.footnote, relativeTo style: Font.TextStyle = .footnote) -> Font {
        installed(Spine.Family.mono)
            ? .custom(Spine.Family.mono, size: size, relativeTo: style)
            : .system(style, design: .monospaced)
    }
}

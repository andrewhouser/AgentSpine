import SwiftUI
#if canImport(UIKit)
import UIKit
typealias PlatformImage = UIImage
#else
import AppKit
typealias PlatformImage = NSImage
#endif

/// The handful of iOS-only modifiers the shared screens use, in a form that compiles on both
/// platforms. On the Mac each is a no-op or its nearest equivalent, so a screen written for the
/// phone can sit in the Mac's detail column without a second copy.
extension View {
    /// A small title over a pushed screen. The Mac's window title bar has no large/inline split.
    @ViewBuilder func spineInlineTitle() -> some View {
        #if os(iOS)
        navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }

    @ViewBuilder func spineNoAutocapitalization() -> some View {
        #if os(iOS)
        textInputAutocapitalization(.never)
        #else
        self
        #endif
    }

    @ViewBuilder func spineNumberPad() -> some View {
        #if os(iOS)
        keyboardType(.numberPad)
        #else
        self
        #endif
    }

    /// The phone's inset-grouped lists; the Mac's inset style is the closest match.
    @ViewBuilder func spineGroupedListStyle() -> some View {
        #if os(iOS)
        listStyle(.insetGrouped)
        #else
        listStyle(.inset)
        #endif
    }
}

extension ToolbarItemPlacement {
    /// Leading and trailing in a phone's navigation bar; on the Mac, where the title sits, the
    /// navigation and primary-action areas.
    static var spineLeading: ToolbarItemPlacement {
        #if os(iOS)
        .topBarLeading
        #else
        .navigation
        #endif
    }

    static var spineTrailing: ToolbarItemPlacement {
        #if os(iOS)
        .topBarTrailing
        #else
        .primaryAction
        #endif
    }
}

extension Image {
    init(platformImage: PlatformImage) {
        #if canImport(UIKit)
        self.init(uiImage: platformImage)
        #else
        self.init(nsImage: platformImage)
        #endif
    }
}

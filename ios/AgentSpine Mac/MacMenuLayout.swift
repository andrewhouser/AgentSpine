import Foundation

/// The sidebar menu's order, kept valid whatever was saved. The first six items are the menu and
/// the rest fold under More, so "which items are pinned" is just "which come first", as on the
/// iPhone's tab bar. `web/src/lib/navLayout.ts` is the same rule, and
/// `test/menu-layout.test.mjs` runs both against one set of cases.
///
/// Foundation-only so that test can compile and run the real file.
enum MenuLayout {
    static let pinnedSlots = 6

    /// Unknown names dropped (an item a later version removed), repeats dropped, and anything the
    /// saved list lacks (an item a later version added) appended in default order, so it lands
    /// under More rather than displacing something the user chose to pin.
    static func reconcile(_ saved: [String], all: [String]) -> [String] {
        var result: [String] = []
        for name in saved where all.contains(name) && !result.contains(name) { result.append(name) }
        for name in all where !result.contains(name) { result.append(name) }
        return result
    }

    static func pinned(_ order: [String]) -> [String] { Array(order.prefix(pinnedSlots)) }
    static func folded(_ order: [String]) -> [String] { Array(order.dropFirst(pinnedSlots)) }

    /// `@AppStorage` holds a string, not an array. Section names never contain a comma.
    static func decode(_ stored: String) -> [String] {
        stored.split(separator: ",").map(String.init)
    }

    static func encode(_ order: [String]) -> String { order.joined(separator: ",") }
}

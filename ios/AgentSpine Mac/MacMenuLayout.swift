import Foundation

/// The sidebar menu's order, kept valid whatever was saved. The first six items are the menu and
/// the rest fold under More, so "which items are pinned" is just "which come first", as on the
/// iPhone's tab bar. `web/src/lib/navLayout.ts` is the same rule, and
/// `test/menu-layout.test.mjs` runs both against one set of cases.
///
/// Foundation-only so that test can compile and run the real file.
enum MenuLayout {
    /// How many are pinned when nothing is chosen.
    static let pinnedSlots = 6
    /// What Settings → Sidebar menu offers (Andrew, 2026-11-27). `PINNED_MIN`/`PINNED_MAX` in
    /// web/src/lib/navLayout.ts are the same.
    static let pinnedRange = 2...8
    /// The `@AppStorage` key for the chosen count; 0 (nothing stored) is the default.
    static let countKey = "sidebarPinnedCount"

    /// Anything stored that is out of range falls back to the default, never clamps to an edge.
    static func count(_ stored: Int) -> Int { pinnedRange.contains(stored) ? stored : pinnedSlots }

    /// Unknown names dropped (an item a later version removed), repeats dropped, and anything the
    /// saved list lacks (an item a later version added) appended in default order, so it lands
    /// under More rather than displacing something the user chose to pin.
    static func reconcile(_ saved: [String], all: [String]) -> [String] {
        var result: [String] = []
        for name in saved where all.contains(name) && !result.contains(name) { result.append(name) }
        for name in all where !result.contains(name) { result.append(name) }
        return result
    }

    /// A drag and drop: `item` moves to just before `target`, or just after it with `after`.
    /// Dropping across the line between the pinned six and More pins or unpins it; the item it
    /// displaces slides over the line. `placeItem` in web/src/lib/navLayout.ts is the same rule.
    static func place(_ order: [String], item: String, target: String, after: Bool) -> [String] {
        guard item != target, order.contains(item), order.contains(target) else { return order }
        var rest = order.filter { $0 != item }
        let at = rest.firstIndex(of: target)! + (after ? 1 : 0)
        rest.insert(item, at: at)
        return rest
    }

    static func pinned(_ order: [String], count: Int = pinnedSlots) -> [String] { Array(order.prefix(count)) }
    static func folded(_ order: [String], count: Int = pinnedSlots) -> [String] { Array(order.dropFirst(count)) }

    /// `@AppStorage` holds a string, not an array. Section names never contain a comma.
    static func decode(_ stored: String) -> [String] {
        stored.split(separator: ",").map(String.init)
    }

    static func encode(_ order: [String]) -> String { order.joined(separator: ",") }
}

import Foundation

/// Every top-level section of the app, in the order a fresh install shows them.
///
/// Raw values are what gets saved in `UserDefaults`, so they are stable identifiers: renaming a
/// case here would silently reset everyone's tab order.
enum AppTab: String, CaseIterable, Codable, Hashable {
    case threads, headsup, tasks, study, schedules, projects, files, clients, search, meetings, builds, activity, settings

    var title: String {
        switch self {
        case .threads: return "Threads"
        case .headsup: return "Heads-up"
        case .tasks: return "Tasks"
        case .study: return "Study"
        case .schedules: return "Schedules"
        case .projects: return "Projects"
        case .files: return "Files"
        case .clients: return "Clients"
        case .search: return "Search"
        case .meetings: return "Meetings"
        case .builds: return "Builds"
        case .activity: return "Activity"
        case .settings: return "Settings"
        }
    }

    var symbol: String {
        switch self {
        case .threads: return "bubble.left.and.text.bubble.right"
        case .headsup: return "sparkles"
        case .tasks: return "checklist"
        case .study: return "brain.head.profile"
        case .schedules: return "clock"
        case .projects: return "folder"
        case .files: return "doc.text"
        case .clients: return "person.crop.rectangle.stack"
        case .search: return "magnifyingglass"
        case .meetings: return "person.2.wave.2"
        case .builds: return "hammer"
        case .activity: return "list.bullet.rectangle"
        case .settings: return "gearshape"
        }
    }
}

/// The user's tab order, kept valid whatever was saved.
///
/// iOS shows five slots: the first four tabs and "More", which holds the rest in order. So
/// "which tabs are in the bar" is just "which come first". Threads is always first, because
/// it is where approvals are asked and nothing else here is blocked on you.
///
/// Pure and Foundation-only so `test/ios-tab-layout.test.mjs` can compile and run it.
enum TabLayout {
    /// Tabs in the bar before "More" takes over.
    static let barSlots = 4

    /// Turn whatever was saved into a complete, valid order: unknown names dropped (a tab a
    /// later version removed), repeats dropped, Threads forced first, and any tab the saved
    /// list does not mention (one a later version added) appended under More in default order.
    static func reconcile(_ saved: [String]) -> [AppTab] {
        var result: [AppTab] = [.threads]
        for raw in saved {
            if let tab = AppTab(rawValue: raw), !result.contains(tab) { result.append(tab) }
        }
        for tab in AppTab.allCases where !result.contains(tab) { result.append(tab) }
        return result
    }

    static func bar(_ order: [AppTab]) -> [AppTab] { Array(order.prefix(barSlots)) }
    static func more(_ order: [AppTab]) -> [AppTab] { Array(order.dropFirst(barSlots)) }
    static func raw(_ order: [AppTab]) -> [String] { order.map(\.rawValue) }
}

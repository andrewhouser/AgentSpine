import Foundation

/// Every top-level section of the app, in the order a fresh install shows them.
///
/// Raw values are what gets saved in `UserDefaults`, so they are stable identifiers: renaming a
/// case here would silently reset everyone's tab order.
enum AppTab: String, CaseIterable, Codable, Hashable {
    // Today leads (PLAN-open-work section 14, U1). Since the 2026-11-27 menu review (section 15,
    // R12): Today, Ask, Meetings and Tasks in the bar. Projects and Memory are in Settings, Check-in
    // is inside Heads-up, Drop zone inside Knowledge, Builds inside Activity, and Search is the Ask
    // tab's own search field.
    case today, threads, meetings, tasks, people, headsup, knowledge, schedules, files, study, clients, activity, settings

    var title: String {
        switch self {
        case .today: return "Today"
        case .threads: return "Ask"
        case .people: return "People"
        case .headsup: return "Heads-up"
        case .tasks: return "Tasks"
        case .study: return "Study"
        case .schedules: return "Schedules"
        case .files: return "Files"
        case .knowledge: return "Knowledge"
        case .clients: return "Clients"
        case .meetings: return "Meetings"
        case .activity: return "Activity"
        case .settings: return "Settings"
        }
    }

    var symbol: String {
        switch self {
        case .today: return "sun.max"
        case .threads: return "bubble.left.and.text.bubble.right"
        case .people: return "person.2"
        case .headsup: return "sparkles"
        case .tasks: return "checklist"
        case .study: return "brain.head.profile"
        case .schedules: return "clock"
        case .files: return "doc.text"
        case .knowledge: return "books.vertical"
        case .clients: return "person.crop.rectangle.stack"
        case .meetings: return "person.2.wave.2"
        case .activity: return "list.bullet.rectangle"
        case .settings: return "gearshape"
        }
    }
}

/// The user's tab order, kept valid whatever was saved.
///
/// iOS shows five slots: the first four tabs and "More", which holds the rest in order. So
/// "which tabs are in the bar" is just "which come first". Today is always first, because it
/// is the one screen that says what is blocked on you, and Threads is always second, because
/// it is where the conversation happens. The other two slots are yours.
///
/// Pure and Foundation-only so `test/ios-tab-layout.test.mjs` can compile and run it.
enum TabLayout {
    /// Tabs in the bar before "More" takes over.
    static let barSlots = 4

    /// Turn whatever was saved into a complete, valid order: unknown names dropped (a tab a
    /// later version removed), repeats dropped, Today and Threads forced first, and any tab the
    /// saved list does not mention (one a later version added) appended under More in default
    /// order. An order saved before Today existed keeps its own sequence behind the two, so
    /// what was its fourth tab is now the first row under More.
    static func reconcile(_ saved: [String]) -> [AppTab] {
        var result: [AppTab] = [.today, .threads]
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

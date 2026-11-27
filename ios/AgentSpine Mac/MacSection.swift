import SwiftUI

/// The Mac sidebar. Threads comes first because it is where approvals are asked; the rest are
/// the phone's sections, grouped by what they are for. Search is not a section here: ⌘K does it
/// from anywhere, and Settings is the ⌘, scene.
enum MacSection: String, CaseIterable, Hashable {
    case today, threads, headsup, tasks, study, schedules, files, knowledge, clients, meetings
    case activity, proposals, agents, people

    /// The menu order on a fresh install: the first six are pinned, the rest fold under More.
    /// Threads is not here: the threads are listed above the menu, so `.threads` is the state of
    /// having a thread (or the new-thread screen) open rather than a row. Today is not here
    /// either: it has a fixed row at the top of the sidebar, because it is where the window opens.
    ///
    /// Since the 2026-11-27 menu review (section 15, R12): Projects and Memory are in Settings,
    /// Check-in is inside Heads-up, Drop zone inside Knowledge, Builds inside Activity. The threads
    /// above the menu are Ask, and ⌘K searches them.
    static let defaultOrder: [MacSection] = [
        .meetings, .tasks, .people, .knowledge, .headsup, .schedules,
        .files, .study, .clients, .activity, .proposals, .agents,
    ]

    /// "3" since the 2026-11-27 menu review took five sections away: an older order would pull
    /// whatever followed them up into the pinned six, so it starts again once.
    static let orderKey = "sidebarMenuOrder3"

    /// The saved order, repaired. An empty string is the default order.
    static func ordered(_ stored: String) -> [MacSection] {
        MenuLayout.reconcile(MenuLayout.decode(stored), all: defaultOrder.map(\.rawValue))
            .compactMap(MacSection.init(rawValue:))
    }

    var title: String {
        switch self {
        case .today: return "Today"
        case .threads: return "Threads"
        case .headsup: return "Heads-up"
        case .tasks: return "Tasks"
        case .study: return "Study"
        case .schedules: return "Schedules"
        case .files: return "Files"
        case .knowledge: return "Knowledge"
        case .clients: return "Clients"
        case .meetings: return "Meetings"
        case .activity: return "Activity"
        case .people: return "People"
        case .proposals: return "Auto-approvals"
        case .agents: return "Agents"
        }
    }

    /// The hover tooltip: what the section is for, in a line.
    var hint: String {
        switch self {
        case .headsup: return "New mail from people, and birthdays, bills and trips coming up"
        case .tasks: return "To-dos and follow-ups"
        case .study: return "Flash cards and learning topics"
        case .schedules: return "Recurring jobs and watchers"
        case .files: return "Files the assistant wrote for you"
        case .knowledge: return "Decisions and commitments to review, and files to add"
        case .clients: return "Clients and time tracking"
        case .meetings: return "Recorded meetings, transcripts and the to-dos they found"
        case .activity: return "Every run with its full trace, and coding runs with their diffs"
        case .people: return "What is due, whose it is, and the people behind it"
        case .proposals: return "Suggested rules to skip repeat approvals"
        case .agents: return "Sub-agents and the model tier each uses"
        case .threads: return "Your conversations"
        case .today: return "What is waiting on you, what is due, and what ran while you were away"
        }
    }

    var symbol: String {
        switch self {
        case .today: return "sun.max"
        case .threads: return "bubble.left.and.text.bubble.right"
        case .headsup: return "sparkles"
        case .tasks: return "checklist"
        case .study: return "brain.head.profile"
        case .schedules: return "clock"
        case .files: return "doc.text"
        case .knowledge: return "books.vertical"
        case .clients: return "person.crop.rectangle.stack"
        case .meetings: return "person.2.wave.2"
        case .activity: return "list.bullet.rectangle"
        case .people: return "person.2"
        case .proposals: return "checkmark.shield"
        case .agents: return "person.crop.square"
        }
    }
}

/// The phone's screen for a section, in a navigation stack of its own so its pushed screens work.
struct MacSectionContent: View {
    let section: MacSection
    /// Which half of a place that holds two screens is showing (section 15, R12).
    @State private var showSecond = false

    var body: some View {
        NavigationStack {
            switch section {
            case .threads, .today: EmptyView() // drawn by MacRootView, which owns the selection
            case .headsup:
                PlacePicker(title: "Heads-up", firstLabel: "From your mail", secondLabel: "Coming up", showSecond: $showSecond) {
                    MacCheckinView()
                } second: {
                    MacHeadsupView()
                }
            case .tasks: TasksView()
            case .study: StudyView()
            case .schedules: SchedulesView()
            case .files: FilesView()
            case .knowledge:
                PlacePicker(title: "Knowledge", firstLabel: "Review", secondLabel: "Add files", showSecond: $showSecond) {
                    KnowledgeView()
                } second: {
                    InboxView()
                }
            case .clients: ClientsView()
            case .meetings: MacMeetingsView()
            case .activity:
                PlacePicker(title: "Activity", firstLabel: "All runs", secondLabel: "Coding runs", showSecond: $showSecond) {
                    MacActivityView()
                } second: {
                    MacBuildsView()
                }
            case .people: PeopleView()
            case .proposals: ProposalsView()
            case .agents: AgentsView()
            }
        }
        .spineScreen()
    }
}

import SwiftUI

/// The Mac sidebar. Threads comes first because it is where approvals are asked; the rest are
/// the phone's sections, grouped by what they are for. Search is not a section here: ⌘K does it
/// from anywhere, and Settings is the ⌘, scene.
enum MacSection: String, CaseIterable, Hashable {
    case threads, headsup, checkin, tasks, study, schedules, projects, files, inbox, knowledge, clients, meetings
    case builds, activity, memory, proposals, agents

    /// The menu order on a fresh install: the first six are pinned, the rest fold under More.
    /// Threads is not here: the threads are listed above the menu, so `.threads` is the state of
    /// having a thread (or the new-thread screen) open rather than a row.
    static let defaultOrder: [MacSection] = [
        .headsup, .checkin, .tasks, .meetings, .inbox, .knowledge, .schedules,
        .projects, .files, .builds, .study, .clients, .activity, .memory, .proposals, .agents,
    ]

    static let orderKey = "sidebarMenuOrder"

    /// The saved order, repaired. An empty string is the default order.
    static func ordered(_ stored: String) -> [MacSection] {
        MenuLayout.reconcile(MenuLayout.decode(stored), all: defaultOrder.map(\.rawValue))
            .compactMap(MacSection.init(rawValue:))
    }

    var title: String {
        switch self {
        case .threads: return "Threads"
        case .headsup: return "Heads-up"
        case .checkin: return "Check-in"
        case .tasks: return "Tasks"
        case .study: return "Study"
        case .schedules: return "Schedules"
        case .projects: return "Projects"
        case .files: return "Files"
        case .inbox: return "Drop zone"
        case .knowledge: return "Knowledge"
        case .clients: return "Clients"
        case .meetings: return "Meetings"
        case .builds: return "Builds"
        case .activity: return "Activity"
        case .memory: return "Memory"
        case .proposals: return "Auto-approvals"
        case .agents: return "Agents"
        }
    }

    /// The hover tooltip: what the section is for, in a line.
    var hint: String {
        switch self {
        case .headsup: return "Birthdays, bills and trips it spotted"
        case .checkin: return "New mail from people, and what else is waiting"
        case .tasks: return "To-dos and follow-ups"
        case .study: return "Flash cards and learning topics"
        case .schedules: return "Recurring jobs and watchers"
        case .projects: return "Workspaces with their own context and documents"
        case .files: return "Files the assistant wrote for you"
        case .inbox: return "Drop in files, scans or notes for it to remember"
        case .knowledge: return "Decisions and commitments to review"
        case .clients: return "Clients and time tracking"
        case .meetings: return "Recorded meetings, transcripts and summaries"
        case .builds: return "Commands and diffs from coding runs"
        case .activity: return "Every run, with its full trace"
        case .memory: return "What it has learned about you"
        case .proposals: return "Suggested rules to skip repeat approvals"
        case .agents: return "Sub-agents and the model tier each uses"
        case .threads: return "Your conversations"
        }
    }

    var symbol: String {
        switch self {
        case .threads: return "bubble.left.and.text.bubble.right"
        case .headsup: return "sparkles"
        case .checkin: return "envelope.badge"
        case .tasks: return "checklist"
        case .study: return "brain.head.profile"
        case .schedules: return "clock"
        case .projects: return "folder"
        case .files: return "doc.text"
        case .inbox: return "tray.and.arrow.down"
        case .knowledge: return "books.vertical"
        case .clients: return "person.crop.rectangle.stack"
        case .meetings: return "person.2.wave.2"
        case .builds: return "hammer"
        case .activity: return "list.bullet.rectangle"
        case .memory: return "brain"
        case .proposals: return "checkmark.shield"
        case .agents: return "person.crop.square"
        }
    }
}

/// The phone's screen for a section, in a navigation stack of its own so its pushed screens work.
struct MacSectionContent: View {
    let section: MacSection

    var body: some View {
        NavigationStack {
            switch section {
            case .threads: EmptyView() // drawn by MacRootView, which owns the selection
            case .headsup: MacHeadsupView()
            case .checkin: MacCheckinView()
            case .tasks: TasksView()
            case .study: StudyView()
            case .schedules: SchedulesView()
            case .projects: ProjectsView()
            case .files: FilesView()
            case .inbox: InboxView()
            case .knowledge: KnowledgeView()
            case .clients: ClientsView()
            case .meetings: MacMeetingsView()
            case .builds: MacBuildsView()
            case .activity: MacActivityView()
            case .memory: MemoryView()
            case .proposals: ProposalsView()
            case .agents: AgentsView()
            }
        }
        .spineScreen()
    }
}

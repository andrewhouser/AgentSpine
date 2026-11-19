import SwiftUI

/// The Mac sidebar. Threads comes first because it is where approvals are asked; the rest are
/// the phone's sections, grouped by what they are for. Search is not a section here: ⌘K does it
/// from anywhere, and Settings is the ⌘, scene.
enum MacSection: String, CaseIterable, Hashable {
    case threads, headsup, tasks, study, schedules, projects, files, clients, meetings
    case builds, activity, memory, proposals, agents

    enum Group: String, CaseIterable {
        case work = "Work"
        case people = "People and time"
        case agent = "Agent"
    }

    var group: Group {
        switch self {
        case .threads, .tasks, .projects, .files, .builds: return .work
        case .headsup, .study, .schedules, .clients, .meetings: return .people
        case .activity, .memory, .proposals, .agents: return .agent
        }
    }

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
        case .meetings: return "Meetings"
        case .builds: return "Builds"
        case .activity: return "Activity"
        case .memory: return "Memory"
        case .proposals: return "Auto-approvals"
        case .agents: return "Agents"
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
        case .meetings: return "person.2.wave.2"
        case .builds: return "hammer"
        case .activity: return "list.bullet.rectangle"
        case .memory: return "brain"
        case .proposals: return "checkmark.shield"
        case .agents: return "person.crop.square"
        }
    }

    static func sections(in group: Group) -> [MacSection] {
        allCases.filter { $0.group == group }
    }
}

/// The phone's screen for a section, in a navigation stack of its own so its pushed screens work.
struct MacSectionContent: View {
    let section: MacSection

    var body: some View {
        NavigationStack {
            switch section {
            case .threads: EmptyView() // drawn by MacRootView, which owns the selection
            case .headsup: HeadsupView()
            case .tasks: TasksView()
            case .study: StudyView()
            case .schedules: SchedulesView()
            case .projects: ProjectsView()
            case .files: FilesView()
            case .clients: ClientsView()
            case .meetings: MeetingsView()
            case .builds: BuildsView()
            case .activity: ActivityView()
            case .memory: MemoryView()
            case .proposals: ProposalsView()
            case .agents: AgentsView()
            }
        }
        .spineScreen()
    }
}

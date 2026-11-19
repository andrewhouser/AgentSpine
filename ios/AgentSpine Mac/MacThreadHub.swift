import Foundation
import Observation

/// Keeps a thread in step across windows. The same thread can be open in the main window and
/// in pop-outs, each with its own stream; when one sends, finishes, answers an approval or
/// changes the tier, it nudges the hub, and every *other* window showing that thread reloads.
/// A reload already attaches to a run in flight (see MacThreadDetail.load), so the second
/// window picks up the live turn without the server having to know there are two.
@MainActor
@Observable
final class MacThreadHub {
    private(set) var tick = 0
    private(set) var lastConversation: Int?
    private(set) var lastSource: UUID?

    func nudge(_ conversationID: Int, from source: UUID) {
        lastConversation = conversationID
        lastSource = source
        tick += 1
    }
}

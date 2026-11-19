import SwiftUI

/// Shared by both targets: a tool call's arguments, pretty-printed.

/// A tool call's arguments, pretty-printed.
///
/// The server stores them as the JSON string the model produced, which on one line is
/// unreadable on a phone. Re-encoding with sorted keys and indentation is the difference
/// between "I can see what it was about to do" and "there is some JSON here".
enum PrettyJSON {
    static func format(_ raw: String) -> String {
        guard let data = raw.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(
                  withJSONObject: object,
                  options: [.prettyPrinted, .sortedKeys]
              ),
              let text = String(data: pretty, encoding: .utf8)
        else { return raw }
        return text
    }
}

import Foundation

/// Which failed tool calls the turn went on to get past.
///
/// The same rule as `web/src/lib/recovery.ts`, and written the same way for the same reason: a
/// name lookup that misses and is then followed by a search that finds it is the loop doing its
/// job, and a red "error" with a failure count on that turn reads as though something broke.
/// So an `error` call is *recovered* when a LATER call in the same turn was `executed`.
///
/// It is a heuristic and is shown as one: it cannot know the later call stood in for the failed
/// one, so a recovered call is drawn muted and labelled, never hidden. What it never softens: a
/// `denied` call (the broker doing its job), an error with nothing after it, a call still running
/// or waiting on approval, or any call in a turn that itself failed.
///
/// Takes the broker's verdicts as raw strings ("error", "executed", ...; nil while a call is
/// still running) so this file stays Foundation-only and `test/ios-turn-helpers.test.mjs` can
/// compile the real thing. Returns one flag per call, in order.
enum RecoveredCalls {
    static func flags(_ statuses: [String?], turnFailed: Bool = false) -> [Bool] {
        statuses.enumerated().map { index, status in
            !turnFailed && status == "error" && statuses[(index + 1)...].contains("executed")
        }
    }
}

/// When a message was sent, in the shortest form that still places it: "Just now", "5 min ago",
/// a clock time today, "Yesterday, 9:04 AM", then a date. The same ladder as
/// `web/src/lib/relativeTime.ts`. Takes `now` and `calendar` so it can be tested.
enum MessageTime {
    static func label(from date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let seconds = now.timeIntervalSince(date)
        // A time slightly in the future (the phone's clock and the server's disagree) is "just now".
        if seconds < 60 { return "Just now" }
        if seconds < 3600 { return "\(Int(seconds / 60)) min ago" }

        let time = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDate(date, inSameDayAs: now) { return time }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) {
            return "Yesterday, \(time)"
        }
        let sameYear = calendar.isDate(date, equalTo: now, toGranularity: .year)
        let day = sameYear
            ? date.formatted(.dateTime.day().month(.abbreviated))
            : date.formatted(.dateTime.day().month(.abbreviated).year())
        return "\(day), \(time)"
    }
}

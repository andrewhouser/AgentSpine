// EventKit helper for mac_control: read and write Calendar events and Reminders.
//
// Why EventKit and not AppleScript: Calendar.app's scripting dictionary returns a recurring
// event only on the day it was first created, so "what's on my calendar this week?" silently
// misses every weekly meeting — exactly the check you'd run before adding a new event.
// EventKit expands recurrences, is fast, and takes real dates rather than locale strings.
//
// Protocol: one JSON object on stdin, one JSON object on stdout, exit 0 either way. Dates
// cross the boundary as epoch seconds; the caller (src/tools/apple.ts) does all parsing and
// formatting, so this file has no opinion about time zones or formats.
//
//   {"cmd":"events","from":<s>,"to":<s>}
//   {"cmd":"add_event","title":..,"start":<s>,"end":<s>,"allDay":bool,"calendar"?:..,"location"?:..,"notes"?:..}
//   {"cmd":"reminders"}
//   {"cmd":"add_reminder","title":..,"due"?:<s>,"list"?:..,"notes"?:..}
//
// Built by update.sh (and on first use) with an embedded Info.plist, because macOS refuses
// calendar access to a binary that carries no usage description.
import EventKit
import Foundation

let store = EKEventStore()

func emit(_ obj: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{\"error\":\"unserialisable\"}".utf8)
  FileHandle.standardOutput.write(data)
  exit(0)
}

func fail(_ message: String) -> Never { emit(["error": message]) }

/// Ask once; macOS remembers the answer. A process with no window can still be prompted —
/// the dialog names whichever app is responsible for it — but only inside a logged-in session.
func access(_ type: EKEntityType) -> Bool {
  let status = EKEventStore.authorizationStatus(for: type)
  if status == .fullAccess { return true }
  if status == .denied || status == .restricted { return false }
  let done = DispatchSemaphore(value: 0)
  var granted = false
  let finish: (Bool, Error?) -> Void = { ok, _ in granted = ok; done.signal() }
  if type == .event { store.requestFullAccessToEvents(completion: finish) } else { store.requestFullAccessToReminders(completion: finish) }
  _ = done.wait(timeout: .now() + 120)
  return granted
}

func denied(_ what: String) -> Never {
  fail(
    "macOS has not granted \(what) access. Open System Settings > Privacy & Security > \(what) and allow it " +
      "for node (or the AgentSpine helper), then try again. If no prompt ever appeared, the dashboard is " +
      "running outside your login session, where macOS cannot ask."
  )
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let req = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any], let cmd = req["cmd"] as? String else {
  fail("expected one JSON object with a cmd")
}

func num(_ key: String) -> Double? { (req[key] as? NSNumber)?.doubleValue }
func str(_ key: String) -> String? {
  guard let s = req[key] as? String else { return nil }
  let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
  return t.isEmpty ? nil : t
}

switch cmd {
case "events":
  guard access(.event) else { denied("Calendars") }
  guard let from = num("from"), let to = num("to") else { fail("events needs from and to") }
  let predicate = store.predicateForEvents(
    withStart: Date(timeIntervalSince1970: from), end: Date(timeIntervalSince1970: to), calendars: nil)
  let events = store.events(matching: predicate).sorted { $0.startDate < $1.startDate }.prefix(200).map { e -> [String: Any] in
    [
      "allDay": e.isAllDay,
      "calendar": e.calendar.title,
      "end": e.endDate.timeIntervalSince1970,
      "location": e.location ?? "",
      "start": e.startDate.timeIntervalSince1970,
      "title": e.title ?? "",
    ]
  }
  emit(["events": Array(events)])

case "add_event":
  guard access(.event) else { denied("Calendars") }
  guard let title = str("title"), let start = num("start"), let end = num("end") else {
    fail("add_event needs title, start and end")
  }
  let event = EKEvent(eventStore: store)
  event.title = title
  event.startDate = Date(timeIntervalSince1970: start)
  event.endDate = Date(timeIntervalSince1970: end)
  event.isAllDay = (req["allDay"] as? Bool) ?? false
  event.location = str("location")
  event.notes = str("notes")
  if let name = str("calendar") {
    let writable = store.calendars(for: .event).filter { $0.allowsContentModifications }
    guard let cal = writable.first(where: { $0.title.caseInsensitiveCompare(name) == .orderedSame }) else {
      fail("no writable calendar named \"\(name)\". Writable calendars: \(writable.map { $0.title }.joined(separator: ", "))")
    }
    event.calendar = cal
  } else {
    guard let cal = store.defaultCalendarForNewEvents else { fail("there is no default calendar for new events") }
    event.calendar = cal
  }
  do { try store.save(event, span: .thisEvent, commit: true) } catch { fail("could not save the event: \(error.localizedDescription)") }
  emit(["calendar": event.calendar.title, "ok": true])

case "reminders":
  guard access(.reminder) else { denied("Reminders") }
  let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
  let done = DispatchSemaphore(value: 0)
  var found: [EKReminder] = []
  store.fetchReminders(matching: predicate) { list in found = list ?? []; done.signal() }
  _ = done.wait(timeout: .now() + 30)
  let rows = found.prefix(100).map { r -> [String: Any] in
    var row: [String: Any] = ["list": r.calendar.title, "title": r.title ?? ""]
    if let due = r.dueDateComponents?.date ?? r.dueDateComponents.flatMap({ Calendar.current.date(from: $0) }) {
      row["due"] = due.timeIntervalSince1970
    }
    return row
  }
  emit(["reminders": Array(rows)])

case "add_reminder":
  guard access(.reminder) else { denied("Reminders") }
  guard let title = str("title") else { fail("add_reminder needs a title") }
  let reminder = EKReminder(eventStore: store)
  reminder.title = title
  reminder.notes = str("notes")
  if let due = num("due") {
    let date = Date(timeIntervalSince1970: due)
    reminder.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date)
    // An alarm at the due time, or the reminder is just a line in a list that never speaks up.
    reminder.addAlarm(EKAlarm(absoluteDate: date))
  }
  if let name = str("list") {
    let lists = store.calendars(for: .reminder).filter { $0.allowsContentModifications }
    guard let list = lists.first(where: { $0.title.caseInsensitiveCompare(name) == .orderedSame }) else {
      fail("no reminders list named \"\(name)\". Lists: \(lists.map { $0.title }.joined(separator: ", "))")
    }
    reminder.calendar = list
  } else {
    guard let list = store.defaultCalendarForNewReminders() else { fail("there is no default reminders list") }
    reminder.calendar = list
  }
  do { try store.save(reminder, commit: true) } catch { fail("could not save the reminder: \(error.localizedDescription)") }
  emit(["list": reminder.calendar.title, "ok": true])

default:
  fail("unknown cmd \(cmd)")
}

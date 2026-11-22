import Foundation

/// The card the weather tool puts in its output between `<weather-card>` markers
/// (src/tools/weather.ts). Foundation-only so the wire shape can be compiled and checked alone;
/// the server picks `icon`, so web, Mac and iPhone cannot disagree about what a code looks like.
struct WeatherCard: Decodable, Equatable {
    struct Now: Decodable, Equatable {
        let condition: String
        let feelsLike: Int
        let icon: String
        let night: Bool
        let temp: Int
        let wind: Int
    }

    struct Day: Decodable, Equatable, Identifiable {
        let condition: String
        let date: String
        let hi: Int
        let icon: String
        let lo: Int
        let precip: Int
        var id: String { date }
    }

    let place: String
    let now: Now
    let days: [Day]

    private static let open = "<weather-card>"
    private static let close = "</weather-card>"

    static func parse(_ output: String?) -> WeatherCard? {
        guard let output, let a = output.range(of: open),
              let b = output.range(of: close, range: a.upperBound..<output.endIndex) else { return nil }
        let json = String(output[a.upperBound..<b.lowerBound])
        guard let card = try? JSONDecoder().decode(WeatherCard.self, from: Data(json.utf8)),
              !card.days.isEmpty else { return nil }
        return card
    }

    /// The last executed weather lookup of a turn.
    static func of(calls: [(tool: String, output: String?, executed: Bool)]) -> WeatherCard? {
        for call in calls.reversed() where call.tool == "weather" && call.executed {
            if let card = parse(call.output) { return card }
        }
        return nil
    }
}

import SwiftUI

/// One day: a compact card (icon, condition, H/L). Several: a landscape strip, a tile per day.
/// Drawn above the reply, which still says it all in words. Icons are SF Symbols in their
/// multicolour rendering, so there is no image asset to license or bundle.
struct WeatherCardView: View {
    let card: WeatherCard

    static func symbol(_ icon: String, night: Bool) -> String {
        switch icon {
        case "clear": return night ? "moon.stars.fill" : "sun.max.fill"
        case "partly": return night ? "cloud.moon.fill" : "cloud.sun.fill"
        case "fog": return "cloud.fog.fill"
        case "drizzle": return "cloud.drizzle.fill"
        case "rain": return "cloud.rain.fill"
        case "sleet": return "cloud.sleet.fill"
        case "snow": return "cloud.snow.fill"
        case "storm": return "cloud.bolt.rain.fill"
        default: return "cloud.fill"
        }
    }

    /// "2026-11-21" → "Sat", parsed as a calendar date so the weekday cannot slip a day.
    private func weekday(_ iso: String, first: Bool) -> String {
        if first { return "Today" }
        let parts = iso.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3,
              let date = Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
        else { return iso }
        return date.formatted(.dateTime.weekday(.abbreviated))
    }

    var body: some View {
        Group {
            if card.days.count == 1, let today = card.days.first { compact(today) } else { strip }
        }
        .padding(Spine.Space.md)
        .background(Spine.Palette.bgElevated, in: RoundedRectangle(cornerRadius: Spine.Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Spine.Radius.lg).strokeBorder(Spine.Palette.border))
        .accessibilityElement(children: .combine)
    }

    private func compact(_ today: WeatherCard.Day) -> some View {
        HStack(spacing: Spine.Space.md) {
            Image(systemName: Self.symbol(card.now.icon, night: card.now.night))
                .symbolRenderingMode(.multicolor)
                .font(.system(size: 40))
            VStack(alignment: .leading, spacing: 2) {
                Text(card.place)
                    .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                    .foregroundStyle(Spine.Palette.textFaint)
                Text("\(card.now.temp)°")
                    .font(SpineFont.display(Spine.TypeSize.title1, relativeTo: .title))
                Text(card.now.condition.capitalized)
                    .font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body))
                Text("H:\(today.hi)° L:\(today.lo)°" + (today.precip > 0 ? " · \(today.precip)% precip" : ""))
                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                    .foregroundStyle(Spine.Palette.textDim)
            }
            Spacer(minLength: 0)
        }
    }

    private var strip: some View {
        VStack(alignment: .leading, spacing: Spine.Space.sm) {
            Text(card.place)
                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption))
                .foregroundStyle(Spine.Palette.textFaint)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Spine.Space.sm) {
                    ForEach(Array(card.days.enumerated()), id: \.element.id) { index, day in
                        VStack(spacing: 4) {
                            Text(weekday(day.date, first: index == 0))
                                .font(SpineFont.sans(Spine.TypeSize.caption, relativeTo: .caption).weight(.semibold))
                                .foregroundStyle(Spine.Palette.textDim)
                            Image(systemName: Self.symbol(day.icon, night: index == 0 && card.now.night))
                                .symbolRenderingMode(.multicolor)
                                .font(.system(size: 26))
                                .frame(height: 30)
                            Text("\(day.hi)°").font(SpineFont.sans(Spine.TypeSize.body, relativeTo: .body).weight(.semibold))
                            Text("\(day.lo)°")
                                .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                                .foregroundStyle(Spine.Palette.textFaint)
                            if day.precip >= 20 {
                                Text("\(day.precip)%")
                                    .font(SpineFont.sans(Spine.TypeSize.footnote, relativeTo: .footnote))
                                    .foregroundStyle(Spine.Palette.accent)
                            }
                        }
                        .frame(minWidth: 62)
                        .padding(Spine.Space.sm)
                        .background(Spine.Palette.bgInset, in: RoundedRectangle(cornerRadius: Spine.Radius.md))
                    }
                }
            }
        }
    }
}

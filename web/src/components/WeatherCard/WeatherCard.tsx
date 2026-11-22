import type { WeatherCardData } from "../../lib/weatherCard.ts";

import styles from "./WeatherCard.module.css";
import { WeatherIcon } from "./WeatherIcon.tsx";

/** "2026-11-21" → "Sat". Parsed as a local date so the weekday cannot slip a day across a timezone. */
const weekday = (iso: string, first: boolean): string => {
  if (first) return "Today";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short" });
};

/**
 * One day: a compact card — icon, condition, H/L. Several: a landscape strip with a tile per
 * day. Drawn above the reply text, which still says everything in words.
 */
export const WeatherCard = ({ card }: { card: WeatherCardData }) => {
  const [today] = card.days;
  if (card.days.length === 1) {
    return (
      <section aria-label={`Weather in ${card.place}`} className={styles.compact}>
        <WeatherIcon icon={card.now.icon} night={card.now.night} size={48} />
        <div>
          <div className={styles.place}>{card.place}</div>
          <div className={styles.temp}>{card.now.temp}°</div>
          <div className={styles.cond}>{card.now.condition}</div>
          <div className={styles.hl}>
            H:{today.hi}° L:{today.lo}°
            {card.now.feelsLike !== card.now.temp && <> · feels {card.now.feelsLike}°</>}
            {today.precip > 0 && <> · {today.precip}% precip</>}
          </div>
        </div>
      </section>
    );
  }
  return (
    <section aria-label={`Forecast for ${card.place}`} className={styles.strip}>
      <div className={styles.place}>{card.place}</div>
      <div className={styles.days}>
        {card.days.map((d, i) => (
          <div className={styles.day} key={d.date}>
            <div className={styles.dow}>{weekday(d.date, i === 0)}</div>
            <WeatherIcon icon={d.icon} night={i === 0 && card.now.night} size={40} />
            <div className={styles.dayHi}>{d.hi}°</div>
            <div className={styles.dayLo}>{d.lo}°</div>
            {d.precip >= 20 && <div className={styles.precip}>{d.precip}%</div>}
          </div>
        ))}
      </div>
    </section>
  );
};

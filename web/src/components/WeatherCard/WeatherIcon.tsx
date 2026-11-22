import type { WeatherIconName } from "../../lib/weatherCard.ts";

const SUN = "#f5b301";
const CLOUD = "#b8c4d4";
const CLOUD_DARK = "#8c9bb0";
const BLUE = "#4f9bf0";

const Cloud = ({ fill = CLOUD, x = 0, y = 0 }: { fill?: string; x?: number; y?: number }) => (
  <path
    d="M18 40a8 8 0 0 1 1-15.9A11 11 0 0 1 40 22a9 9 0 0 1 2 18z"
    fill={fill}
    transform={`translate(${x} ${y})`}
  />
);

const Sun = ({ night = false, x = 0, y = 0 }: { night?: boolean; x?: number; y?: number }) =>
  night ? (
    <path d="M30 12a14 14 0 1 0 14 18A11 11 0 0 1 30 12z" fill="#e8d9a0" transform={`translate(${x} ${y})`} />
  ) : (
    <g transform={`translate(${x} ${y})`}>
      <circle cx="28" cy="26" fill={SUN} r="9" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
        <line key={a} stroke={SUN} strokeLinecap="round" strokeWidth="3" transform={`rotate(${a} 28 26)`} x1="28" x2="28" y1="10" y2="14" />
      ))}
    </g>
  );

const drops = (n: number, color: string) =>
  Array.from({ length: n }, (_, i) => (
    <line key={i} stroke={color} strokeLinecap="round" strokeWidth="3" x1={20 + i * 9} x2={17 + i * 9} y1="46" y2="54" />
  ));

/**
 * Original glyphs, drawn here rather than lifted from an icon pack: a pack's licence wants
 * attribution on every screen that shows it, and the Mac and iPhone use SF Symbols anyway.
 * Decorative — the condition is always written next to it — so it is hidden from screen readers.
 */
export const WeatherIcon = ({ icon, night = false, size = 40 }: { icon: WeatherIconName; night?: boolean; size?: number }) => (
  <svg aria-hidden="true" height={size} viewBox="0 0 60 60" width={size}>
    {icon === "clear" && <Sun night={night} y={4} />}
    {icon === "partly" && (
      <>
        <Sun night={night} x={-6} y={-4} />
        <Cloud fill="#d3dbe7" y={2} />
      </>
    )}
    {icon === "cloudy" && <Cloud />}
    {icon === "fog" && (
      <>
        <Cloud y={-4} />
        <line stroke={CLOUD_DARK} strokeLinecap="round" strokeWidth="3" x1="14" x2="46" y1="46" y2="46" />
        <line stroke={CLOUD_DARK} strokeLinecap="round" strokeWidth="3" x1="20" x2="52" y1="53" y2="53" />
      </>
    )}
    {icon === "drizzle" && (
      <>
        <Cloud fill={CLOUD_DARK} y={-6} />
        {drops(2, BLUE)}
      </>
    )}
    {icon === "rain" && (
      <>
        <Cloud fill={CLOUD_DARK} y={-6} />
        {drops(3, BLUE)}
      </>
    )}
    {icon === "sleet" && (
      <>
        <Cloud fill={CLOUD_DARK} y={-6} />
        <line stroke={BLUE} strokeLinecap="round" strokeWidth="3" x1="20" x2="17" y1="46" y2="54" />
        <circle cx="31" cy="50" fill="#dbe7f5" r="2.6" />
        <line stroke={BLUE} strokeLinecap="round" strokeWidth="3" x1="38" x2="35" y1="46" y2="54" />
      </>
    )}
    {icon === "snow" && (
      <>
        <Cloud fill={CLOUD_DARK} y={-6} />
        {[22, 32, 42].map((x) => (
          <circle cx={x} cy="50" fill="#dbe7f5" key={x} r="2.8" />
        ))}
      </>
    )}
    {icon === "storm" && (
      <>
        <Cloud fill="#7d8ba0" y={-6} />
        <path d="M32 34l-8 12h6l-3 10 11-14h-6l4-8z" fill={SUN} />
      </>
    )}
  </svg>
);

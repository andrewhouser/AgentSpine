import { useNavOrder } from "../../hooks/useNavOrder.ts";
import { NAV_ITEMS, PINNED_SLOTS, saveNavOrder } from "../../lib/navLayout.ts";
import styles from "./NavOrderPanel.module.css";

/** Settings → Menu: which six items are pinned in the sidebar, and their order. */
export const NavOrderPanel = () => {
  const { isDefault, order } = useNavOrder();

  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    saveNavOrder(next);
  };

  return (
    <section>
      <h2 className={styles.subhead}>Sidebar menu</h2>
      <p className={styles.note}>The first six are in the sidebar menu; the rest are under More.</p>
      <ol className={styles.list}>
        {order.map((key, index) => {
          const label = NAV_ITEMS.find((item) => item.key === key)?.label ?? key;
          const pinned = index < PINNED_SLOTS;
          return (
            <li className={styles.row} key={key}>
              <span className={styles.label}>{label}</span>
              <span className={pinned ? styles.chipPinned : styles.chip}>{pinned ? "Menu" : "More"}</span>
              <button aria-label={`Move ${label} up`} className={styles.move} disabled={index === 0} onClick={() => move(index, -1)} type="button">
                ↑
              </button>
              <button
                aria-label={`Move ${label} down`}
                className={styles.move}
                disabled={index === order.length - 1}
                onClick={() => move(index, 1)}
                type="button"
              >
                ↓
              </button>
            </li>
          );
        })}
      </ol>
      <button className={styles.reset} disabled={isDefault} onClick={() => saveNavOrder(null)} type="button">
        Reset to default
      </button>
    </section>
  );
};

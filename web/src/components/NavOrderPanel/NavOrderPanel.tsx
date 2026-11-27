import type { DragEvent } from "react";

import { useState } from "react";

import type { View } from "../Sidebar/Sidebar.tsx";

import { useNavOrder } from "../../hooks/useNavOrder.ts";
import { NAV_ITEMS, PINNED_MAX, PINNED_MIN, placeItem, saveNavOrder, savePinnedCount } from "../../lib/navLayout.ts";
import styles from "./NavOrderPanel.module.css";

/**
 * Settings → Menu: how many items are pinned in the sidebar (2 to 8, 2026-11-27), which, and their order. Drag a row, as in the
 * Mac's Settings → Sidebar menu, or use the arrows, which are also how a keyboard moves one. The
 * sidebar itself takes drags too.
 */
export const NavOrderPanel = () => {
  const { count, isDefault, order } = useNavOrder();
  const [dragging, setDragging] = useState<null | View>(null);
  const [dropAt, setDropAt] = useState<{ after: boolean; key: View } | null>(null);

  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    saveNavOrder(next);
  };

  const lowerHalf = (e: DragEvent<HTMLElement>): boolean => {
    const box = e.currentTarget.getBoundingClientRect();
    return e.clientY > box.top + box.height / 2;
  };

  const endDrag = (): void => {
    setDragging(null);
    setDropAt(null);
  };

  return (
    <section>
      <h2 className={styles.subhead}>Sidebar menu</h2>
      <label className={styles.countRow}>
        <span>Items in the menu</span>
        <select
          aria-label="How many items are pinned in the sidebar menu"
          className={styles.count}
          onChange={(e) => savePinnedCount(Number(e.target.value))}
          value={count}
        >
          {Array.from({ length: PINNED_MAX - PINNED_MIN + 1 }, (_, i) => PINNED_MIN + i).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <p className={styles.note}>
        Drag, or use the arrows. The first {count} are in the sidebar menu; the rest are under More.
      </p>
      <ol className={styles.list}>
        {order.map((key, index) => {
          const label = NAV_ITEMS.find((item) => item.key === key)?.label ?? key;
          const pinned = index < count;
          const drop = dropAt?.key === key && dragging !== key ? (dropAt.after ? styles.dropAfter : styles.dropBefore) : "";
          return (
            <li
              className={`${styles.row} ${drop} ${dragging === key ? styles.dragging : ""}`}
              draggable
              key={key}
              onDragEnd={endDrag}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                const after = lowerHalf(e);
                if (dropAt?.key !== key || dropAt.after !== after) setDropAt({ after, key });
              }}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", key);
                setDragging(key);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging) saveNavOrder(placeItem(order, dragging, key, lowerHalf(e)));
                endDrag();
              }}
            >
              <span aria-hidden="true" className={styles.grip}>
                ⠿
              </span>
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
      <button
        className={styles.reset}
        disabled={isDefault}
        onClick={() => {
          saveNavOrder(null);
          savePinnedCount(null);
        }}
        type="button"
      >
        Reset to default
      </button>
    </section>
  );
};

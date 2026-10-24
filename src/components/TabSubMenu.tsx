import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { iosMenu } from '../lib/motion';

export interface SubMenuItem {
  id: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  onSelect: () => void;
}

/**
 * The little menu that drops out of a tab (e.g. "Part without scan" → "Part review").
 * Drawn in a layer above the page (the tab bar scrolls sideways and would clip it) and anchored
 * to its tab: it grows out of the tab and shrinks back into it along the same path.
 */
export default function TabSubMenu({
  anchor,
  open,
  label,
  items,
  onPointerEnter,
  onPointerLeave,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  label: string;
  items: SubMenuItem[];
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Follow the tab (window resized, page or tab bar scrolled).
  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      setPos({ left: r.left, top: r.bottom + 6 });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchor]);

  return createPortal(
    <AnimatePresence>
      {open && pos && (
        <motion.div
          {...iosMenu}
          role="menu"
          aria-label={label}
          className="tab-submenu glass-modal"
          style={{ position: 'fixed', left: pos.left, top: pos.top, transformOrigin: '24px 0%' }}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              aria-current={item.active ? 'page' : undefined}
              className={`tab-submenu-item no-glass ${item.active ? 'is-active' : ''}`}
              onClick={item.onSelect}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

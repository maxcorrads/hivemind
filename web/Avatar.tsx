import type { CSSProperties } from "react";
import { avatarHue } from "./labels.ts";

/**
 * A rounded-square avatar with the author's initials on oklch(var(--avl) 0.06 hue), the hue derived from the
 * name so everyone keeps one colour everywhere. Bots get the neutral role-bot well instead.
 */
export function Avatar({ name, role, online, small, size }: {
  name: string;
  role?: string;
  online?: boolean;
  /** Same as size="sm". */
  small?: boolean;
  size?: "sm" | "xs";
}) {
  return (
    <span
      className={`avatar ${size ?? (small ? "sm" : "")} role-${role ?? ""}`}
      style={{ "--h": String(avatarHue(name)) } as CSSProperties}
      data-on={online ? "1" : undefined}
      title={name}
    >
      {name.slice(0, 2)}
    </span>
  );
}

import type { CSSProperties } from "react";
import { avatarHue } from "./labels.ts";

export function Avatar({ name, role, online, small }: { name: string; role?: string; online?: boolean; small?: boolean }) {
  return (
    <span
      className={`avatar ${small ? "sm" : ""} role-${role ?? ""}`}
      style={{ "--h": String(avatarHue(name)) } as CSSProperties}
      data-on={online ? "1" : undefined}
      title={name}
    >
      {name.slice(0, 2)}
    </span>
  );
}

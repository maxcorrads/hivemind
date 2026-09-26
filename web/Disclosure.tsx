import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

/** A <details> heading whose chevron turns when it opens (web/styles/thread.css). */
export function Disclosure({ children }: { children: ReactNode }) {
  return <summary className="disclosure"><ChevronRight size={14} aria-hidden="true" />{children}</summary>;
}

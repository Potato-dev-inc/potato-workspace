import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Draws its children (which fetch on mount) only once it has scrolled into view; once seen they stay. Without IntersectionObserver they draw at once. */
export function WhenSeen({ children, minHeight = 48 }: { children: ReactNode; minHeight?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: '120px' });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return seen ? <>{children}</> : <div ref={ref} style={{ minHeight }} aria-hidden="true" />;
}

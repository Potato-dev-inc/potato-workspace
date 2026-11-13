// Gives a value back at most once per `ms`. A change that comes sooner waits for the rest of the window, and the
// newest value is the one shown. Used so the board redraws at most once a second, however fast the activity lines change.
import { useEffect, useRef, useState } from 'react';

export function useThrottledValue<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  const latest = useRef(value);
  latest.current = value;

  useEffect(() => {
    const wait = last.current + ms - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      setShown(value);
      return undefined;
    }
    const timer = setTimeout(() => {
      last.current = Date.now();
      setShown(latest.current);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, ms]);

  return shown;
}

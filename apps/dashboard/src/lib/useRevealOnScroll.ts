/**
 * Batched, scroll-triggered reveal inside a panel's own scroll region (the Analytics requirements
 * feed). The `IntersectionObserver`'s `root` is the panel's scrolling element, not the page — the
 * default `root: null` would fire at the wrong times. No fetch: rows are already loaded.
 */
import { useEffect, useRef, useState, type RefCallback } from 'react';

export interface RevealOnScroll {
  /** How many of the caller's rows to render — always `<= total`. */
  visibleCount: number;
  /** Attach to the scrollable container — the `IntersectionObserver`'s `root`. */
  scrollRef: RefCallback<HTMLDivElement>;
  /** Attach to an empty element after the last rendered row. */
  sentinelRef: RefCallback<HTMLDivElement>;
}

/**
 * @param total - How many rows exist.
 * @param batchSize - Rows per reveal, and the initial count.
 * @param resetKey - Changes with the result set, resetting the revealed count.
 */
export function useRevealOnScroll(
  total: number,
  batchSize: number,
  resetKey: string | number,
): RevealOnScroll {
  const [visibleCount, setVisibleCount] = useState(batchSize);
  // State, not refs, for the DOM nodes: either may attach late, and the observer effect must
  // re-run.
  const [scrollNode, setScrollNode] = useState<HTMLDivElement | null>(null);
  const [sentinelNode, setSentinelNode] = useState<HTMLDivElement | null>(null);
  // Latest bounds for the observer callback without rebuilding the observer.
  const boundsRef = useRef({ batchSize, total });
  boundsRef.current = { batchSize, total };

  // Keyed on `resetKey` only: `batchSize` is a caller constant.
  useEffect(() => {
    setVisibleCount(batchSize);
  }, [resetKey]);

  useEffect(() => {
    if (!sentinelNode || !scrollNode) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        const { batchSize: currentBatch, total: currentTotal } = boundsRef.current;
        setVisibleCount((count) => Math.min(count + currentBatch, currentTotal));
      },
      { root: scrollNode },
    );
    observer.observe(sentinelNode);
    return () => observer.disconnect();
  }, [scrollNode, sentinelNode]);

  return {
    visibleCount: Math.min(visibleCount, total),
    scrollRef: setScrollNode,
    sentinelRef: setSentinelNode,
  };
}

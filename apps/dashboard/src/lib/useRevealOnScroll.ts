/**
 * Batched, scroll-triggered reveal for a long feed inside its own scroll region — the Analytics
 * requirements panel's alternative to the applications list's `?show=` / Load-more pattern.
 *
 * That pattern suits a short, flat list a click is proportionate to. A requirements read is
 * scanning a scrollable feed, and stopping to click every batch breaks that — so this grows the
 * visible count as the reader approaches the end, via an `IntersectionObserver` watching a sentinel
 * against the panel's *own* scrolling element, never the page's. The default `root: null` observes
 * the page's viewport, which would fire while the panel is scrolled internally but the page hasn't
 * moved, or never fire if the page never scrolls that far — getting `root` wrong is the whole bug
 * this hook exists to avoid.
 *
 * There is no fetch behind this: every row is already in the array the caller holds, so revealing
 * more is a synchronous slice. Nothing here reports a loading state, because there is no work in
 * flight to report.
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
 * @param total - How many rows exist to reveal.
 * @param batchSize - How many rows one reveal grows the count by, and the initial count.
 * @param resetKey - Changes whenever the underlying result set does (a stage, range or keyword
 *   selection change) — a revealed count belongs to that set and cannot be allowed to outlive it,
 *   the same rule `listPath` enforces for `?show=` on the applications list.
 */
export function useRevealOnScroll(
  total: number,
  batchSize: number,
  resetKey: string | number,
): RevealOnScroll {
  const [visibleCount, setVisibleCount] = useState(batchSize);
  // State, not `useRef`, for the two DOM nodes: a plain ref's assignment doesn't trigger a
  // re-render, so an observer effect keyed on it would only ever see whatever was attached at the
  // moment the effect first ran. Either node can legitimately attach late — a caller that mounts
  // this panel conditionally, or reorders when the scroll region itself renders — and a ref that
  // missed that moment had no way to notice it ever attached at all.
  const [scrollNode, setScrollNode] = useState<HTMLDivElement | null>(null);
  const [sentinelNode, setSentinelNode] = useState<HTMLDivElement | null>(null);
  // The observer callback closes over one render's `batchSize`/`total`; the ref keeps it reading
  // the latest values without forcing the observer itself to be torn down and rebuilt every time
  // either changes.
  const boundsRef = useRef({ batchSize, total });
  boundsRef.current = { batchSize, total };

  // Deliberately keyed on `resetKey` alone: `batchSize` is a caller-side constant, and reacting to
  // it here as well would collapse the reveal back to one batch on a render where nothing the
  // reader did actually changed.
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

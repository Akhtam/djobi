/**
 * jsdom has no `IntersectionObserver`, so this stubs one that hands the test its callback and lets
 * it fire an intersection by hand — the same seam a real one crossing into view would trigger.
 */
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRevealOnScroll } from './useRevealOnScroll';

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  observedRoot: Element | null;
  disconnected = false;
  constructor(
    private callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.observedRoot = (options?.root as Element | null) ?? null;
    FakeIntersectionObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  /** Fires the callback as if the sentinel just entered the viewport. */
  intersect() {
    this.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function Harness({
  total,
  batchSize,
  resetKey,
}: {
  total: number;
  batchSize: number;
  resetKey: string | number;
}) {
  const { visibleCount, scrollRef, sentinelRef } = useRevealOnScroll(total, batchSize, resetKey);
  return (
    <div ref={scrollRef}>
      <div data-testid="count">{visibleCount}</div>
      <div ref={sentinelRef} data-testid="sentinel" />
    </div>
  );
}

/** Mounts the scroll region only once `mounted` flips true, simulating a caller that attaches it late. */
function LateHarness({
  total,
  batchSize,
  resetKey,
  mounted,
}: {
  total: number;
  batchSize: number;
  resetKey: string | number;
  mounted: boolean;
}) {
  const { visibleCount, scrollRef, sentinelRef } = useRevealOnScroll(total, batchSize, resetKey);
  if (!mounted) return <div data-testid="count">{visibleCount}</div>;
  return (
    <div ref={scrollRef}>
      <div data-testid="count">{visibleCount}</div>
      <div ref={sentinelRef} data-testid="sentinel" />
    </div>
  );
}

function latestObserver(): FakeIntersectionObserver {
  return FakeIntersectionObserver.instances[FakeIntersectionObserver.instances.length - 1];
}

/** `intersect()` triggers a state update outside React's own event handling, same as a real one. */
function fireIntersect(): void {
  act(() => latestObserver().intersect());
}

describe('useRevealOnScroll', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeIntersectionObserver.instances.length = 0;
  });

  it('starts at one batch', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const { getByTestId } = render(<Harness total={45} batchSize={20} resetKey="a" />);

    expect(getByTestId('count').textContent).toBe('20');
  });

  it('caps the initial batch at the total when there are fewer rows than one batch', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const { getByTestId } = render(<Harness total={5} batchSize={20} resetKey="a" />);

    expect(getByTestId('count').textContent).toBe('5');
  });

  it('grows by one batch only once the sentinel intersects', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const { getByTestId } = render(<Harness total={45} batchSize={20} resetKey="a" />);

    expect(getByTestId('count').textContent).toBe('20');
    fireIntersect();
    expect(getByTestId('count').textContent).toBe('40');
  });

  it('does not grow past the total', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const { getByTestId } = render(<Harness total={45} batchSize={20} resetKey="a" />);

    fireIntersect();
    fireIntersect();
    fireIntersect();
    expect(getByTestId('count').textContent).toBe('45');
  });

  it('watches the scroll container, not the page, as the observer root', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    render(<Harness total={45} batchSize={20} resetKey="a" />);

    expect(latestObserver().observedRoot).not.toBeNull();
  });

  it('collapses back to the first batch when resetKey changes', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const { getByTestId, rerender } = render(<Harness total={45} batchSize={20} resetKey="a" />);

    fireIntersect();
    expect(getByTestId('count').textContent).toBe('40');

    rerender(<Harness total={45} batchSize={20} resetKey="b" />);
    expect(getByTestId('count').textContent).toBe('20');
  });

  it('does not reset when the result set is unchanged, only the count grows', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const { getByTestId, rerender } = render(<Harness total={45} batchSize={20} resetKey="a" />);

    fireIntersect();
    expect(getByTestId('count').textContent).toBe('40');

    rerender(<Harness total={45} batchSize={20} resetKey="a" />);
    expect(getByTestId('count').textContent).toBe('40');
  });

  it('still observes once the scroll region attaches after the first commit', () => {
    // Ref callbacks (not `useRef`) are what make this possible: a plain ref's assignment doesn't
    // itself trigger a re-render, so an observer effect keyed on it would only ever see whatever
    // was attached on the render the effect first ran.
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const { getByTestId, rerender } = render(
      <LateHarness total={45} batchSize={20} resetKey="a" mounted={false} />,
    );
    expect(FakeIntersectionObserver.instances).toHaveLength(0);

    rerender(<LateHarness total={45} batchSize={20} resetKey="a" mounted={true} />);
    expect(FakeIntersectionObserver.instances).toHaveLength(1);

    fireIntersect();
    expect(getByTestId('count').textContent).toBe('40');
  });
});

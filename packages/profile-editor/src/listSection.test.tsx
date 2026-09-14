import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ListSection } from './listSection.js';
import type { ListEditor } from './listEditing.js';
import type { ListSectionChrome } from './listSectionChrome.js';

// This package's vitest config runs with `globals: false`, so `@testing-library/react`'s own
// auto-cleanup (which hooks a global `afterEach`) never registers — without this, a later test's
// query can match an earlier test's still-mounted DOM. `@djobi/http-client`/`jest-dom` aren't
// dependencies of this package either, hence the plain `.textContent`/`toBeNull` assertions below
// rather than `toHaveTextContent`/`toBeInTheDocument`.
afterEach(cleanup);

/**
 * A minimal chrome — everything it renders carries a `data-testid` naming the piece under test,
 * not real markup. What matters here is that `ListSection` calls `Section`/`Entry` with the right
 * props, not what a real caller does with them; `options/App.test.tsx` and the dashboard's own
 * Profile tests are what exercise a real chrome end to end.
 */
const chrome: ListSectionChrome = {
  emptyClassName: 'test-empty',
  addButtonClassName: 'test-add',
  Section: ({ id, legend, hint, itemCount, children }) => (
    <div id={id}>
      <h2>{legend}</h2>
      {hint ? <p data-testid="hint">{hint}</p> : null}
      <span data-testid="item-count">{itemCount}</span>
      {children}
    </div>
  ),
  Entry: ({ index, noun, onRemove, summary, children }) => (
    <div data-testid={`entry-${index}`}>
      {summary ? <p data-testid={`summary-${index}`}>{summary}</p> : null}
      <button type="button" aria-label={`Remove ${noun} ${index + 1}`} onClick={onRemove}>
        Remove
      </button>
      {children}
    </div>
  ),
};

function fakeEditor(): ListEditor<string> & {
  remove: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
} {
  return { update: vi.fn(), remove: vi.fn(), add: vi.fn() };
}

describe('ListSection', () => {
  it('renders one Entry per item, in order, through the caller-provided chrome', () => {
    render(
      <ListSection
        chrome={chrome}
        id="skills"
        legend="Skills"
        noun="skill"
        addLabel="Add skill"
        items={['Rust', 'TypeScript']}
        editor={fakeEditor()}
      >
        {(entry) => <span>{entry}</span>}
      </ListSection>,
    );

    expect(screen.getByTestId('entry-0').textContent).toContain('Rust');
    expect(screen.getByTestId('entry-1').textContent).toContain('TypeScript');
  });

  it('passes items.length to Section as itemCount, whatever the chrome does with it', () => {
    render(
      <ListSection
        chrome={chrome}
        id="skills"
        legend="Skills"
        noun="skill"
        addLabel="Add skill"
        items={['Rust', 'TypeScript', 'Go']}
        editor={fakeEditor()}
      >
        {(entry) => <span>{entry}</span>}
      </ListSection>,
    );

    expect(screen.getByTestId('item-count').textContent).toBe('3');
  });

  it('shows the empty-state message through emptyClassName when there are no items', () => {
    const { container } = render(
      <ListSection
        chrome={chrome}
        id="skills"
        legend="Skills"
        noun="skill"
        addLabel="Add skill"
        items={[]}
        editor={fakeEditor()}
      >
        {(entry) => <span>{entry}</span>}
      </ListSection>,
    );

    const empty = container.querySelector('.test-empty');
    expect(empty?.textContent).toBe('No skill added yet.');
    expect(screen.queryByTestId('entry-0')).toBeNull();
  });

  it("wires the Remove button to editor.remove at that entry's own index", () => {
    const editor = fakeEditor();
    render(
      <ListSection
        chrome={chrome}
        id="skills"
        legend="Skills"
        noun="skill"
        addLabel="Add skill"
        items={['Rust', 'TypeScript']}
        editor={editor}
      >
        {(entry) => <span>{entry}</span>}
      </ListSection>,
    );

    screen.getByRole('button', { name: 'Remove skill 2' }).click();

    expect(editor.remove).toHaveBeenCalledTimes(1);
    expect(editor.remove).toHaveBeenCalledWith(1);
  });

  it('wires the Add button to editor.add', () => {
    const editor = fakeEditor();
    const { container } = render(
      <ListSection
        chrome={chrome}
        id="skills"
        legend="Skills"
        noun="skill"
        addLabel="Add skill"
        items={[]}
        editor={editor}
      >
        {(entry) => <span>{entry}</span>}
      </ListSection>,
    );

    container.querySelector<HTMLButtonElement>('.test-add')!.click();

    expect(editor.add).toHaveBeenCalledOnce();
  });

  it('passes summary(entry, index) through to Entry, and omits it entirely when no summary prop is given', () => {
    const { rerender, unmount } = render(
      <ListSection
        chrome={chrome}
        id="stories"
        legend="Stories"
        noun="story"
        addLabel="Add story"
        items={['Migrated the billing service']}
        editor={fakeEditor()}
        summary={(entry) => `Summary: ${entry}`}
      >
        {(entry) => <span>{entry}</span>}
      </ListSection>,
    );

    expect(screen.getByTestId('summary-0').textContent).toBe(
      'Summary: Migrated the billing service',
    );

    rerender(
      <ListSection
        chrome={chrome}
        id="stories"
        legend="Stories"
        noun="story"
        addLabel="Add story"
        items={['Migrated the billing service']}
        editor={fakeEditor()}
      >
        {(entry) => <span>{entry}</span>}
      </ListSection>,
    );

    expect(screen.queryByTestId('summary-0')).toBeNull();
    unmount();
  });
});

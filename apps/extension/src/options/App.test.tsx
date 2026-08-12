import type { Profile } from '@djobi/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const emptyProfile: Profile = {
  fullName: '',
  email: '',
  phone: null,
  location: null,
  links: { linkedin: null, portfolio: null, github: null },
  workExperience: [],
  education: [],
  skills: [],
  stories: [],
};

/** Stubs `chrome.runtime.sendMessage`, the external boundary the options page talks through. */
function stubBackendResponse(response: { data?: unknown; error?: string }) {
  const sendMessage = vi.fn(
    (_message: unknown, callback: (response: unknown) => void) => callback(response),
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  return sendMessage;
}

interface BackendMessage {
  path: string;
  body: unknown;
  method?: 'GET' | 'POST';
}

/**
 * Stubs GET /profile with `get()` and POST /profile with either `post(body)` (echoing `body` by
 * default) or a `postError` message.
 */
function stubBackend(handlers: {
  get: () => unknown;
  post?: (body: unknown) => unknown;
  postError?: string;
}) {
  const sendMessage = vi.fn(
    (message: BackendMessage, callback: (response: { data?: unknown; error?: string }) => void) => {
      if (message.method === 'GET') {
        callback({ data: handlers.get() });
      } else if (handlers.postError) {
        callback({ error: handlers.postError });
      } else {
        callback({ data: (handlers.post ?? ((body: unknown) => body))(message.body) });
      }
    },
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  return sendMessage;
}

describe('options App', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the stored profile via GET /profile and renders its full name', async () => {
    const sendMessage = stubBackendResponse({
      data: { ...emptyProfile, fullName: 'Jane Doe', email: 'jane@example.com' },
    });

    render(<App />);

    expect(await screen.findByLabelText('Full name')).toHaveValue('Jane Doe');
    expect(sendMessage).toHaveBeenCalledWith(
      { path: '/profile', body: undefined, method: 'GET' },
      expect.any(Function),
    );
  });

  it('renders an empty form when no profile has been saved yet', async () => {
    stubBackendResponse({ data: null });

    render(<App />);

    expect(await screen.findByLabelText('Full name')).toHaveValue('');
  });

  it('edits scalar profile fields and saves them via POST /profile', async () => {
    const loaded: Profile = { ...emptyProfile, fullName: 'Jane Doe', email: 'jane@old.com' };
    const sendMessage = stubBackend({ get: () => loaded });

    render(<App />);
    await screen.findByLabelText('Full name');

    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Jane A. Doe' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'jane@new.com' } });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '555-1234' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Remote' } });
    fireEvent.change(screen.getByLabelText('LinkedIn'), {
      target: { value: 'https://linkedin.com/in/jane' },
    });
    fireEvent.change(screen.getByLabelText('Portfolio'), { target: { value: 'https://jane.dev' } });
    fireEvent.change(screen.getByLabelText('GitHub'), {
      target: { value: 'https://github.com/jane' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await screen.findByText('Profile saved.');

    expect(sendMessage).toHaveBeenLastCalledWith(
      {
        path: '/profile',
        body: {
          ...loaded,
          fullName: 'Jane A. Doe',
          email: 'jane@new.com',
          phone: '555-1234',
          location: 'Remote',
          links: {
            linkedin: 'https://linkedin.com/in/jane',
            portfolio: 'https://jane.dev',
            github: 'https://github.com/jane',
          },
        },
      },
      expect.any(Function),
    );
  });

  it('adds and removes skills, and saves the resulting list', async () => {
    const loaded: Profile = { ...emptyProfile, fullName: 'Jane Doe', skills: ['TypeScript'] };
    const sendMessage = stubBackend({ get: () => loaded });

    render(<App />);
    await screen.findByLabelText('Full name');

    expect(screen.getByText('TypeScript')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('New skill'), { target: { value: 'React' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }));

    expect(screen.getByText('React')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove TypeScript' }));

    expect(screen.queryByText('TypeScript')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile saved.');

    expect(sendMessage).toHaveBeenLastCalledWith(
      { path: '/profile', body: { ...loaded, skills: ['React'] } },
      expect.any(Function),
    );
  });

  it('adds a work experience entry, edits its fields, and saves it', async () => {
    const loaded: Profile = { ...emptyProfile, fullName: 'Jane Doe', workExperience: [] };
    const sendMessage = stubBackend({ get: () => loaded });

    render(<App />);
    await screen.findByLabelText('Full name');

    fireEvent.click(screen.getByRole('button', { name: 'Add work experience' }));

    fireEvent.change(screen.getByLabelText('Company 1'), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByLabelText('Title 1'), { target: { value: 'Senior Engineer' } });
    fireEvent.change(screen.getByLabelText('Start date 1'), { target: { value: '2022-01' } });
    fireEvent.change(screen.getByLabelText('End date 1'), { target: { value: '2023-06' } });

    fireEvent.click(screen.getByRole('button', { name: '+ Add bullet' }));
    fireEvent.change(screen.getByLabelText('Bullet 1.1'), { target: { value: 'Shipped X' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add bullet' }));
    fireEvent.change(screen.getByLabelText('Bullet 1.2'), { target: { value: 'Led Y' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile saved.');

    expect(sendMessage).toHaveBeenLastCalledWith(
      {
        path: '/profile',
        body: {
          ...loaded,
          workExperience: [
            {
              company: 'Acme',
              title: 'Senior Engineer',
              startDate: '2022-01',
              endDate: '2023-06',
              bullets: ['Shipped X', 'Led Y'],
            },
          ],
        },
      },
      expect.any(Function),
    );
  });

  it('removes a bullet from a work experience entry and drops blank bullets on save', async () => {
    const loaded: Profile = { ...emptyProfile, fullName: 'Jane Doe', workExperience: [] };
    const sendMessage = stubBackend({ get: () => loaded });

    render(<App />);
    await screen.findByLabelText('Full name');

    fireEvent.click(screen.getByRole('button', { name: 'Add work experience' }));

    fireEvent.click(screen.getByRole('button', { name: '+ Add bullet' }));
    fireEvent.change(screen.getByLabelText('Bullet 1.1'), { target: { value: 'Shipped X' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add bullet' }));
    fireEvent.change(screen.getByLabelText('Bullet 1.2'), { target: { value: 'Led Y' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add bullet' }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove bullet 1.2' }));

    expect(screen.queryByLabelText('Bullet 1.2')).not.toHaveValue('Led Y');

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile saved.');

    expect(sendMessage).toHaveBeenLastCalledWith(
      {
        path: '/profile',
        body: {
          ...loaded,
          workExperience: [
            {
              company: '',
              title: '',
              startDate: '',
              endDate: null,
              bullets: ['Shipped X'],
            },
          ],
        },
      },
      expect.any(Function),
    );
  });

  it('removes a work experience entry', async () => {
    const loaded: Profile = {
      ...emptyProfile,
      workExperience: [
        { company: 'Acme', title: 'Engineer', startDate: '2022-01', endDate: null, bullets: [] },
      ],
    };
    stubBackend({ get: () => loaded });

    render(<App />);
    await screen.findByLabelText('Full name');

    expect(screen.getByLabelText('Company 1')).toHaveValue('Acme');

    fireEvent.click(screen.getByRole('button', { name: 'Remove work experience 1' }));

    expect(screen.queryByLabelText('Company 1')).not.toBeInTheDocument();
  });

  it('adds an education entry, edits its fields, and saves it', async () => {
    const loaded: Profile = { ...emptyProfile, fullName: 'Jane Doe', education: [] };
    const sendMessage = stubBackend({ get: () => loaded });

    render(<App />);
    await screen.findByLabelText('Full name');

    fireEvent.click(screen.getByRole('button', { name: 'Add education' }));

    fireEvent.change(screen.getByLabelText('School 1'), { target: { value: 'State U' } });
    fireEvent.change(screen.getByLabelText('Degree 1'), { target: { value: 'BSc' } });
    fireEvent.change(screen.getByLabelText('Field 1'), {
      target: { value: 'Computer Science' },
    });
    fireEvent.change(screen.getByLabelText('Graduation year 1'), { target: { value: '2020' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile saved.');

    expect(sendMessage).toHaveBeenLastCalledWith(
      {
        path: '/profile',
        body: {
          ...loaded,
          education: [
            { school: 'State U', degree: 'BSc', field: 'Computer Science', graduationYear: '2020' },
          ],
        },
      },
      expect.any(Function),
    );
  });

  it('removes an education entry', async () => {
    const loaded: Profile = {
      ...emptyProfile,
      education: [{ school: 'State U', degree: 'BSc', field: null, graduationYear: null }],
    };
    stubBackend({ get: () => loaded });

    render(<App />);
    await screen.findByLabelText('Full name');

    expect(screen.getByLabelText('School 1')).toHaveValue('State U');

    fireEvent.click(screen.getByRole('button', { name: 'Remove education 1' }));

    expect(screen.queryByLabelText('School 1')).not.toBeInTheDocument();
  });

  it('adds a story entry, edits its fields, and saves it', async () => {
    const loaded: Profile = { ...emptyProfile, fullName: 'Jane Doe', stories: [] };
    const sendMessage = stubBackend({ get: () => loaded });

    render(<App />);
    await screen.findByLabelText('Full name');

    fireEvent.click(screen.getByRole('button', { name: 'Add story' }));

    fireEvent.change(screen.getByLabelText('Story id 1'), { target: { value: 'billing-migration' } });
    fireEvent.change(screen.getByLabelText('Story title 1'), {
      target: { value: 'Migrated the billing service under a hard deadline' },
    });
    fireEvent.change(screen.getByLabelText('Story tags 1'), {
      target: { value: 'leadership, incident-response' },
    });
    fireEvent.change(screen.getByLabelText('Situation 1'), { target: { value: 'Legacy system.' } });
    fireEvent.change(screen.getByLabelText('Task 1'), { target: { value: 'Migrate it.' } });
    fireEvent.change(screen.getByLabelText('Action 1'), { target: { value: 'Led the rollout.' } });
    fireEvent.change(screen.getByLabelText('Result 1'), { target: { value: 'Zero downtime.' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile saved.');

    expect(sendMessage).toHaveBeenLastCalledWith(
      {
        path: '/profile',
        body: {
          ...loaded,
          stories: [
            {
              id: 'billing-migration',
              title: 'Migrated the billing service under a hard deadline',
              tags: ['leadership', 'incident-response'],
              situation: 'Legacy system.',
              task: 'Migrate it.',
              action: 'Led the rollout.',
              result: 'Zero downtime.',
            },
          ],
        },
      },
      expect.any(Function),
    );
  });

  it('removes a story entry', async () => {
    const loaded: Profile = {
      ...emptyProfile,
      stories: [
        {
          id: 'billing-migration',
          title: 'Migrated the billing service',
          tags: [],
          situation: '',
          task: '',
          action: '',
          result: '',
        },
      ],
    };
    stubBackend({ get: () => loaded });

    render(<App />);
    await screen.findByLabelText('Full name');

    expect(screen.getByLabelText('Story id 1')).toHaveValue('billing-migration');

    fireEvent.click(screen.getByRole('button', { name: 'Remove story 1' }));

    expect(screen.queryByLabelText('Story id 1')).not.toBeInTheDocument();
  });

  it('shows an error message when saving fails', async () => {
    stubBackend({
      get: () => ({ ...emptyProfile, fullName: 'Jane Doe' }),
      postError: 'Backend unreachable',
    });

    render(<App />);
    await screen.findByLabelText('Full name');
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await screen.findByText('Backend unreachable');
  });
});

import type { Profile } from '@djobi/shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBackendClient, type BackendClient } from '../lib/backendClient';
import { App } from './App';

/**
 * The options page's one external seam, replaced whole.
 *
 * `createFakeBackendClient` satisfies the same `BackendClient` that `options/main.tsx` hands the
 * HTTP adapter to, so these tests cross the seam the page actually has. They used to replace the
 * transport *under* the client and assert on `'/profile'` paths and HTTP methods — which passes
 * whenever the page sends the right URL, whatever it asked for.
 */
let getProfile: ReturnType<typeof vi.fn>;
let saveProfile: ReturnType<typeof vi.fn>;
let client: BackendClient;

/** Builds the fake from the two operations this page uses, and keeps the spies to assert on. */
function fakeBackend(handlers: {
  get: () => unknown;
  save: (profile: unknown) => unknown;
}): BackendClient {
  // `async` rather than `Promise.resolve(...)`: a handler that throws must reach the page as a
  // rejected promise, which is how the real adapter reports a backend failure.
  getProfile = vi.fn(async () => handlers.get());
  saveProfile = vi.fn(async (profile: unknown) => handlers.save(profile));
  return createFakeBackendClient({
    getProfile,
    saveProfile,
  } as Partial<BackendClient>);
}

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
  screeningAnswers: {},
  customAnswers: [],
};

/** Answers every call with `response`, or rejects when given `{ error }`. */
function stubBackendResponse(response: { data?: unknown; error?: string }) {
  const answer = () => {
    if (response.error) throw new Error(response.error);
    return response.data;
  };
  client = fakeBackend({ get: answer, save: answer });
}

/**
 * Stubs the stored profile with `get()` and the save with either `post(profile)` (echoing it by
 * default) or a `postError` message.
 */
function stubBackend(handlers: {
  get: () => unknown;
  post?: (body: unknown) => unknown;
  postError?: string;
}) {
  client = fakeBackend({
    get: handlers.get,
    save: (profile) => {
      if (handlers.postError) throw new Error(handlers.postError);
      return (handlers.post ?? ((echoed: unknown) => echoed))(profile);
    },
  });
}

describe('options App', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    client = fakeBackend({ get: () => null, save: (profile) => profile });
  });

  it('fetches the stored profile via GET /profile and renders its full name', async () => {
    stubBackendResponse({
      data: { ...emptyProfile, fullName: 'Jane Doe', email: 'jane@example.com' },
    });

    render(<App client={client} />);

    expect(await screen.findByLabelText('Full name')).toHaveValue('Jane Doe');
    expect(getProfile).toHaveBeenCalled();
  });

  it('renders an empty form when no profile has been saved yet', async () => {
    stubBackendResponse({ data: null });

    render(<App client={client} />);

    expect(await screen.findByLabelText('Full name')).toHaveValue('');
  });

  it('edits scalar profile fields and saves them via POST /profile', async () => {
    const loaded: Profile = { ...emptyProfile, fullName: 'Jane Doe', email: 'jane@old.com' };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
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

    expect(saveProfile).toHaveBeenLastCalledWith({
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
    });
  });

  it('does not discard edits made while an older profile snapshot is saving', async () => {
    const loaded: Profile = { ...emptyProfile, fullName: 'Jane Doe' };
    let finishSave: ((profile: Profile) => void) | undefined;
    const pendingSave = new Promise<Profile>((resolve) => {
      finishSave = resolve;
    });
    client = fakeBackend({ get: () => loaded, save: () => pendingSave });

    render(<App client={client} />);
    const fullName = await screen.findByLabelText('Full name');
    fireEvent.change(fullName, { target: { value: 'Jane Saved' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(saveProfile).toHaveBeenCalledWith({ ...loaded, fullName: 'Jane Saved' });
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    fireEvent.change(fullName, { target: { value: 'Jane Latest' } });

    await act(async () => finishSave?.({ ...loaded, fullName: 'Jane Saved' }));

    expect(fullName).toHaveValue('Jane Latest');
    expect(screen.getByText('You have unsaved changes.')).toBeInTheDocument();
    expect(screen.queryByText('Profile saved.')).not.toBeInTheDocument();
  });

  it('saves a cleared optional field as null, not as an empty string the rest of the system has to treat as absent', async () => {
    const loaded: Profile = {
      ...emptyProfile,
      fullName: 'Jane Doe',
      phone: '555-1234',
      location: 'Remote',
      links: { linkedin: 'https://linkedin.com/in/jane', portfolio: null, github: null },
    };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
    await screen.findByDisplayValue('Jane Doe');

    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('LinkedIn'), { target: { value: '   ' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile saved.');

    expect(saveProfile).toHaveBeenLastCalledWith({
      ...loaded,
      phone: null,
      links: { ...loaded.links, linkedin: null },
    });
  });

  it('adds and removes skills, and saves the resulting list', async () => {
    const loaded: Profile = { ...emptyProfile, fullName: 'Jane Doe', skills: ['TypeScript'] };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
    await screen.findByLabelText('Full name');

    expect(screen.getByText('TypeScript')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('New skill'), { target: { value: 'React' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }));

    expect(screen.getByText('React')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove TypeScript' }));

    expect(screen.queryByText('TypeScript')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile saved.');

    expect(saveProfile).toHaveBeenLastCalledWith({ ...loaded, skills: ['React'] });
  });

  it('adds a work experience entry, edits its fields, and saves it', async () => {
    const loaded: Profile = { ...emptyProfile, fullName: 'Jane Doe', workExperience: [] };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
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

    expect(saveProfile).toHaveBeenLastCalledWith({
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
    });
  });

  it('removes a bullet from a work experience entry and drops blank bullets on save', async () => {
    const loaded: Profile = { ...emptyProfile, fullName: 'Jane Doe', workExperience: [] };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
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

    expect(saveProfile).toHaveBeenLastCalledWith({
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
    });
  });

  it('removes a work experience entry', async () => {
    const loaded: Profile = {
      ...emptyProfile,
      workExperience: [
        { company: 'Acme', title: 'Engineer', startDate: '2022-01', endDate: null, bullets: [] },
      ],
    };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
    await screen.findByLabelText('Full name');

    expect(screen.getByLabelText('Company 1')).toHaveValue('Acme');

    fireEvent.click(screen.getByRole('button', { name: 'Remove work experience 1' }));

    expect(screen.queryByLabelText('Company 1')).not.toBeInTheDocument();
  });

  it('adds an education entry, edits its fields, and saves it', async () => {
    const loaded: Profile = { ...emptyProfile, fullName: 'Jane Doe', education: [] };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
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

    expect(saveProfile).toHaveBeenLastCalledWith({
      ...loaded,
      education: [
        { school: 'State U', degree: 'BSc', field: 'Computer Science', graduationYear: '2020' },
      ],
    });
  });

  it('removes an education entry', async () => {
    const loaded: Profile = {
      ...emptyProfile,
      education: [{ school: 'State U', degree: 'BSc', field: null, graduationYear: null }],
    };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
    await screen.findByLabelText('Full name');

    expect(screen.getByLabelText('School 1')).toHaveValue('State U');

    fireEvent.click(screen.getByRole('button', { name: 'Remove education 1' }));

    expect(screen.queryByLabelText('School 1')).not.toBeInTheDocument();
  });

  it('adds a story entry, edits its fields, and saves it', async () => {
    const loaded: Profile = { ...emptyProfile, fullName: 'Jane Doe', stories: [] };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
    await screen.findByLabelText('Full name');

    fireEvent.click(screen.getByRole('button', { name: 'Add story' }));

    fireEvent.change(screen.getByLabelText('Story id 1'), {
      target: { value: 'billing-migration' },
    });
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

    expect(saveProfile).toHaveBeenLastCalledWith({
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
    });
  });

  it('assigns a stable id when a story is added', async () => {
    stubBackend({ get: () => ({ ...emptyProfile, stories: [] }) });

    render(<App client={client} />);
    await screen.findByLabelText('Full name');
    fireEvent.click(screen.getByRole('button', { name: 'Add story' }));

    expect((screen.getByLabelText('Story id 1') as HTMLInputElement).value).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it('repairs blank and duplicate story ids with stable unique UUIDs on save', async () => {
    const generatedIds = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ];
    const randomUUID = vi.fn(
      () => generatedIds.shift() as `${string}-${string}-${string}-${string}-${string}`,
    );
    vi.stubGlobal('crypto', { randomUUID });
    const story = {
      title: '',
      tags: [],
      situation: '',
      task: '',
      action: '',
      result: '',
    };
    const loaded: Profile = {
      ...emptyProfile,
      stories: [
        { ...story, id: '' },
        { ...story, id: 'duplicate' },
        { ...story, id: 'duplicate' },
      ],
    };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
    await screen.findByLabelText('Story id 1');
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile saved.');

    const savedIds = [1, 2, 3].map(
      (index) => (screen.getByLabelText(`Story id ${index}`) as HTMLInputElement).value,
    );
    expect(savedIds).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ]);
    expect(new Set(savedIds).size).toBe(3);

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await vi.waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(2));
    expect(randomUUID).toHaveBeenCalledTimes(3);
    expect(screen.getByLabelText('Story id 1')).toHaveValue(savedIds[0]);
  });

  it('preserves existing unique nonblank story ids on save', async () => {
    const loaded: Profile = {
      ...emptyProfile,
      stories: [
        {
          id: ' existing-unique-id ',
          title: '',
          tags: [],
          situation: '',
          task: '',
          action: '',
          result: '',
        },
      ],
    };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
    await screen.findByLabelText('Story id 1');
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile saved.');

    expect(saveProfile).toHaveBeenLastCalledWith(loaded);
    expect(screen.getByLabelText('Story id 1')).toHaveValue(' existing-unique-id ');
  });

  it('gives each repeated entry fieldset a direct accessible legend', async () => {
    const loaded: Profile = {
      ...emptyProfile,
      workExperience: [{ company: '', title: '', startDate: '', endDate: null, bullets: [] }],
      education: [{ school: '', degree: '', field: null, graduationYear: null }],
      customAnswers: [{ question: '', answer: '' }],
      stories: [
        {
          id: 'story-1',
          title: '',
          tags: [],
          situation: '',
          task: '',
          action: '',
          result: '',
        },
      ],
    };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
    await screen.findByLabelText('Full name');

    for (const name of ['work experience 1', 'education 1', 'prepared answer 1', 'story 1']) {
      const fieldset = screen.getByRole('group', { name });
      expect(fieldset.firstElementChild).toHaveProperty('tagName', 'LEGEND');
    }
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

    render(<App client={client} />);
    await screen.findByLabelText('Full name');

    expect(screen.getByLabelText('Story id 1')).toHaveValue('billing-migration');

    fireEvent.click(screen.getByRole('button', { name: 'Remove story 1' }));

    expect(screen.queryByLabelText('Story id 1')).not.toBeInTheDocument();
  });

  it('renders a profile stored before prepared answers existed, rather than crashing on the missing keys', async () => {
    // Exactly what the backend returns for a row written before these fields were added.
    const legacy = { ...emptyProfile, fullName: 'Jane Doe' } as Partial<Profile>;
    delete legacy.screeningAnswers;
    delete legacy.customAnswers;
    stubBackend({ get: () => legacy });

    render(<App client={client} />);

    expect(await screen.findByLabelText('Full name')).toHaveValue('Jane Doe');
    expect(
      screen.getByLabelText('Will you now or in the future require visa sponsorship?'),
    ).toHaveValue('');
  });

  it('saves a screening answer under its topic', async () => {
    const loaded = { ...emptyProfile, fullName: 'Jane Doe' };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
    await screen.findByLabelText('Full name');

    fireEvent.change(
      screen.getByLabelText('Will you now or in the future require visa sponsorship?'),
      { target: { value: 'No' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await screen.findByText('Profile saved.');
    expect(saveProfile).toHaveBeenLastCalledWith({
      ...loaded,
      screeningAnswers: { sponsorship_required: 'No' },
    });
  });

  it('drops a screening answer that is cleared, so a blank row reads as unanswered rather than answered with nothing', async () => {
    const loaded = {
      ...emptyProfile,
      fullName: 'Jane Doe',
      screeningAnswers: { sponsorship_required: 'No' },
    };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
    await screen.findByLabelText('Full name');

    fireEvent.change(
      screen.getByLabelText('Will you now or in the future require visa sponsorship?'),
      { target: { value: '' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await screen.findByText('Profile saved.');
    expect(saveProfile).toHaveBeenLastCalledWith({ ...loaded, screeningAnswers: {} });
  });

  it('adds a custom prepared answer', async () => {
    const loaded = { ...emptyProfile, fullName: 'Jane Doe' };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
    await screen.findByLabelText('Full name');

    fireEvent.click(screen.getByRole('button', { name: 'Add prepared answer' }));
    fireEvent.change(screen.getByLabelText('Question'), {
      target: { value: 'How did you hear about us?' },
    });
    fireEvent.change(screen.getByLabelText('Answer'), { target: { value: 'LinkedIn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await screen.findByText('Profile saved.');
    expect(saveProfile).toHaveBeenLastCalledWith({
      ...loaded,
      customAnswers: [{ question: 'How did you hear about us?', answer: 'LinkedIn' }],
    });
  });

  it('shows an error message when saving fails', async () => {
    stubBackend({
      get: () => ({ ...emptyProfile, fullName: 'Jane Doe' }),
      postError: 'Backend unreachable',
    });

    render(<App client={client} />);
    await screen.findByLabelText('Full name');
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await screen.findByText('Backend unreachable');
  });
});

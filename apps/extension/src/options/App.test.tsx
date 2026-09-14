import type { ExtractedProfile, Profile } from '@djobi/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeBackendClient,
  withSessionRecovery,
  type BackendClient,
} from '../lib/backendClient';
import { HttpError } from '../lib/callBackend';
import { fakeSessionStorage } from '../lib/fakeSessionStorage';
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

/**
 * Builds the fake from the two operations this page uses, and keeps the spies to assert on.
 *
 * Wrapped in `withSessionRecovery`, the same as `main.tsx` wraps the real `httpBackendClient`:
 * production never hands the options page an undecorated client, and this is what lets the "adopts
 * a session found in the dashboard's shared cookie" case below exercise the real retry.
 */
function fakeBackend(handlers: {
  get: () => unknown;
  save: (profile: unknown) => unknown;
}): BackendClient {
  // `async` rather than `Promise.resolve(...)`: a handler that throws must reach the page as a
  // rejected promise, which is how the real adapter reports a backend failure.
  getProfile = vi.fn(async () => handlers.get());
  saveProfile = vi.fn(async (profile: unknown) => handlers.save(profile));
  return withSessionRecovery(
    createFakeBackendClient({
      getProfile,
      saveProfile,
    } as Partial<BackendClient>),
  );
}

/**
 * `chrome.storage`, both areas: `session` (the real bearer token — `adoptSharedSession` writes
 * through here) and a minimal `local` (`useThemePreference`, which every page reads on mount
 * regardless of what a given test is about). One `onChanged` registry, as real Chrome has, from
 * `fakeSessionStorage` — theme's own listener add/remove no-ops against it harmlessly.
 */
function minimalLocalStorage() {
  const { session, onChanged } = fakeSessionStorage();
  return {
    session,
    onChanged,
    local: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
    },
  };
}

const emptyProfile: Profile = {
  fullName: '',
  email: '',
  phone: null,
  location: null,
  links: { linkedin: null, portfolio: null, github: null },
  summary: null,
  workExperience: [],
  maxBulletsPerRole: 6,
  resumePageSize: 'A4',
  showRolePrefix: true,
  education: [],
  projects: [],
  certifications: [],
  awards: [],
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

  it('edits and saves resume PDF preferences', async () => {
    const loaded: Profile = { ...emptyProfile, fullName: 'Jane Doe' };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
    await screen.findByLabelText('Full name');

    expect(screen.getByLabelText('Page size')).toHaveValue('A4');
    expect(screen.getByLabelText('Prefix titles with “Role:”')).toBeChecked();

    fireEvent.change(screen.getByLabelText('Page size'), { target: { value: 'LETTER' } });
    fireEvent.click(screen.getByLabelText('Prefix titles with “Role:”'));
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile saved.');

    expect(saveProfile).toHaveBeenLastCalledWith({
      ...loaded,
      resumePageSize: 'LETTER',
      showRolePrefix: false,
    });
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
          maxBullets: null,
          starredIndices: [],
          suppressIfEmpty: false,
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
          maxBullets: null,
          starredIndices: [],
          suppressIfEmpty: false,
        },
      ],
    });
  });

  // The Remove mechanic itself — one click removes the right entry — is `ListSection`'s own
  // concern now, tested once at its interface in `@djobi/profile-editor`'s `listSection.test.tsx`.
  // This is the one representative check left here confirming this page is actually wired to it;
  // `removes a certification-or-award row` below stays too, since it exercises the combined
  // certifications/awards dispatcher's own index mapping, not just the mechanic.
  it('removes a work experience entry', async () => {
    const loaded: Profile = {
      ...emptyProfile,
      workExperience: [
        {
          company: 'Acme',
          title: 'Engineer',
          startDate: '2022-01',
          endDate: null,
          bullets: [],
          maxBullets: null,
          starredIndices: [],
          suppressIfEmpty: false,
        },
      ],
    };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
    await screen.findByLabelText('Full name');

    expect(screen.getByLabelText('Company 1')).toHaveValue('Acme');

    fireEvent.click(screen.getByRole('button', { name: 'Remove work experience 1' }));

    expect(screen.queryByLabelText('Company 1')).not.toBeInTheDocument();
  });

  it('edits bullet caps and stars while keeping star indices valid after deletion', async () => {
    const loaded: Profile = {
      ...emptyProfile,
      workExperience: [
        {
          company: 'Acme',
          title: 'Senior Engineer',
          startDate: '2022-01',
          endDate: null,
          bullets: ['First authored bullet', 'Second authored bullet', 'Third authored bullet'],
          maxBullets: null,
          starredIndices: [1],
          suppressIfEmpty: false,
        },
      ],
    };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
    await screen.findByLabelText('Full name');

    expect(screen.getByLabelText('Default bullets per role')).toHaveValue(6);
    expect(screen.getByLabelText('Bullet cap 1')).toHaveValue(null);
    expect(screen.getByText(/3 bullets.*1 starred/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Unstar bullet 1.2' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.change(screen.getByLabelText('Default bullets per role'), {
      target: { value: '5' },
    });
    fireEvent.change(screen.getByLabelText('Bullet cap 1'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Star bullet 1.3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove bullet 1.1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile saved.');

    expect(saveProfile).toHaveBeenLastCalledWith({
      ...loaded,
      maxBulletsPerRole: 5,
      workExperience: [
        {
          ...loaded.workExperience[0],
          bullets: ['Second authored bullet', 'Third authored bullet'],
          maxBullets: 2,
          starredIndices: [0, 1],
        },
      ],
    });
  });

  it('toggles suppressIfEmpty, the explicit opt-in to hide a role tailoring selects no bullets for', async () => {
    const loaded: Profile = {
      ...emptyProfile,
      workExperience: [
        {
          company: 'Acme',
          title: 'Senior Engineer',
          startDate: '2022-01',
          endDate: null,
          bullets: ['Only bullet'],
          maxBullets: null,
          starredIndices: [],
          suppressIfEmpty: false,
        },
      ],
    };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
    await screen.findByLabelText('Full name');

    const toggle = screen.getByLabelText(/Hide role 1 entirely if tailoring selects no bullets/);
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    expect(toggle).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile saved.');

    expect(saveProfile).toHaveBeenLastCalledWith({
      ...loaded,
      workExperience: [{ ...loaded.workExperience[0], suppressIfEmpty: true }],
    });
  });

  it('lets each work role collapse without hiding its authored summary', async () => {
    const loaded: Profile = {
      ...emptyProfile,
      workExperience: [
        {
          company: 'Acme',
          title: 'Engineer',
          startDate: '2022-01',
          endDate: null,
          bullets: ['Built systems'],
          maxBullets: null,
          starredIndices: [],
          suppressIfEmpty: false,
        },
      ],
    };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
    const summary = await screen.findByText(/Engineer at Acme/);
    expect(screen.getByLabelText('Company 1')).toBeVisible();

    fireEvent.click(summary);

    expect(summary).toBeVisible();
    expect(screen.getByLabelText('Company 1')).not.toBeVisible();
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

  it('adds a certification-or-award row, defaults it to a certification, and saves it', async () => {
    const loaded: Profile = {
      ...emptyProfile,
      fullName: 'Jane Doe',
      certifications: [],
      awards: [],
    };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
    await screen.findByLabelText('Full name');

    fireEvent.click(screen.getByRole('button', { name: 'Add certification or award' }));

    expect(screen.getByLabelText('Type 1')).toHaveValue('certification');
    // The award-only field has nothing to attach to on a certification row.
    expect(screen.queryByLabelText('Description 1')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Name 1'), { target: { value: 'AWS Certified' } });
    fireEvent.change(screen.getByLabelText('Issuer 1'), { target: { value: 'Amazon' } });
    fireEvent.change(screen.getByLabelText('Date 1'), { target: { value: '2024' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile saved.');

    expect(saveProfile).toHaveBeenLastCalledWith({
      ...loaded,
      certifications: [{ name: 'AWS Certified', issuer: 'Amazon', date: '2024' }],
      awards: [],
    });
  });

  it('switches a row to Award, exposing the description field, and saves it under awards', async () => {
    const loaded: Profile = {
      ...emptyProfile,
      certifications: [{ name: 'AWS Certified', issuer: 'Amazon', date: '2024' }],
      awards: [],
    };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
    await screen.findByLabelText('Full name');

    fireEvent.change(screen.getByLabelText('Type 1'), { target: { value: 'award' } });

    expect(screen.getByLabelText('Name 1')).toHaveValue('AWS Certified');
    fireEvent.change(screen.getByLabelText('Description 1'), {
      target: { value: 'Top of the cohort' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile saved.');

    expect(saveProfile).toHaveBeenLastCalledWith({
      ...loaded,
      certifications: [],
      awards: [
        { name: 'AWS Certified', issuer: 'Amazon', date: '2024', description: 'Top of the cohort' },
      ],
    });
  });

  it('shows existing certifications and awards together, each tagged with its own type', async () => {
    const loaded: Profile = {
      ...emptyProfile,
      certifications: [{ name: 'AWS Certified', issuer: 'Amazon', date: '2024' }],
      awards: [{ name: 'Hack Day', issuer: 'Acme', date: '2020', description: 'Won first place' }],
    };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
    await screen.findByLabelText('Full name');

    expect(screen.getByLabelText('Type 1')).toHaveValue('certification');
    expect(screen.getByLabelText('Name 1')).toHaveValue('AWS Certified');
    expect(screen.getByLabelText('Type 2')).toHaveValue('award');
    expect(screen.getByLabelText('Name 2')).toHaveValue('Hack Day');
    expect(screen.getByLabelText('Description 2')).toHaveValue('Won first place');
  });

  it('removes a certification-or-award row', async () => {
    const loaded: Profile = {
      ...emptyProfile,
      certifications: [{ name: 'AWS Certified', issuer: 'Amazon', date: '2024' }],
      awards: [],
    };
    stubBackend({ get: () => loaded });

    render(<App client={client} />);
    await screen.findByLabelText('Full name');

    fireEvent.click(screen.getByRole('button', { name: 'Remove certification or award 1' }));

    expect(screen.queryByLabelText('Name 1')).not.toBeInTheDocument();
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
      workExperience: [
        {
          company: '',
          title: '',
          startDate: '',
          endDate: null,
          bullets: [],
          maxBullets: null,
          starredIndices: [],
          suppressIfEmpty: false,
        },
      ],
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

const blankExtraction: ExtractedProfile = {
  fullName: null,
  email: null,
  phone: null,
  location: null,
  links: { linkedin: null, portfolio: null, github: null },
  summary: null,
  workExperience: [],
  education: [],
  skills: [],
  projects: [],
  certifications: [],
  awards: [],
};

describe('options App, resume upload', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploads a resume, pre-fills the reviewable form from the extraction, and saves the reviewed result', async () => {
    const loaded: Profile = { ...emptyProfile, fullName: 'Jane Doe', phone: '555-0100' };
    const extracted: ExtractedProfile = {
      ...blankExtraction,
      fullName: 'Jane A. Doe',
      email: 'jane@example.com',
      location: 'Remote',
      summary: 'Senior engineer.',
      skills: ['TypeScript'],
    };
    const extractResume = vi.fn(async () => extracted);
    const saveProfile = vi.fn(async (profile: Profile) => profile);
    const client = createFakeBackendClient({
      getProfile: vi.fn(async () => loaded),
      saveProfile,
      extractResume,
    } as Partial<BackendClient>);

    render(<App client={client} />);
    await screen.findByLabelText('Full name');

    const file = new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Resume PDF'), { target: { files: [file] } });

    await screen.findByText('Resume parsed. Review the pre-filled fields below, then save.');
    expect(extractResume).toHaveBeenCalledWith(file);

    // Fields the extraction found are pre-filled, in the same inputs as any manual edit —
    expect(screen.getByLabelText('Full name')).toHaveValue('Jane A. Doe');
    expect(screen.getByLabelText('Email')).toHaveValue('jane@example.com');
    expect(screen.getByLabelText('Location')).toHaveValue('Remote');
    expect(screen.getByLabelText('Summary')).toHaveValue('Senior engineer.');
    expect(screen.getByText('TypeScript')).toBeInTheDocument();
    // — but a field the extraction found nothing for keeps what the candidate already had.
    expect(screen.getByLabelText('Phone')).toHaveValue('555-0100');
    expect(screen.getByText('You have unsaved changes.')).toBeInTheDocument();

    // The candidate reviews and corrects the pre-filled draft before saving, like any other edit.
    fireEvent.change(screen.getByLabelText('Summary'), {
      target: { value: 'Senior backend engineer.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile saved.');

    expect(saveProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        fullName: 'Jane A. Doe',
        email: 'jane@example.com',
        phone: '555-0100',
        location: 'Remote',
        summary: 'Senior backend engineer.',
        skills: ['TypeScript'],
      }),
    );
  });

  it('reports a clear error and leaves the form untouched, falling back to manual entry', async () => {
    const loaded: Profile = { ...emptyProfile, fullName: 'Jane Doe' };
    const extractResume = vi.fn(async () => {
      throw new Error('No extractable text was found in this PDF.');
    });
    const client = createFakeBackendClient({
      getProfile: vi.fn(async () => loaded),
      extractResume,
    } as Partial<BackendClient>);

    render(<App client={client} />);
    await screen.findByLabelText('Full name');

    const file = new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Resume PDF'), { target: { files: [file] } });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't parse this resume: No extractable text was found in this PDF.",
    );
    expect(screen.getByLabelText('Full name')).toHaveValue('Jane Doe');
    expect(screen.queryByText('You have unsaved changes.')).not.toBeInTheDocument();
  });

  it('shows the sign-in view when the upload itself hits a 401, same as any other route', async () => {
    const loaded: Profile = { ...emptyProfile, fullName: 'Jane Doe' };
    const extractResume = vi.fn(async () => {
      throw new HttpError('http', '/profile/extract-resume', 'Authentication required', 401);
    });
    const client = createFakeBackendClient({
      getProfile: vi.fn(async () => loaded),
      extractResume,
    } as Partial<BackendClient>);

    render(<App client={client} />);
    await screen.findByLabelText('Full name');

    const file = new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Resume PDF'), { target: { files: [file] } });

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('options App, auth', () => {
  // Unmounts (running effect cleanups, which read `chrome`) before unstubbing it — the global
  // `afterEach` in `vitest.setup.ts` also calls `cleanup()`, but by then this describe's own
  // `afterEach` has already run and `chrome` would be gone, which is exactly the
  // "chrome is not defined" `useThemePreference` cleanup crash this ordering avoids.
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the sign-in view on a 401 rather than an unusable empty form', async () => {
    render(<App client={createFakeBackendClient({}, { signedIn: false })} />);

    expect(await screen.findByRole('heading', { name: 'djobi' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Full name')).not.toBeInTheDocument();
  });

  it('signs in and shows the profile editor once a session exists', async () => {
    const signedOutClient = createFakeBackendClient({}, { signedIn: false });
    render(<App client={signedOutClient} />);
    await screen.findByLabelText('Email');

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'jane@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correct horse battery staple' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(screen.getByLabelText('Full name')).toBeInTheDocument());
  });

  it('reports a bad password without leaving the sign-in view', async () => {
    render(<App client={createFakeBackendClient({}, { signedIn: false })} />);
    await screen.findByLabelText('Email');

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'jane@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('adopts a session found in the dashboard’s shared cookie instead of showing sign-in', async () => {
    // No local bearer token, but the dashboard already has one — `chrome.cookies.get` is this
    // extension's only way to see it (`sharedSessionCookie.ts`). The first `getProfile` 401s the
    // way a genuinely signed-out extension would; the second (after adoption) succeeds, standing in
    // for "the adopted token is now attached and the backend accepts it."
    let calls = 0;
    const client = fakeBackend({
      get: () => {
        calls += 1;
        if (calls === 1) {
          throw new HttpError(
            'http',
            '/profile',
            '/profile failed (401): Authentication required',
            401,
          );
        }
        return { ...emptyProfile, fullName: 'Jane Doe' };
      },
      save: (profile) => profile,
    });
    vi.stubGlobal('chrome', {
      cookies: {
        get: vi.fn(async () => ({ value: 'dashboard-session-token' }) as chrome.cookies.Cookie),
      },
      // `useThemePreference` (rendered by every page) reads `storage.local` on mount regardless of
      // what this test cares about — minimal enough that it resolves instead of crashing.
      storage: minimalLocalStorage(),
    });

    render(<App client={client} />);

    await waitFor(() => expect(screen.getByLabelText('Full name')).toHaveValue('Jane Doe'));
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(getProfile).toHaveBeenCalledTimes(2);
  });

  it('still shows sign-in when there is no local session and no shared one to adopt', async () => {
    vi.stubGlobal('chrome', {
      cookies: { get: vi.fn(async () => null) },
      storage: minimalLocalStorage(),
    });

    render(<App client={createFakeBackendClient({}, { signedIn: false })} />);

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});

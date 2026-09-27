import {
  DuplicateApplicationSummarySchema,
  ExtractJobRequestSchema,
  ExtractResumeResponseSchema,
  JobInfoSchema,
  ProfileSchema,
  SaveProfileRequestSchema,
  type DuplicateApplicationSummary,
  type ExtractedProfile,
  type JobInfo,
  type Profile,
} from '@djobi/shared';
import { requestBody, type HttpTransport } from './index.js';

/**
 * Backend routes both apps call identically; `BackendClient` and `DashboardClient` delegate here.
 * Bodies are **parsed** through the shared request schema (so an unaccepted field fails here
 * instead of being stripped), `method` is always explicit, and responses are schema-decoded.
 *
 * Not here: routes only one app calls, `POST /applications` (compact for the extension, full row
 * for the dashboard), and 401 policy (the extension adopts the dashboard session and retries; the
 * dashboard signs out).
 */
export interface BackendRoutes {
  /** `POST /extract-job`: structured Job Info from a pasted Job Description. */
  extractJob(jobDescription: string, signal?: AbortSignal): Promise<JobInfo>;
  /** `GET /profile`: the stored Profile, or `null` before the candidate has saved one. */
  getProfile(): Promise<Profile | null>;
  /** `POST /profile`: stores the Profile whole and resolves with what was stored. */
  saveProfile(profile: Profile): Promise<Profile>;
  /**
   * `POST /profile/extract-resume`: a draft extraction from an uploaded resume PDF, never saved.
   */
  extractResume(file: File, signal?: AbortSignal): Promise<ExtractedProfile>;
  /** `GET /applications?jobUrl=…`: count and newest metadata of Applications saved for this URL. */
  findApplicationDuplicates(
    jobUrl: string,
    signal?: AbortSignal,
  ): Promise<DuplicateApplicationSummary>;
}

/** `null` means the candidate hasn't saved a Profile yet. */
const MaybeProfileSchema = ProfileSchema.nullable();

export function backendRoutes(transport: HttpTransport): BackendRoutes {
  return {
    extractJob: (jobDescription, signal) =>
      transport.json('/extract-job', JobInfoSchema, {
        method: 'POST',
        body: requestBody('/extract-job', ExtractJobRequestSchema, { jobDescription }),
        signal,
      }),

    getProfile: () => transport.json('/profile', MaybeProfileSchema, { method: 'GET' }),

    saveProfile: (profile) =>
      transport.json('/profile', ProfileSchema, {
        method: 'POST',
        body: requestBody('/profile', SaveProfileRequestSchema, profile),
      }),

    extractResume: (file, signal) => {
      const formData = new FormData();
      formData.set('resume', file);
      return transport.upload('/profile/extract-resume', ExtractResumeResponseSchema, formData, {
        signal,
      });
    },

    findApplicationDuplicates: (jobUrl, signal) =>
      transport.json(
        `/applications?jobUrl=${encodeURIComponent(jobUrl)}&response=compact`,
        DuplicateApplicationSummarySchema,
        { method: 'GET', signal },
      ),
  };
}

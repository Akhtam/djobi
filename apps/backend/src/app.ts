import { Hono } from 'hono';
import { answerQuestionsRoute } from './routes/answer-questions.js';
import { applicationsRoute } from './routes/applications.js';
import { extractJobRoute } from './routes/extract-job.js';
import { profileRoute } from './routes/profile.js';
import { renderResumePdfRoute } from './routes/render-resume-pdf.js';
import { tailorResumeRoute } from './routes/tailor-resume.js';

/**
 * The Hono app instance — separated from `index.ts` (which calls `serve()`) so it can be imported
 * and tested via `app.request(...)` without binding a real port.
 */
export const app = new Hono();

app.route('/', extractJobRoute);
app.route('/', profileRoute);
app.route('/', tailorResumeRoute);
app.route('/', answerQuestionsRoute);
app.route('/', renderResumePdfRoute);
app.route('/', applicationsRoute);

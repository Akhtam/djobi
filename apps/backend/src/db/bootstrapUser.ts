/**
 * The user migration `0009` created and assigned pre-existing rows to. No route uses it (requests
 * carry a real `userId`); it remains as a stable seed id for tests.
 */
export const BOOTSTRAP_USER_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Route wrapper for the settings screen.
 *
 * `schedule.tsx` holds the editor itself. Next's app router only treats
 * `page.tsx` as a route, so without this file the recurrence editor would
 * compile but be unreachable — and an unreachable settings screen is the same
 * as no settings screen.
 */
export { default } from './schedule';

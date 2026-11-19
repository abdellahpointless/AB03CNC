# CNC Process Pro

A shop-floor web app for a CNC machining shop: G-code tool remapper and HAAS ⇄ FANUC
converter, tool inventory, program history, 3D toolpath simulation, CAM AI (rule-based
program generation from a 3D model, no LLM), preventive maintenance, shift checks, cales box,
part tracking, and a master dashboard. React 19 + Vite, one Cloudflare Worker, D1 databases,
free plan.

## Standing rules

- **Always push** finished changes to GitHub, on the session's development branch.
- **Never deploy unless the user says "deploy".** Deploying = pushing (fast-forward) to
  `claude/cnc-app-cloudflare-migration-xftztk`; Cloudflare Workers Builds rebuilds from that
  branch. Never force-push it.
- Do not commit secrets, `.dev.vars`, or the `CLAUDE-SECURITY-*` report folders.
- Plain, short commit messages in the repository's style ("Area: what changed").

## Layout

- `src/` React app. `main.tsx` decides the page from the URL: `/` country picker, `/ma/`
  Morocco (English), `/tr/` Türkiye (Turkish), `/master/` master dashboard.
- `src/regions.ts` countries, per-country feature switches, machine helpers.
- `src/lib/gcodeProcessor.ts`, `*Converter.ts` remapper engine and machine-specific rules.
- `src/lib/toolpath.ts`, `stockSim.ts`, `setups.ts` toolpath parsing, voxel simulation, vise/flips.
- `src/lib/cam/` CAM AI planner (runs in `cam.worker.ts`); `library.json` and
  `shopKnowledge.json` are the shop's confidential cutting data.
- `worker/` API. `index.ts` router (one D1 database per country, hub DB for masters),
  `auth.ts` sessions/lockout/MFA, `schema.ts` migrations, `routes/` endpoints,
  `assets.ts` private-code gate.
- `src/i18n/` translations: every key exists in `locales/en` and `locales/tr` (type-checked).

## Security model (keep it)

- Only the sign-in page is public (`dist/assets/`). All other code is built into
  `dist/app/<access>/` (`user`, `admin`, `toolpath`, `cam`, `master`, `any`) by
  `vite-private-chunks.ts`, and `worker/assets.ts` serves it only to sessions with that access.
- The build fails if a source file outside `PUBLIC_SOURCES` lands in a public file. When the
  sign-in page genuinely needs a new file, add it to that list; never move engine code there.
- New lazy-loaded screens: add them to `ROOTS` in `vite-private-chunks.ts` with their access.
- Role and per-user flags (`toolpathBeta`, `camAi`) are enforced on the server, not only in the UI.
- Free text written into G-code goes through `commentSafe` (a `)` would inject commands).

## Commands

```bash
npm ci
npm run typecheck
npm test
npm run build && npx wrangler dev   # app + API on http://localhost:8787
```

- 4 tests fail before any change (time-zone: `tests/shifts.test.ts`, `tests/fleet.test.ts`,
  `worker/tests/shift-tasks.test.ts`); do not chase them unless asked.
- `npm run learn-shop` with no arguments overwrites `src/lib/cam/shopKnowledge.json`; only run
  it on purpose, with program folders or a lessons export as arguments.
- Browser checks: Playwright and Chromium are preinstalled; `__Host-` cookies work on
  `http://localhost:8787`.

## Skills to use

- UI or visual work: `ui-ux-pro-max`.
- React components: `fullstack-dev-skills:react-expert`; types: `fullstack-dev-skills:typescript-pro`.
- Auth, input validation, anything security-related: `fullstack-dev-skills:secure-code-guardian`.
- Tests: `fullstack-dev-skills:test-master`; browser tests: `fullstack-dev-skills:playwright-expert`.
- Large or vague requests: `fullstack-dev-skills:common-ground` first, to confirm assumptions.
- Any AI/LLM feature or prompt: `fullstack-dev-skills:prompt-engineer` and `claude-api`.

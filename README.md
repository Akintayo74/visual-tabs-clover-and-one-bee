# Visual Memory

A Chrome extension that saves a site exactly as it looked, and a new-tab wall that finds it again
when you describe what you saw. See [PLAN.md](PLAN.md) for the mission, decisions and phases, and
[CLAUDE.md](CLAUDE.md) for how work is done here.

## Repository layout

```
extension/   Chrome extension (Manifest V3, TypeScript, WXT)
  entrypoints/   background service worker, new-tab page
  src/           shared code
  tests/         unit tests (Vitest)
  e2e/           browser tests that load the built extension (Playwright)
supabase/    Supabase project: config.toml, migrations/, functions/ (Edge Functions)
```

## Requirements

- Node 22+ and pnpm 10 (`corepack enable` picks up the pinned version)
- Docker, for the local Supabase stack
- Chrome or Chromium

## Setup

```sh
pnpm install
```

The Supabase CLI is a dev dependency, so `pnpm exec supabase …` always uses the pinned version.

## Extension

```sh
pnpm dev     # builds in watch mode and opens a Chromium window with the extension loaded
pnpm build   # production build into extension/.output/chrome-mv3
```

### Load the unpacked extension in Chrome

1. Run `pnpm build` (or `pnpm dev`, which rebuilds on change).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick `extension/.output/chrome-mv3`.
4. Open a new tab. Chrome asks once whether to keep the extension's new-tab page; choose **Keep it**.

After a rebuild, click the reload icon on the extension's card in `chrome://extensions`.

## Local Supabase

```sh
pnpm db:start   # supabase start: Postgres, Auth, Storage, Edge Runtime, Studio
pnpm db:reset   # re-create the local database and apply every migration
pnpm db:stop
```

`supabase start` prints the local URLs and keys. Studio is at http://127.0.0.1:54323.

### Migrations

Database changes go only through `supabase/migrations/`:

```sh
pnpm exec supabase migration new <name>   # creates supabase/migrations/<timestamp>_<name>.sql
pnpm db:reset                             # applies it locally
pnpm exec supabase db push                # applies pending migrations to the linked project
```

### Edge Functions

Model API keys live only in Edge Function secrets. Copy [.env.example](.env.example) to
`supabase/functions/.env` and fill it in (that file is git-ignored).

```sh
pnpm exec supabase functions serve                     # local, reads supabase/functions/.env
pnpm exec supabase secrets set --env-file supabase/functions/.env
pnpm exec supabase functions deploy <name>             # needs `supabase link` first
```

There are no functions yet; they arrive in Phase 4.

## Checks

```sh
pnpm lint            # ESLint (typescript-eslint strict, type-aware)
pnpm format:check    # Prettier (pnpm format to fix)
pnpm typecheck       # tsc --noEmit, strict
pnpm test            # Vitest unit tests
pnpm check           # all of the above
pnpm --filter extension e2e   # builds, loads the extension in Chromium, checks the new tab
```

The e2e test uses Playwright's Chromium (`pnpm --filter extension exec playwright install chromium`).
Set `CHROMIUM_PATH` to use a different Chromium binary.

CI runs all of these on every pull request, plus `supabase db start` to make sure every migration
applies.

## Why WXT

The plan asked for a modern extension framework such as WXT or Vite + CRXJS. We chose
[WXT](https://wxt.dev):

- It generates the Manifest V3 manifest from file-based entrypoints (`entrypoints/newtab/` becomes
  the new-tab override, `entrypoints/background.ts` the service worker), which keeps the manifest
  and the code from drifting apart as content scripts and shortcuts are added.
- It ships a Vitest plugin and an in-memory fake of the `browser`/`chrome` APIs, which the save
  queue, dedupe and fingerprint tests in later phases will rely on.
- `wxt dev` reloads the extension on change, and `wxt zip` packages it for the trial user in
  Phase 5.
- It is built on Vite, so any Vite plugin still works, and it is actively maintained.

CRXJS is a good Vite plugin, but it only covers the build step; the test helpers, packaging and
entrypoint conventions above would be ours to build and maintain.

## Evaluation

The search eval (`eval/`) arrives in Phase 4.

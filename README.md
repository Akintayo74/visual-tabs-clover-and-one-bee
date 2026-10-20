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

### Using it

| Action                    | How                                                                       |
| ------------------------- | ------------------------------------------------------------------------- |
| Save the current page     | `Alt+Shift+S`, or click the toolbar button                                |
| Save and close the tab    | `Alt+Shift+X`, or right-click the toolbar button → **Save and close tab** |
| Browse saves              | Open a new tab                                                            |
| Move between cards        | Arrow keys, `Home`, `End`                                                 |
| Open a card's detail view | `Enter` or click                                                          |
| Close the detail view     | `Esc`                                                                     |

Change the shortcuts at `chrome://extensions/shortcuts`. Chrome only assigns a suggested
shortcut if nothing else uses it, so check that page if a shortcut does nothing.

Saving captures the visible part of the page, reads the page's structure, and stores both in
IndexedDB before showing **Saved**. The WebP versions are made afterwards; a card shows
**Processing…** until then, or **Failed** with a **Retry** button. Saving the same page again
replaces its snapshot rather than adding a duplicate. Browser pages, the Chrome Web Store, PDFs
and local files can't be saved; you get a notification saying so.

The toolbar icon shows **…** as soon as the capture is taken and **✓** once the save is stored.
The in-page toast needs the page's own main thread, so on a page that is busy (some animated
sites block it for seconds after loading) the toast can be late, but the save never waits for
it. Reading the page's structure gives up after 2 seconds; the save is kept without it.

### Permissions

- `activeTab`, `scripting`: pressing the shortcut or the toolbar button lets the extension
  capture and read only the tab you're on. It has no standing access to any site.
- `contextMenus`: the **Save and close tab** item on the toolbar button.
- `notifications`: tells you when a page can't be saved (there is no page to show a toast on).
- `favicon`: shows site icons from Chrome's cache, so they work offline.
- `unlimitedStorage`: screenshots add up; without it Chrome may evict IndexedDB data.

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

## How saves are stored

All data lives in the extension's IndexedDB database `visual-memory` (see
`extension/src/lib/db.ts`):

- `saves`: one small record per site (URL, title, status, palette, fonts). The new tab loads all
  of these at once.
- `fingerprints`: the page structure read at save time, loaded only in the detail view.
- `images`: `raw` (the capture as taken, kept until processing succeeds), `full` (up to 2400px
  wide, WebP) and `card` (960px, WebP).

## Checks

```sh
pnpm lint            # ESLint (typescript-eslint strict, type-aware)
pnpm format:check    # Prettier (pnpm format to fix)
pnpm typecheck       # tsc --noEmit, strict
pnpm test            # Vitest unit tests
pnpm check           # all of the above
pnpm --filter extension e2e   # browser tests: saves, the wall, fingerprints (Chromium)
```

The e2e tests use Playwright's Chromium (`pnpm --filter extension exec playwright install chromium`).
Set `CHROMIUM_PATH` to use a different Chromium binary. They load a separate build
(`wxt build --mode e2e`, output in `.output/chrome-mv3-e2e`) that adds `<all_urls>` host access,
because a test can't press a keyboard shortcut to grant `activeTab`. Don't load that build for
real use. The test sites are generated locally (`extension/e2e/support/sites.ts`), so the suite
runs offline.

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

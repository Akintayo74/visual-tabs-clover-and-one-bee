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

To build with backup and sync, copy [extension/.env.example](extension/.env.example) to
`extension/.env` and fill in the Supabase URL and publishable key (see
[Hosted Supabase project](#hosted-supabase-project), or use the local stack's values from
`pnpm exec supabase status`). Both values are public. Without them the extension still works,
with saves kept on this computer only.

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
| Import every open tab     | **Import open tabs** on the new tab                                       |
| Cancel an import          | **Cancel** on the new tab, or click the toolbar button                    |
| Back up and sync          | **Sign in to back up** on the new tab                                     |
| Export everything         | **Export** on the new tab                                                 |

Change the shortcuts at `chrome://extensions/shortcuts`. Chrome only assigns a suggested
shortcut if nothing else uses it, so check that page if a shortcut does nothing.

Saving captures the visible part of the page, reads the page's structure, and stores both in
IndexedDB before showing **Saved**. The WebP versions are made afterwards; a card shows
**Processing…** until then, or **Failed** with a **Retry** button. Saving the same page again
replaces its snapshot rather than adding a duplicate. Pages are matched on their address with
tracking parameters, `www.` and trailing slashes removed. Browser pages, the Chrome Web Store, PDFs
and local files can't be saved; you get a notification saying so.

The toolbar icon shows **…** as soon as the capture is taken and **✓** once the save is stored.
The in-page toast needs the page's own main thread, so on a page that is busy (some animated
sites block it for seconds after loading) the toast can be late, but the save never waits for
it. Reading the page's structure gives up after 2 seconds; the save is kept without it.

### Importing open tabs

**Import open tabs** on the new tab saves every tab in that window. The extension activates each
tab in turn, waits for it to load (up to 20s) plus 1.5s for it to settle, captures it, and moves
on, so the window flips through your tabs while it runs. The toolbar badge shows progress. Tabs
that can't be saved are skipped. When it finishes, it returns to the new tab and shows what was
saved and why anything was skipped, with a button to close the saved tabs. A tab is only closed
if it still shows the page that was saved. If Chrome stops the extension mid-import, the new tab
offers to resume.

### Backup and sync

Saves are always written to this computer first, so saving works offline and never waits for
the network. Once you sign in (with a 6-digit code emailed to you), each save uploads in the
background: its record goes to the `saves` table and its two WebP images to the private
`screenshots` bucket. Failed uploads retry with backoff (5s, 10s, 20s… up to 15 minutes), and
while offline the extension checks back every 30 seconds, so saves made offline upload by
themselves. The top of the new tab says whether everything is backed up, and a card shows
**Waiting to back up** or **Backup failed, retrying** until its upload succeeds.

Signing in on another computer, or after reinstalling, downloads every save: cards first, then
the full images. Changes from other computers arrive every 5 minutes, when the new tab opens,
or with **Sync now**. Rules when two computers disagree:

- The same page saved on two computers is one save; the newer snapshot wins.
- A delete removes the save everywhere, unless the page was saved again after the delete.
- Signing out keeps your saves here and on the server. Signing in as someone else removes the
  previous account's saves from this computer (they stay on the server); saves never uploaded
  stay and upload to the new account.

**Export** downloads a zip of everything on this computer: `saves.json` (every save's details
and page fingerprint) and an `images/` folder. It first downloads any full images that were
synced from another computer but aren't here yet.

### Permissions

- `activeTab`, `scripting`: pressing the shortcut or the toolbar button lets the extension
  capture and read only the tab you're on. It has no standing access to any site.
- `contextMenus`: the **Save and close tab** item on the toolbar button.
- `notifications`: tells you when a page can't be saved (there is no page to show a toast on).
- `favicon`: shows site icons from Chrome's cache, so they work offline.
- `unlimitedStorage`: screenshots add up; without it Chrome may evict IndexedDB data.
- `storage`: keeps import progress so an interrupted import can resume, and the sign-in session.
- `alarms`: retries uploads and checks for changes from other computers, even after Chrome
  stops the extension's background worker.
- Access to all sites (optional): asked for the first time you import open tabs, because the
  import captures tabs without a keypress on each one. Saving single pages never needs it.

## Local Supabase

```sh
pnpm db:start   # supabase start: Postgres, Auth, Storage, Edge Runtime, Studio
pnpm db:reset   # re-create the local database and apply every migration
pnpm db:stop
```

`supabase start` prints the local URLs and keys. Studio is at http://127.0.0.1:54323. Sign-in
emails don't leave your machine; read them at http://127.0.0.1:54324 (Mailpit).

### Migrations

Database changes go only through `supabase/migrations/`:

```sh
pnpm exec supabase migration new <name>   # creates supabase/migrations/<timestamp>_<name>.sql
pnpm db:reset                             # applies it locally
pnpm exec supabase db push                # applies pending migrations to the linked project
```

### Hosted Supabase project

1. Create a project at [supabase.com](https://supabase.com/dashboard), then link it:
   `pnpm exec supabase link --project-ref <ref>`.
2. Apply the schema: `pnpm exec supabase db push`. This creates the `saves` and `search_events`
   tables with row-level security, the `upsert_save`/`delete_save` functions and the private
   `screenshots` bucket.
3. Open the project's [email templates](https://supabase.com/dashboard/project/_/auth/templates)
   and replace the **Magic Link** template's body with
   [supabase/templates/magic_link.html](supabase/templates/magic_link.html), so the email
   carries a code (the extension can't receive a magic link). Email sign-in is on by default
   (**Authentication > Sign In / Providers**). Supabase's built-in email sender is
   rate-limited, so set up custom SMTP in the Auth settings before real use.
4. Copy the project URL and the **publishable** key (Project Settings > API Keys) into
   `extension/.env`, then `pnpm build`. Never use the secret key in the extension.

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
- `deletions`: deletes made here that the server hasn't recorded yet.

Each save also records whether its current snapshot is uploaded (`syncState`) and what the
server holds for it. Supabase is the source of truth once you sign in (see
`supabase/migrations/`): deleted saves stay as tombstones so every computer learns about the
delete, and clients pull rows changed since their last sync by `updated_at`.

## Checks

```sh
pnpm lint            # ESLint (typescript-eslint strict, type-aware)
pnpm format:check    # Prettier (pnpm format to fix)
pnpm typecheck       # tsc --noEmit, strict
pnpm test            # Vitest unit tests
pnpm check           # all of the above
pnpm --filter extension e2e   # browser tests: saves, the wall, fingerprints (Chromium)

# These need the local stack running (pnpm db:start):
pnpm --filter extension test:server   # database tests: upsert/delete rules, row-level security
pnpm --filter extension e2e:sync      # backup and sync: sign-in, offline, reinstall, 2 browsers
```

The e2e tests use Playwright's Chromium (`pnpm --filter extension exec playwright install chromium`).
Set `CHROMIUM_PATH` to use a different Chromium binary. They load a separate build
(`wxt build --mode e2e`, output in `.output/chrome-mv3-e2e`) that adds `<all_urls>` host access,
because a test can't press a keyboard shortcut to grant `activeTab`. Don't load that build for
real use. The test sites are generated locally (`extension/e2e/support/sites.ts`), so the suite
runs offline.

The sync tests read sign-in codes from the local mailbox. They simulate going offline inside the
extension, because Playwright's offline mode doesn't reach an extension's background worker.

CI runs all of these on every pull request; the database and sync tests run in a job that
starts the local Supabase stack, which also checks that every migration applies.

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

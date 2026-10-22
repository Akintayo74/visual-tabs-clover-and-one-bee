# Visual Tabs

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
  functions/_shared/   the describe, embed and search pipeline the functions share
server/      Node tooling for the functions: unit tests, function tests, mock models, reprocess job
eval/        search evaluation: queries.json, query generator, hit@k runner
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
| Search                    | Type in the search box (`/` focuses it, `Esc` clears it)                  |
| Move between cards        | Arrow keys, `Home`, `End` (`↓` from the search box)                       |
| Open a card's detail view | `Enter` or click                                                          |
| Close the detail view     | `Esc`                                                                     |
| Add a note to a save      | Type in **Your note** in the detail view (stored as you type)             |
| Find look-alikes          | **More like this** in the detail view (`Esc` goes back)                   |
| Filter the wall           | Colour swatches, font and date menus under the search box                 |
| Cards per row             | **Auto / 2 / 3 / 4** at the right of the filters                          |
| How it works              | **Help** on the new tab                                                   |
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

### Search

Describe the site the way you remember it: "a one-page site with only one section with large
text on it", "dark portfolio with a 3D blob". Results come in two layers:

1. **Quick matches**, on every keystroke, from the saves on this computer: titles, notes, fonts,
   and (once a save is described) its recall phrases, tags and description. Typo-tolerant.
2. **Best matches**, once you pause or press `Enter`, from the `search` Edge Function: the
   query is embedded and compared with every save's screenshot-plus-description embedding,
   combined with keyword search, and the top results are reranked
   ([PLAN.md "Search pipeline"](PLAN.md#search-pipeline)). They replace the quick matches in
   place. Signed out or offline, the quick matches stay and the line under the search box says
   why.

After a save is backed up, the server describes it (Claude Sonnet 5.5) and embeds it (Voyage).
Its card shows **Describing…** meanwhile, or **Couldn't describe** with **Retry**; failures are
retried automatically first (after 1 min, 5 min, 30 min, 2 h, then 6 h; six tries in all). The
detail view shows the description, how the site might be remembered and its tags. Searches and
the result you open are logged in `search_events` for tuning.

### Notes, look-alikes and filters

- **Notes.** Each save has a note in its detail view. It's stored on this computer as you type
  and backed up by sync; when two computers edit the same note, the later edit wins. Notes are
  searched by the quick matches, by keyword search on the server and by the reranker. Editing a
  note doesn't describe the save again.
- **More like this** shows saves that look alike. It starts with what this computer knows
  (shared tags, fonts, colours and site) and then shows the server's nearest saves by their
  stored screenshot-plus-description embeddings (`similar_saves`). It makes no model call, so it
  costs nothing. Signed out, offline, or before the save is described, the local matches stay
  and the line under the search box says so.
- **Filters** narrow whatever the wall shows: everything, search results or look-alikes.
  **Colour** matches the colour family (red, blue, black, white…) of a save's five most
  prominent colours. **Font** lists the library's fonts, most used first. **Date** is when the
  site was first saved, so re-saving it doesn't make it new. Filters reset with each new tab;
  the cards-per-row choice is remembered on this computer.

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

## Packaging for the trial

The trial build is a zip that loads as an unpacked extension (installation steps for the trial
user are in [INSTALL.md](INSTALL.md)):

```sh
# extension/.env holds the hosted project's URL and publishable key (see Hosted Supabase project)
pnpm package   # → extension/.output/visual-tabs-<version>-chrome.zip
```

`pnpm package` refuses to build without the hosted project's URL and publishable key, or with a
local one, so a trial build can always back up. The version comes from
`extension/package.json`; bump it for each build you hand over.

Without a GitHub checkout, run the **Package** workflow from the repository's **Actions** tab
(**Run workflow**). It reads the repository variables `SUPABASE_URL` and
`SUPABASE_PUBLISHABLE_KEY` (Settings > Secrets and variables > Actions > Variables; both are
public values) and attaches the extension to the run as `visual-tabs-chrome.zip`, ready to
send.

The packaged build has a fixed extension id (`mipdebknhogpnnhmddnbjdflelnihkpi`, from the public
key in `extension/wxt.config.ts`). An unpacked extension's id otherwise comes from its folder,
and the local library belongs to the id: with a fixed id, loading an update from a different
folder keeps everything. `pnpm build` sets it too; `pnpm dev` and the e2e build don't. A Chrome Web Store listing
would get its own id and needs the `key` field left out.

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
   tables with row-level security, the sync, processing-queue and search functions, and the
   private `screenshots` bucket.
3. Open the project's [email templates](https://supabase.com/dashboard/project/_/auth/templates)
   and replace the **Magic Link** template's body with
   [supabase/templates/magic_link.html](supabase/templates/magic_link.html), so the email
   carries a code (the extension can't receive a magic link). Email sign-in is on by default
   (**Authentication > Sign In / Providers**). Supabase's built-in email sender is
   rate-limited, so set up custom SMTP in the Auth settings before real use.
4. Copy the project URL and the **publishable** key (Project Settings > API Keys) into
   `extension/.env`, then `pnpm build`. Never use the secret key in the extension.
5. Set the model keys and deploy the Edge Functions (next section).

Steps 1, 2 and 5 can run from GitHub instead of your machine: add the settings listed at the
top of [.github/workflows/deploy.yml](.github/workflows/deploy.yml) under **Settings > Secrets
and variables > Actions**, then run **Actions > Deploy**. Run it again after merging new
migrations or function changes. For the trial zip, add the variables `SUPABASE_URL` and
`SUPABASE_PUBLISHABLE_KEY` and run **Actions > Package**.

### Edge Functions

Two functions, both in `supabase/functions/` with the shared code in `_shared/`:

- `process-save` describes saves with Claude (`claude-sonnet-5-5`, versioned prompt in
  `_shared/prompt.ts`), embeds the screenshot and the generated text together with Voyage
  (`voyage-multimodal-3.5`, 1024 dimensions) and writes the result back. Saves wait in a queue
  in the `saves` table; a call claims a few due ones, so two calls never describe the same save,
  and a result is only written if no newer snapshot arrived meanwhile. The extension calls it
  after each sync; failures back off and retry, then show **Couldn't describe** with Retry.
- `search` runs the hybrid search for the signed-in user (vector top 50 + full-text top 50,
  reciprocal rank fusion, Voyage `rerank-2.5` over the top 30). If Voyage is unreachable it
  still answers from keywords and says which step it skipped.

Model API keys live only in Edge Function secrets, never in the extension. Copy
[.env.example](.env.example) to `supabase/functions/.env` and fill it in (that file is
git-ignored).

```sh
pnpm exec supabase functions serve                     # local, reads supabase/functions/.env
pnpm exec supabase secrets set --env-file supabase/functions/.env
pnpm exec supabase functions deploy process-save search   # needs `supabase link` first
```

Both functions check the caller themselves (a user's session, or the project's secret key),
so `verify_jwt` is off for them in `supabase/config.toml`; deploy keeps that setting.

**Prompt changes.** Edit `_shared/prompt.ts`, bump `PROMPT_VERSION`, deploy, then re-describe
the saves made with older prompts:

```sh
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY=sb_secret_... pnpm --filter server reprocess
```

It queues every save with an older `prompt_version` and keeps calling `process-save` until the
queue is empty (`--force` re-describes everything). Old descriptions stay searchable until
replaced, and it's safe to stop and run again.

**Without keys.** `server/src/mock-models.ts` stands in for both APIs, for tests and local
runs: `pnpm --filter server mock-models`, then
`pnpm exec supabase functions serve --env-file server/functions.test.env`.

In this repo's cloud containers the Edge Runtime container can't reach npm through the proxy;
`DENO_DIR=/var/lib/docker/volumes/supabase_edge_runtime_visual-memory/_data
server/node_modules/.bin/deno cache --config supabase/functions/<fn>/deno.json
supabase/functions/<fn>/index.ts` fills its cache from the host first.

## How saves are stored

All data lives in the extension's IndexedDB database `visual-memory` (the product's first name, kept so existing libraries stay put; see
`extension/src/lib/db.ts`):

- `saves`: one small record per site (URL, title, status, palette, fonts). The new tab loads all
  of these at once.
- `fingerprints`: the page structure read at save time, loaded only in the detail view.
- `images`: `raw` (the capture as taken, kept until processing succeeds), `full` (up to 2400px
  wide, WebP) and `card` (960px, WebP).
- `deletions`: deletes made here that the server hasn't recorded yet.

Each save record also carries the server's `understanding` once uploaded: its processing status,
description, recall phrases and tags, which the quick search reads.

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

# These also need the functions served against the mock models (see Edge Functions):
pnpm --filter server test:functions   # process-save and search: retries, claims, ranking, RLS
pnpm --filter eval test:local         # the eval harness, end to end
pnpm --filter server mock-models &    # then:
pnpm --filter extension e2e:sync      # backup, sync, notes, describing, search and look-alikes
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

## Search evaluation

```sh
pnpm eval              # hit@1, hit@3, hit@5 and MRR per query set, plus every miss
pnpm eval:generate     # adds generated queries for saves that have none (needs ANTHROPIC_API_KEY)
```

Both run against a deployed project as the trial user. Set `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (used only to sign in as that user; no email
is sent) and `EVAL_USER_EMAIL`. Searches made by the eval aren't logged as real searches.

Query sets:

- **real** ([eval/queries.json](eval/queries.json)): the trial user's own searches, each mapped
  to the site he meant by URL. The PLAN.md targets (right site first ~70%, top 5 ~90%) apply to
  these.
- **tune** and **holdout** (`eval/generated-queries.json`): three queries per save (vague,
  structural, slightly misremembered), written by a different model (`claude-opus-5-5`) from
  the screenshot alone, with no access to the description, recall phrases, tags or
  measurements, so the pipeline isn't grading its own words. Saves are split 70/30 by id.
  Tune prompts against **tune**; **holdout** shows whether a gain is real.

Results are also written to `eval/results/` (git-ignored).

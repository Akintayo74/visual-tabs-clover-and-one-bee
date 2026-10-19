# CLAUDE.md

Read `PLAN.md` first. It holds the mission, decisions already made, the data model, and the phases.

## How to work here

- **Work one phase at a time, in order.** At the end of each phase, run through its "Done when" checklist, report what passed and what didn't, and stop for review before starting the next phase.
- **Reliability over polish.** Visual design will be iterated later. Never trade data safety, speed of the new tab, or search quality for looks.
- **Decisions in PLAN.md are settled.** If you think one is wrong, say why and propose an alternative instead of silently changing it.
- **Verify external APIs before using them.** Check current official docs for Chrome extension APIs, Supabase, the Anthropic API (`claude-sonnet-5-5`), and Voyage AI (`voyage-multimodal-3.5`, `rerank-2.5`). Don't rely on memory for model IDs, request shapes, limits, or pricing.
- **Secrets never go in the extension.** All model API keys live in Supabase Edge Function secrets. Keep a `.env.example` up to date; never commit real keys.
- **Every async path handles failure.** Saves are written locally first, then uploaded and processed in a retrying queue. Every save has a visible status.
- **Test what matters:** fingerprint extraction, the save queue (including offline and retry), dedupe, sync, and the search pipeline. Keep the eval harness (`eval/`) runnable with one command once Phase 4 starts.
- **Keep the README current:** how to run locally, load the unpacked extension, run migrations, deploy Edge Functions, and run the eval.

## Conventions

- TypeScript everywhere, strict mode.
- Small, focused commits with clear messages.
- Database changes only through migrations in `supabase/migrations/`.
- Prompt changes bump `prompt_version`, and a reprocess job exists to apply them.

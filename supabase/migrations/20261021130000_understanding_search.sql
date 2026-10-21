-- Phase 4: describing saves with the model, and searching them. See PLAN.md "Search pipeline".

-- ---- Keyword search ---------------------------------------------------------------------

alter table public.saves add column search_tsv tsvector;

/*
  Words the keyword search matches. Weighted so a hit in what the site is called or how it's
  remembered counts more than a hit somewhere in the long description.
*/
create function public.saves_search_tsv() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.search_tsv :=
    setweight(to_tsvector('english', coalesce(new.title, '') || ' ' || coalesce(new.site_name, '')), 'A') ||
    setweight(to_tsvector('english', array_to_string(coalesce(new.recall_phrases, '{}'), ' ')), 'A') ||
    setweight(to_tsvector('english', array_to_string(coalesce(new.tags, '{}'), ' ')), 'B') ||
    setweight(to_tsvector('english', coalesce(new.note, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(new.description, '')), 'C') ||
    setweight(to_tsvector('english', array_to_string(new.fonts, ' ')), 'C') ||
    -- The page's largest text, which people often half-remember.
    setweight(to_tsvector('english', coalesce((
      select string_agg(item ->> 'text', ' ')
      from jsonb_array_elements(
        case when jsonb_typeof(new.fingerprint -> 'largestText') = 'array'
          then new.fingerprint -> 'largestText' else '[]'::jsonb end
      ) as item
    ), '')), 'D');
  return new;
end;
$$;

create trigger saves_search_tsv
  before insert or update of title, site_name, recall_phrases, tags, note, description, fonts,
    fingerprint
  on public.saves
  for each row execute function public.saves_search_tsv();

update public.saves set title = title;

create index saves_search_tsv_idx on public.saves using gin (search_tsv);

-- No approximate vector index: one person's saves are few enough (thousands at most) that
-- an exact scan of their rows is fast and never misses a match. Revisit past ~10k per user.

-- ---- Processing queue -------------------------------------------------------------------

alter table public.saves
  -- Tries at describing the current snapshot. Reset by a new snapshot, a retry or a reprocess.
  add column attempts int not null default 0,
  add column next_attempt_at timestamptz not null default now(),
  -- Set while a function is working on the save. A stale claim (crashed worker) is taken over.
  add column claimed_at timestamptz,
  add column claim_id uuid;

create index saves_processing_queue on public.saves (next_attempt_at)
  where status in ('pending', 'processing') and deleted_at is null;

/*
  A new snapshot (or a save brought back from deletion) starts processing afresh. Clearing
  the claim means a worker still describing the old snapshot can't write its result.
*/
create function public.saves_reset_processing() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.captured_at is distinct from old.captured_at
    or (old.deleted_at is not null and new.deleted_at is null) then
    new.status := 'pending';
    new.error := null;
    new.attempts := 0;
    new.next_attempt_at := now();
    new.claimed_at := null;
    new.claim_id := null;
  end if;
  return new;
end;
$$;

create trigger saves_reset_processing
  before update on public.saves
  for each row execute function public.saves_reset_processing();

/*
  Hands out saves that are due for processing and marks them 'processing'. Skips rows another
  worker holds, so concurrent calls never describe the same save twice. Limited to one user
  unless `for_user` is null (the reprocess job), and to one save when `only_save` is given.
*/
create function public.claim_saves(for_user uuid, only_save uuid, max_count int)
returns table (
  id uuid, user_id uuid, claim_id uuid, attempts int, url text, title text, site_name text,
  image_full_path text, fingerprint jsonb, captured_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select s.id from public.saves s
    where s.deleted_at is null
      and s.image_full_path is not null
      and (for_user is null or s.user_id = for_user)
      and (only_save is null or s.id = only_save)
      and (
        (s.status = 'pending' and s.next_attempt_at <= now())
        or (s.status = 'processing' and s.claimed_at < now() - interval '10 minutes')
      )
    order by s.next_attempt_at
    limit greatest(max_count, 0)
    for update skip locked
  )
  update public.saves s set
    status = 'processing',
    claimed_at = now(),
    claim_id = gen_random_uuid(),
    attempts = s.attempts + 1
  from due
  where s.id = due.id
  returning s.id, s.user_id, s.claim_id, s.attempts, s.url, s.title, s.site_name,
    s.image_full_path, s.fingerprint, s.captured_at;
end;
$$;

/* Writes the model's output, if the claim is still current. Returns whether it wrote. */
create function public.complete_save(
  save_id uuid, claim uuid, new_description text, new_recall_phrases text[], new_tags text[],
  new_prompt_version int, new_embedding extensions.vector(1024)
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.saves set
    status = 'ready',
    error = null,
    description = new_description,
    recall_phrases = new_recall_phrases,
    tags = new_tags,
    prompt_version = new_prompt_version,
    embedding = new_embedding,
    attempts = 0,
    claimed_at = null,
    claim_id = null
  where id = save_id and claim_id = claim and deleted_at is null;
  return found;
end;
$$;

/*
  Records a failed try. With `retry_at`, the save waits as 'pending' (the error stays visible)
  and is tried again then; without it, the save is 'failed' until someone retries it.
*/
create function public.fail_save(save_id uuid, claim uuid, message text, retry_at timestamptz)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.saves set
    status = case when retry_at is null then 'failed' else 'pending' end,
    error = message,
    next_attempt_at = coalesce(retry_at, next_attempt_at),
    claimed_at = null,
    claim_id = null
  where id = save_id and claim_id = claim;
  return found;
end;
$$;

/* When the user presses Retry on a failed save. Runs as the caller, so it only reaches their saves. */
create function public.retry_save(save_id uuid) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.saves set status = 'pending', error = null, attempts = 0, next_attempt_at = now()
  where id = save_id and user_id = (select auth.uid()) and status = 'failed'
    and deleted_at is null;
  return found;
end;
$$;

/*
  The "Reprocess all" job: queues every save described with an older prompt (or never
  described) to be described again. Existing descriptions stay searchable until replaced.
*/
create function public.request_reprocess(current_version int) returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  queued int;
begin
  update public.saves set status = 'pending', error = null, attempts = 0, next_attempt_at = now()
  where deleted_at is null
    and status in ('ready', 'failed')
    and (prompt_version is null or prompt_version < current_version);
  get diagnostics queued = row_count;
  return queued;
end;
$$;

/* How many of a user's saves are waiting, and when the next one is due. */
create function public.processing_backlog(for_user uuid)
returns table (waiting int, next_due timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int, min(next_attempt_at)
  from public.saves
  where deleted_at is null and image_full_path is not null
    and (for_user is null or user_id = for_user)
    and status in ('pending', 'processing');
$$;

-- The queue functions are for Edge Functions only (they run with the secret key).
revoke execute on function public.claim_saves(uuid, uuid, int) from public, anon, authenticated;
revoke execute on function public.complete_save(uuid, uuid, text, text[], text[], int, extensions.vector)
  from public, anon, authenticated;
revoke execute on function public.fail_save(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.request_reprocess(int) from public, anon, authenticated;
revoke execute on function public.processing_backlog(uuid) from public, anon, authenticated;
grant execute on function public.claim_saves(uuid, uuid, int) to service_role;
grant execute on function public.complete_save(uuid, uuid, text, text[], text[], int, extensions.vector)
  to service_role;
grant execute on function public.fail_save(uuid, uuid, text, timestamptz) to service_role;
grant execute on function public.request_reprocess(int) to service_role;
grant execute on function public.processing_backlog(uuid) to service_role;
revoke execute on function public.retry_save(uuid) from public, anon;
grant execute on function public.retry_save(uuid) to authenticated;

-- ---- Hybrid search ----------------------------------------------------------------------

/*
  The caller's saves that best match a query: nearest by embedding (top `match_count`) and
  best by keywords (top `match_count`), merged with reciprocal rank fusion. Keyword matching
  ORs the query's words, because memory-style queries are long and rarely match every word.
  Runs as the caller, so row-level security keeps it to their own saves.
*/
create function public.search_saves(
  query_text text,
  query_embedding extensions.vector(1024),
  match_count int default 50,
  rrf_k int default 60
)
returns table (
  id uuid, score double precision, vector_rank int, keyword_rank int, title text,
  site_name text, url text, description text, recall_phrases text[], tags text[]
)
language sql
stable
security invoker
set search_path = ''
as $$
  with live as (
    select s.* from public.saves s
    where s.user_id = (select auth.uid()) and s.deleted_at is null
  ),
  q as (
    select nullif(replace(plainto_tsquery('english', query_text)::text, ' & ', ' | '), '')::tsquery
      as tsq
  ),
  semantic as (
    select l.id,
      row_number() over (order by l.embedding operator(extensions.<=>) query_embedding)::int
        as rank
    from live l
    where query_embedding is not null and l.embedding is not null
    order by l.embedding operator(extensions.<=>) query_embedding
    limit match_count
  ),
  keyword as (
    select l.id,
      row_number() over (order by ts_rank_cd(l.search_tsv, q.tsq) desc, l.captured_at desc)::int
        as rank
    from live l, q
    where q.tsq is not null and l.search_tsv @@ q.tsq
    order by ts_rank_cd(l.search_tsv, q.tsq) desc, l.captured_at desc
    limit match_count
  ),
  fused as (
    select coalesce(semantic.id, keyword.id) as id,
      coalesce(1.0 / (rrf_k + semantic.rank), 0) + coalesce(1.0 / (rrf_k + keyword.rank), 0)
        as score,
      semantic.rank as vector_rank,
      keyword.rank as keyword_rank
    from semantic full outer join keyword on semantic.id = keyword.id
  )
  select f.id, f.score::double precision, f.vector_rank, f.keyword_rank, l.title, l.site_name,
    l.url, l.description, l.recall_phrases, l.tags
  from fused f join live l on l.id = f.id
  order by f.score desc, l.captured_at desc
  limit match_count;
$$;

revoke execute on function public.search_saves(text, extensions.vector, int, int) from public, anon;
grant execute on function public.search_saves(text, extensions.vector, int, int) to authenticated;

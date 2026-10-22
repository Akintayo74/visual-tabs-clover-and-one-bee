-- Phase 5: personal notes that sync between devices, and "More like this".

-- ---- Notes ------------------------------------------------------------------------------

-- When the note was last edited (on the device where it was typed). The latest edit wins.
alter table public.saves add column note_updated_at timestamptz;

/*
  Sets a save's note, unless a later edit (from another device) is already stored. An empty
  note clears it. Runs as the caller, so it only reaches their own saves. A note edit never
  touches the snapshot, so the save isn't described again; the keyword index picks it up.

  Returns { found, applied, note, note_updated_at }: whether the save exists (and isn't
  deleted), whether this edit is the one now stored, and the note as stored now.
*/
create function public.set_note(save_id uuid, new_note text, edited_at timestamptz)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target public.saves;
  cleaned text := nullif(btrim(left(coalesce(new_note, ''), 4000)), '');
begin
  if edited_at is null then
    raise exception 'set_note needs edited_at' using errcode = '22023';
  end if;
  select * into target from public.saves
    where id = save_id and user_id = (select auth.uid()) and deleted_at is null
    for update;
  if not found then
    return jsonb_build_object('found', false, 'applied', false, 'note', null,
      'note_updated_at', null);
  end if;
  if target.note_updated_at is not null and target.note_updated_at >= edited_at then
    return jsonb_build_object('found', true, 'applied', false, 'note', target.note,
      'note_updated_at', target.note_updated_at);
  end if;
  update public.saves set note = cleaned, note_updated_at = edited_at
  where id = save_id
  returning * into target;
  return jsonb_build_object('found', true, 'applied', true, 'note', target.note,
    'note_updated_at', target.note_updated_at);
end;
$$;

revoke execute on function public.set_note(uuid, text, timestamptz) from public, anon;
grant execute on function public.set_note(uuid, text, timestamptz) to authenticated;

-- The reranker compares the query with the note too, so search_saves returns it.
drop function public.search_saves(text, extensions.vector, int, int);

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
  site_name text, url text, description text, recall_phrases text[], tags text[], note text
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
    l.url, l.description, l.recall_phrases, l.tags, l.note
  from fused f join live l on l.id = f.id
  order by f.score desc, l.captured_at desc
  limit match_count;
$$;

revoke execute on function public.search_saves(text, extensions.vector, int, int) from public, anon;
grant execute on function public.search_saves(text, extensions.vector, int, int) to authenticated;

-- ---- More like this ---------------------------------------------------------------------

/*
  The caller's saves nearest to one of their saves by embedding (screenshot plus description),
  closest first. Empty when that save hasn't been described yet. No model call is needed:
  it compares embeddings already stored.
*/
create function public.similar_saves(save_id uuid, match_count int default 24)
returns table (id uuid, distance double precision)
language sql
stable
security invoker
set search_path = ''
as $$
  with source as (
    select s.embedding from public.saves s
    where s.id = save_id and s.user_id = (select auth.uid()) and s.deleted_at is null
      and s.embedding is not null
  )
  select s.id, (s.embedding operator(extensions.<=>) source.embedding)::double precision
  from public.saves s, source
  where s.user_id = (select auth.uid()) and s.deleted_at is null and s.embedding is not null
    and s.id <> save_id
  order by s.embedding operator(extensions.<=>) source.embedding
  limit least(greatest(match_count, 0), 100);
$$;

revoke execute on function public.similar_saves(uuid, int) from public, anon;
grant execute on function public.similar_saves(uuid, int) to authenticated;

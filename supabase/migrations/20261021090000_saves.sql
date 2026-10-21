-- Phase 3: saves, search events and screenshot storage. See PLAN.md "Schema".

create extension if not exists vector with schema extensions;

create table public.saves (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Normalised page URL. Re-saving the same page replaces the snapshot instead of adding a save.
  dedupe_key text not null,
  url text not null,
  canonical_url text,
  title text not null default '',
  site_name text not null default '',
  favicon_url text,
  -- When the site was first saved, and when the current snapshot was taken (both from the client).
  created_at timestamptz not null,
  captured_at timestamptz not null,
  -- Set by the server on every change; clients pull changes since their last sync with it.
  updated_at timestamptz not null default now(),
  -- Deleted saves stay as tombstones so other devices learn about the delete.
  deleted_at timestamptz,
  -- Processing by the model (Phase 4). New uploads wait as 'pending'.
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'ready', 'failed')),
  error text,
  image_full_path text,
  image_card_path text,
  width int,
  height int,
  fingerprint jsonb,
  description text,
  recall_phrases text[],
  tags text[],
  palette text[] not null default '{}',
  fonts text[] not null default '{}',
  note text,
  prompt_version int,
  embedding extensions.vector(1024)
);

-- One live save per page per user. Tombstones don't count, so a deleted page can be saved again.
create unique index saves_user_dedupe_key on public.saves (user_id, dedupe_key)
  where deleted_at is null;
create index saves_user_updated_at on public.saves (user_id, updated_at);

create function public.touch_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger saves_touch_updated_at
  before insert or update on public.saves
  for each row execute function public.touch_updated_at();

alter table public.saves enable row level security;

create policy "Users read their own saves" on public.saves
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users add their own saves" on public.saves
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users change their own saves" on public.saves
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete their own saves" on public.saves
  for delete to authenticated using ((select auth.uid()) = user_id);

create table public.search_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  query text not null,
  clicked_save_id uuid references public.saves (id) on delete set null,
  rank int,
  created_at timestamptz not null default now()
);

create index search_events_user_created_at on public.search_events (user_id, created_at);

alter table public.search_events enable row level security;

create policy "Users read their own search events" on public.search_events
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users add their own search events" on public.search_events
  for insert to authenticated with check ((select auth.uid()) = user_id);

/*
  Uploads one snapshot from a device. Runs as the caller, so row-level security applies.

  - New page: inserts it.
  - Same page already saved from another device under a different id: merges into that save.
  - The newer snapshot (by captured_at) wins; an older one leaves the row as it is.
  - A save deleted after this snapshot was taken stays deleted. A snapshot taken after
    the delete brings it back.

  Returns { row, applied, deleted, replaced_paths }: the save as stored now, whether this
  snapshot is the one stored, whether the save is deleted, and image paths this snapshot
  replaced (for the caller to remove from storage).
*/
create function public.upsert_save(snapshot jsonb) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  incoming_id uuid := (snapshot ->> 'id')::uuid;
  incoming_key text := snapshot ->> 'dedupe_key';
  incoming_at timestamptz := (snapshot ->> 'captured_at')::timestamptz;
  target public.saves;
  replaced text[] := '{}';
  attempt int := 0;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if incoming_id is null or incoming_key is null or incoming_at is null then
    raise exception 'snapshot needs id, dedupe_key and captured_at' using errcode = '22023';
  end if;

  loop
    attempt := attempt + 1;
    select * into target from public.saves
      where id = incoming_id and user_id = uid for update;
    if not found then
      select * into target from public.saves
        where user_id = uid and dedupe_key = incoming_key and deleted_at is null for update;
    end if;

    if not found then
      begin
        insert into public.saves (
          id, user_id, dedupe_key, url, canonical_url, title, site_name, favicon_url,
          created_at, captured_at, image_full_path, image_card_path, width, height,
          fingerprint, palette, fonts
        ) values (
          incoming_id, uid, incoming_key, snapshot ->> 'url', snapshot ->> 'canonical_url',
          coalesce(snapshot ->> 'title', ''), coalesce(snapshot ->> 'site_name', ''),
          snapshot ->> 'favicon_url',
          coalesce((snapshot ->> 'created_at')::timestamptz, incoming_at), incoming_at,
          snapshot ->> 'image_full_path', snapshot ->> 'image_card_path',
          (snapshot ->> 'width')::int, (snapshot ->> 'height')::int,
          snapshot -> 'fingerprint',
          coalesce(array(select jsonb_array_elements_text(snapshot -> 'palette')), '{}'),
          coalesce(array(select jsonb_array_elements_text(snapshot -> 'fonts')), '{}')
        )
        returning * into target;
        return jsonb_build_object(
          'row', to_jsonb(target) - 'embedding', 'applied', true, 'deleted', false,
          'replaced_paths', to_jsonb(replaced)
        );
      exception when unique_violation then
        -- Another device saved the same page at the same moment; merge into its save.
        if attempt >= 3 then
          raise;
        end if;
        continue;
      end;
    end if;
    exit;
  end loop;

  if target.deleted_at is not null then
    if incoming_at <= target.deleted_at or exists (
      select 1 from public.saves
      where user_id = uid and dedupe_key = target.dedupe_key and deleted_at is null
        and id <> target.id
    ) then
      return jsonb_build_object(
        'row', to_jsonb(target) - 'embedding', 'applied', false, 'deleted', true,
        'replaced_paths', to_jsonb(replaced)
      );
    end if;
  elsif incoming_at < target.captured_at then
    return jsonb_build_object(
      'row', to_jsonb(target) - 'embedding', 'applied', false, 'deleted', false,
      'replaced_paths', to_jsonb(replaced)
    );
  end if;

  replaced := array_remove(array[
    nullif(target.image_full_path, snapshot ->> 'image_full_path'),
    nullif(target.image_card_path, snapshot ->> 'image_card_path')
  ], null);

  update public.saves set
    deleted_at = null,
    dedupe_key = incoming_key,
    url = snapshot ->> 'url',
    canonical_url = snapshot ->> 'canonical_url',
    title = coalesce(snapshot ->> 'title', ''),
    site_name = coalesce(snapshot ->> 'site_name', ''),
    favicon_url = snapshot ->> 'favicon_url',
    created_at = least(target.created_at,
      coalesce((snapshot ->> 'created_at')::timestamptz, target.created_at)),
    captured_at = incoming_at,
    image_full_path = snapshot ->> 'image_full_path',
    image_card_path = snapshot ->> 'image_card_path',
    width = (snapshot ->> 'width')::int,
    height = (snapshot ->> 'height')::int,
    fingerprint = snapshot -> 'fingerprint',
    palette = coalesce(array(select jsonb_array_elements_text(snapshot -> 'palette')), '{}'),
    fonts = coalesce(array(select jsonb_array_elements_text(snapshot -> 'fonts')), '{}'),
    -- A new snapshot needs describing again (Phase 4).
    status = 'pending',
    error = null
  where id = target.id
  returning * into target;

  return jsonb_build_object(
    'row', to_jsonb(target) - 'embedding', 'applied', true, 'deleted', false,
    'replaced_paths', to_jsonb(replaced)
  );
end;
$$;

/*
  Deletes a save, keeping a tombstone so other devices remove it too. Returns the image
  paths the save had, for the caller to remove from storage. Deleting an unknown id is a no-op.
*/
create function public.delete_save(save_id uuid) returns text[]
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target public.saves;
begin
  select * into target from public.saves
    where id = save_id and user_id = (select auth.uid()) for update;
  if not found or target.deleted_at is not null then
    return '{}';
  end if;
  update public.saves set
    deleted_at = now(),
    image_full_path = null,
    image_card_path = null,
    fingerprint = null,
    description = null,
    recall_phrases = null,
    tags = null,
    note = null,
    embedding = null
  where id = save_id;
  return array_remove(array[target.image_full_path, target.image_card_path], null);
end;
$$;

revoke execute on function public.upsert_save(jsonb) from public, anon;
revoke execute on function public.delete_save(uuid) from public, anon;
grant execute on function public.upsert_save(jsonb) to authenticated;
grant execute on function public.delete_save(uuid) to authenticated;

-- Screenshots: private, one folder per user ("<user id>/<save id>/<file>").
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('screenshots', 'screenshots', false, 10485760, array['image/webp']);

create policy "Users read their own screenshots" on storage.objects
  for select to authenticated
  using (bucket_id = 'screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Users upload their own screenshots" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Users replace their own screenshots" on storage.objects
  for update to authenticated
  using (bucket_id = 'screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Users delete their own screenshots" on storage.objects
  for delete to authenticated
  using (bucket_id = 'screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text);

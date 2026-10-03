-- 20261003170000_notes_channel_and_search_kind.sql DESTRUCTIVE: constraint + function replace, no data loss
-- Rollback: restore old chat_channels_channel_id_check (dm|group), channel_type_check (dm|group), chat_channels_shape (no owner_user_id), old chat_channel_member (no notes branch), old chat_message_delete (30 min for all), old 7-arg chat_message_search; drop notes_channel_ensure; drop column owner_user_id.
BEGIN;

ALTER TABLE public.chat_channels ADD COLUMN owner_user_id uuid REFERENCES auth.users(id);

ALTER TABLE public.chat_channels
  DROP CONSTRAINT chat_channels_channel_id_check,
  ADD CONSTRAINT chat_channels_channel_id_check CHECK (channel_id ~ '^(dm|group|notes)__[a-f0-9-]{36}__.+$'),
  DROP CONSTRAINT chat_channels_channel_type_check,
  ADD CONSTRAINT chat_channels_channel_type_check CHECK (channel_type = ANY (ARRAY['dm','group','notes'])),
  DROP CONSTRAINT chat_channels_shape,
  ADD CONSTRAINT chat_channels_shape CHECK (
       (channel_type = 'dm' AND entity_id IS NULL AND dm_user_a IS NOT NULL AND dm_user_b IS NOT NULL AND dm_user_a < dm_user_b AND owner_user_id IS NULL)
    OR (channel_type = 'group' AND entity_id IS NOT NULL AND dm_user_a IS NULL AND dm_user_b IS NULL AND owner_user_id IS NULL)
    OR (channel_type = 'plan_period' AND entity_id IS NOT NULL AND dm_user_a IS NULL AND dm_user_b IS NULL AND owner_user_id IS NULL)
    OR (channel_type = 'notes' AND entity_id IS NULL AND dm_user_a IS NULL AND dm_user_b IS NULL AND owner_user_id IS NOT NULL
        AND channel_id = 'notes__' || workspace_id::text || '__' || owner_user_id::text));

CREATE OR REPLACE FUNCTION public.chat_channel_member(p_channel_id text, p_user_id uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.chat_channels c
    JOIN public.workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = p_user_id AND wm.active = true
    WHERE c.channel_id = p_channel_id
      AND (
        (c.channel_type = 'dm' AND p_user_id IN (c.dm_user_a, c.dm_user_b)
          AND EXISTS (SELECT 1 FROM public.workspace_members pa WHERE pa.workspace_id = c.workspace_id AND pa.user_id = c.dm_user_a AND pa.active = true)
          AND EXISTS (SELECT 1 FROM public.workspace_members pb WHERE pb.workspace_id = c.workspace_id AND pb.user_id = c.dm_user_b AND pb.active = true))
        OR (c.channel_type = 'group' AND EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.group_id = c.entity_id AND gm.user_id = p_user_id))
        OR (c.channel_type = 'plan_period')
        OR (c.channel_type = 'notes' AND c.owner_user_id = p_user_id)
      )
  );
$function$;

CREATE FUNCTION public.notes_channel_ensure(p_workspace_id uuid, p_trace_id uuid)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_actor uuid := auth.uid(); v_id text; v_n int;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF p_trace_id IS NULL THEN RAISE EXCEPTION 'trace id required'; END IF;
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  v_id := 'notes__' || p_workspace_id::text || '__' || v_actor::text;
  INSERT INTO public.chat_channels (channel_id, workspace_id, channel_type, owner_user_id)
  VALUES (v_id, p_workspace_id, 'notes', v_actor)
  ON CONFLICT (channel_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    PERFORM public.audit_log_write('notes_channel_ensure','success',p_trace_id,p_workspace_id,'chat_channel',v_id,'{}'::jsonb);
  END IF;
  RETURN v_id;
END $function$;
REVOKE ALL ON FUNCTION public.notes_channel_ensure(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.notes_channel_ensure(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.chat_message_delete(p_message_ids text[], p_channel_id text, p_trace_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare v_actor uuid := auth.uid(); v_blocked int; v_deleted int; v_notes boolean;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  if coalesce(cardinality(p_message_ids), 0) = 0 or cardinality(p_message_ids) > 100 then raise exception 'select between 1 and 100 messages'; end if;
  perform set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  if not public.chat_channel_member(p_channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  select c.channel_type = 'notes' into v_notes from public.chat_channels c where c.channel_id = p_channel_id;
  select count(*) into v_blocked from public.chat_message_marks where message_id = any(p_message_ids);
  if v_blocked > 0 then raise exception 'marked messages cannot be deleted'; end if;
  update public.chat_messages
     set deleted_at = now(), body = null, mentions = null, attachment_asset_ids = null,
         attachment_meta = null, shared_post_ids = null, shared_brief_ids = null
   where id = any(p_message_ids) and channel_id = p_channel_id and sender_user_id = v_actor
     and deleted_at is null and (v_notes or created_at >= now() - interval '30 minutes');
  get diagnostics v_deleted = row_count;
  if v_deleted <> cardinality(p_message_ids) then raise exception 'only your own messages from the last 30 minutes can be deleted'; end if;
  update public.inbox_entries set deleted_at = now()
   where entity_type = 'chat_channel' and entity_id = p_channel_id and event_type = 'mention'
     and payload->>'message_id' = any(p_message_ids) and deleted_at is null;
end $function$;

DROP FUNCTION IF EXISTS public.chat_message_search(uuid, text, uuid, text, timestamptz, text, integer);
CREATE FUNCTION public.chat_message_search(
  p_workspace_id uuid, p_query text, p_trace_id uuid, p_channel_id text DEFAULT NULL,
  p_before_created_at timestamptz DEFAULT NULL, p_before_id text DEFAULT NULL,
  p_limit integer DEFAULT 30, p_kind text DEFAULT NULL)
 RETURNS SETOF public.chat_messages LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp'
AS $function$
  with terms as (
    select string_agg('''' || t || ''':*', ' & ') as q
    from regexp_split_to_table(
      lower(regexp_replace(coalesce(p_query, ''), '[&|!():*<>''"\\]', ' ', 'g')),
      '\s+') as t
    where length(t) > 0
  )
  select m.*
  from public.chat_messages m, terms
  where m.workspace_id = p_workspace_id
    and m.deleted_at is null
    and (p_channel_id is null or m.channel_id = p_channel_id)
    and (
         (terms.q is null and p_kind is not null)
      or (terms.q is not null
          and length(trim(p_query)) between 2 and 100
          and to_tsvector('simple'::regconfig, coalesce(m.body, ''::text))
              @@ to_tsquery('simple'::regconfig, terms.q)))
    and (
         p_kind is null
      or (p_kind = 'link' and m.body ~* 'https?://')
      or (p_kind in ('photo','voice','file') and exists (
            select 1
            from jsonb_each(case when jsonb_typeof(m.attachment_meta) = 'object' then m.attachment_meta else '{}'::jsonb end) e
            where case p_kind
                    when 'photo' then coalesce(e.value->>'mime','') like 'image/%'
                    when 'voice' then coalesce(e.value->>'mime','') like 'audio/%'
                    else not (coalesce(e.value->>'mime','') like 'image/%' or coalesce(e.value->>'mime','') like 'audio/%')
                  end)))
    and (p_before_created_at is null
         or m.created_at < p_before_created_at
         or (m.created_at = p_before_created_at and p_before_id is not null and m.id < p_before_id))
  order by m.created_at desc, m.id desc
  limit least(greatest(coalesce(p_limit, 30), 1), 50);
$function$;
REVOKE ALL ON FUNCTION public.chat_message_search(uuid, text, uuid, text, timestamptz, text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_message_search(uuid, text, uuid, text, timestamptz, text, integer, text) TO authenticated;

COMMIT;

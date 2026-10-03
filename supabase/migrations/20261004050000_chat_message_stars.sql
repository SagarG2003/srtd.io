-- 20261004050000_chat_message_stars.sql (project movnexawfhsyuluspxoc). New objects only.
-- Rollback: DROP TRIGGER chat_messages_stars_on_delete ON public.chat_messages; DROP FUNCTION public.chat_messages_stars_on_delete(), public.chat_message_star_set(text[], text, boolean, uuid), public.chat_message_starred_list(uuid, uuid, text, text, timestamptz, text, integer); DROP TABLE public.chat_message_stars;
BEGIN;

-- No FK to chat_messages: it is partitioned with PK (id, created_at); same pattern as chat_message_marks.
CREATE TABLE public.chat_message_stars (
  user_id            uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message_id         text        NOT NULL,
  message_created_at timestamptz NOT NULL,
  channel_id         text        NOT NULL REFERENCES public.chat_channels(channel_id) ON DELETE CASCADE,
  workspace_id       uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  starred_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, message_id)
);
CREATE INDEX chat_message_stars_user_ws_idx      ON public.chat_message_stars (user_id, workspace_id, message_created_at DESC);
CREATE INDEX chat_message_stars_user_channel_idx ON public.chat_message_stars (user_id, channel_id, message_created_at DESC);
CREATE INDEX chat_message_stars_message_idx      ON public.chat_message_stars (message_id);
CREATE INDEX chat_message_stars_channel_idx      ON public.chat_message_stars (channel_id);
CREATE INDEX chat_message_stars_workspace_idx    ON public.chat_message_stars (workspace_id);

ALTER TABLE public.chat_message_stars ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chat_message_stars FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.chat_message_stars TO authenticated;
CREATE POLICY chat_message_stars_select_own ON public.chat_message_stars
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND public.chat_channel_member(channel_id, (SELECT auth.uid())));

CREATE FUNCTION public.chat_message_star_set(p_message_ids text[], p_channel_id text, p_starred boolean, p_trace_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare v_actor uuid := auth.uid(); v_ws uuid; v_found int; v_n int;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  if p_trace_id is null then raise exception 'trace id required'; end if;
  if p_starred is null then raise exception 'starred flag required'; end if;
  if coalesce(cardinality(p_message_ids), 0) = 0 or cardinality(p_message_ids) > 100 then raise exception 'select between 1 and 100 messages'; end if;
  perform set_config('app.trace_id', p_trace_id::text, true);
  if not public.chat_channel_member(p_channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  select c.workspace_id into v_ws from public.chat_channels c where c.channel_id = p_channel_id;
  if p_starred then
    select count(*) into v_found from public.chat_messages m
     where m.id = any(p_message_ids) and m.channel_id = p_channel_id and m.deleted_at is null
       and m.created_at > public.chat_cleared_at(p_channel_id, v_actor);
    if v_found <> (select count(distinct x) from unnest(p_message_ids) x) then raise exception 'message not found'; end if;
    insert into public.chat_message_stars (user_id, message_id, message_created_at, channel_id, workspace_id)
    select v_actor, m.id, m.created_at, m.channel_id, m.workspace_id
      from public.chat_messages m
     where m.id = any(p_message_ids) and m.channel_id = p_channel_id and m.deleted_at is null
    on conflict (user_id, message_id) do nothing;
  else
    delete from public.chat_message_stars
     where user_id = v_actor and channel_id = p_channel_id and message_id = any(p_message_ids);
  end if;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform public.audit_log_write(case when p_starred then 'chat_message_star' else 'chat_message_unstar' end,
      'success', p_trace_id, v_ws, 'chat_channel', p_channel_id, jsonb_build_object('count', v_n));
  end if;
end $function$;
REVOKE ALL ON FUNCTION public.chat_message_star_set(text[], text, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_message_star_set(text[], text, boolean, uuid) TO authenticated;

-- Read-only, SECURITY INVOKER: RLS on chat_messages and chat_message_stars applies (same model as chat_message_search).
CREATE FUNCTION public.chat_message_starred_list(
  p_workspace_id uuid, p_trace_id uuid, p_channel_id text DEFAULT NULL, p_query text DEFAULT NULL,
  p_before_created_at timestamptz DEFAULT NULL, p_before_id text DEFAULT NULL, p_limit integer DEFAULT 30)
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
  from public.chat_message_stars s
  join public.chat_messages m on m.id = s.message_id and m.created_at = s.message_created_at
  cross join terms
  where s.user_id = auth.uid()
    and s.workspace_id = p_workspace_id
    and (p_channel_id is null or s.channel_id = p_channel_id)
    and m.deleted_at is null
    and (terms.q is null
         or (length(trim(p_query)) between 2 and 100
             and to_tsvector('simple'::regconfig, coalesce(m.body, ''::text))
                 @@ to_tsquery('simple'::regconfig, terms.q)))
    and (p_before_created_at is null
         or m.created_at < p_before_created_at
         or (m.created_at = p_before_created_at and p_before_id is not null and m.id < p_before_id))
  order by m.created_at desc, m.id desc
  limit least(greatest(coalesce(p_limit, 30), 1), 50);
$function$;
REVOKE ALL ON FUNCTION public.chat_message_starred_list(uuid, uuid, text, text, timestamptz, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_message_starred_list(uuid, uuid, text, text, timestamptz, text, integer) TO authenticated;

-- Deleting a message removes its stars (mirrors chat_messages_reminders_on_delete).
CREATE FUNCTION public.chat_messages_stars_on_delete()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
begin
  delete from public.chat_message_stars where message_id = new.id;
  return null;
end $function$;
REVOKE ALL ON FUNCTION public.chat_messages_stars_on_delete() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER chat_messages_stars_on_delete
  AFTER UPDATE OF deleted_at ON public.chat_messages
  FOR EACH ROW WHEN (old.deleted_at IS NULL AND new.deleted_at IS NOT NULL)
  EXECUTE FUNCTION public.chat_messages_stars_on_delete();

COMMIT;

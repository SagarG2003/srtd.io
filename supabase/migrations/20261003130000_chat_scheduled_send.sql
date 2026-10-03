-- Applied live 3 Oct 2026 via MCP on project movnexawfhsyuluspxoc. This file is
-- the record; do not execute. Definitions reproduce the live catalog
-- (pg_get_functiondef, pg_constraint, pg_indexes, pg_policies, relacl, proacl).
--
-- Chat scheduled send: a member schedules a chat message for later; a service
-- dispatcher sends it at send_at through chat_message_send and records the
-- outcome in the sender's inbox.
--   1. inbox_entries.event_type gains scheduled_sent (tier active) and
--      scheduled_failed (tier urgent).
--   2. chat_scheduled_messages: RLS on, owner SELECT only. Clients never write
--      it directly; all writes go through the SECURITY DEFINER procs below.
--   3. Internal helpers (no grants): chat_scheduled_outcome_entry,
--      chat_scheduled_clear_failed.
--   4. Member procs (authenticated): chat_message_schedule,
--      chat_scheduled_update, chat_scheduled_cancel, chat_scheduled_send_now.
--   5. Dispatcher procs (service_role only): chat_scheduled_due,
--      chat_scheduled_dispatch.
--   6. inbox_mark_read_events (authenticated): mark a caller's unread entries
--      of the given event types read.

-- ---------------------------------------------------------------------------
-- 1. Inbox event types
-- ---------------------------------------------------------------------------
ALTER TABLE public.inbox_entries DROP CONSTRAINT IF EXISTS inbox_entries_event_type_check;
ALTER TABLE public.inbox_entries ADD CONSTRAINT inbox_entries_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'comment','mention','stage_change','comment_resolved','brief_created',
    'brief_closed','asset_uploaded','asset_version_added','invite',
    'trial_warning','billing_failure','system','checkpoints_added',
    'post_ready','checkpoint_reopened','checkpoint_asked',
    'scheduled_sent','scheduled_failed']));

-- ---------------------------------------------------------------------------
-- 2. chat_scheduled_messages
-- ---------------------------------------------------------------------------
CREATE TABLE public.chat_scheduled_messages (
  id uuid NOT NULL,
  channel_id text NOT NULL,
  workspace_id uuid NOT NULL,
  sender_user_id uuid NOT NULL,
  body text,
  mentions jsonb,
  attachment_asset_ids uuid[],
  shared_post_ids uuid[],
  shared_brief_ids uuid[],
  reply_to_message_id text,
  attachment_meta jsonb,
  send_at timestamp with time zone NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'::text,
  failure_reason text,
  sent_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT chat_scheduled_messages_pkey PRIMARY KEY (id),
  CONSTRAINT chat_scheduled_messages_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.chat_channels(channel_id) ON DELETE CASCADE,
  CONSTRAINT chat_scheduled_messages_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT chat_scheduled_messages_sender_user_id_fkey FOREIGN KEY (sender_user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT chat_scheduled_messages_body_check CHECK (((body IS NULL) OR (char_length(body) <= 5000))),
  CONSTRAINT chat_scheduled_messages_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'sent'::text, 'cancelled'::text, 'failed'::text])))
);

CREATE INDEX chat_scheduled_due_idx ON public.chat_scheduled_messages USING btree (send_at) WHERE (status = 'scheduled'::text);
CREATE INDEX chat_scheduled_sender_idx ON public.chat_scheduled_messages USING btree (sender_user_id, channel_id, send_at);
CREATE INDEX chat_scheduled_channel_idx ON public.chat_scheduled_messages USING btree (channel_id);
CREATE INDEX chat_scheduled_workspace_idx ON public.chat_scheduled_messages USING btree (workspace_id);

ALTER TABLE public.chat_scheduled_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY chat_scheduled_select_own ON public.chat_scheduled_messages
  FOR SELECT TO authenticated
  USING ((sender_user_id = auth.uid()));

-- Table privileges mirror live EXACTLY: authenticated SELECT only; anon none;
-- service_role keeps only the REFERENCES/TRIGGER/TRUNCATE/MAINTAIN defaults
-- (the dispatcher reaches the table through SECURITY DEFINER procs).
REVOKE ALL ON public.chat_scheduled_messages FROM anon;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.chat_scheduled_messages FROM service_role;
REVOKE ALL ON public.chat_scheduled_messages FROM authenticated;
GRANT SELECT ON public.chat_scheduled_messages TO authenticated;
-- srtdio_readonly exists only on the hosted project; guard the grant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'srtdio_readonly') THEN
    GRANT SELECT ON public.chat_scheduled_messages TO srtdio_readonly;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Internal helpers (no grants)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.chat_scheduled_outcome_entry(s chat_scheduled_messages, p_event text, p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_type text;
begin
  select channel_type into v_type from public.chat_channels where channel_id = s.channel_id;
  insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  values (s.sender_user_id, s.workspace_id, p_event, 'chat_channel', s.channel_id,
    case when v_type = 'group' then 'groups' else 'people' end, s.channel_id,
    case when p_event = 'scheduled_failed' then 'urgent' else 'active' end, p_payload, null);
end $function$;

CREATE OR REPLACE FUNCTION public.chat_scheduled_clear_failed(p_user_id uuid, p_scheduled_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.inbox_entries set read_at = now()
  where user_id = p_user_id and event_type = 'scheduled_failed' and read_at is null and deleted_at is null
    and payload ->> 'scheduled_id' = p_scheduled_id::text;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Member procs (authenticated)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.chat_message_schedule(p_id uuid, p_channel_id text, p_send_at timestamp with time zone, p_trace_id uuid, p_body text DEFAULT NULL::text, p_mentions jsonb DEFAULT NULL::jsonb, p_attachment_asset_ids uuid[] DEFAULT NULL::uuid[], p_shared_post_ids uuid[] DEFAULT NULL::uuid[], p_shared_brief_ids uuid[] DEFAULT NULL::uuid[], p_reply_to_message_id text DEFAULT NULL::text, p_attachment_meta jsonb DEFAULT NULL::jsonb)
 RETURNS chat_scheduled_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor uuid := auth.uid(); v_ws uuid; v_row public.chat_scheduled_messages;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  if p_id is null or p_trace_id is null then raise exception 'p_id and p_trace_id are required'; end if;
  select * into v_row from public.chat_scheduled_messages where id = p_id;
  if found then
    if v_row.sender_user_id <> v_actor then raise exception 'not found'; end if;
    return v_row;
  end if;
  if coalesce(length(btrim(p_body)), 0) = 0 and coalesce(cardinality(p_attachment_asset_ids), 0) = 0
     and coalesce(cardinality(p_shared_post_ids), 0) = 0 and coalesce(cardinality(p_shared_brief_ids), 0) = 0 then
    raise exception 'message has no body, attachments, shared posts or shared briefs'; end if;
  if length(p_body) > 5000 then raise exception 'body exceeds 5000 characters'; end if;
  if p_send_at is null or p_send_at < now() + interval '1 minute' or p_send_at > now() + interval '365 days' then
    raise exception 'send time must be between 1 minute and 1 year from now'; end if;
  if not public.chat_channel_member(p_channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  select workspace_id into v_ws from public.chat_channels where channel_id = p_channel_id;
  if (select count(*) from public.chat_scheduled_messages where sender_user_id = v_actor and status = 'scheduled') >= 100 then
    raise exception 'too many scheduled messages'; end if;
  if coalesce(cardinality(p_attachment_asset_ids), 0) > 0 and exists (
    select 1 from unnest(p_attachment_asset_ids) vid where not exists (
      select 1 from public.asset_versions v join public.assets a on a.id = v.asset_id
      where v.id = vid and v.workspace_id = v_ws and (a.origin = 'library' or public.chat_attachment_readable(vid, v_actor)))) then
    raise exception 'attachment not available'; end if;
  if p_reply_to_message_id is not null and not exists (
    select 1 from public.chat_messages m where m.id = p_reply_to_message_id and m.channel_id = p_channel_id) then
    raise exception 'reply target not in this chat'; end if;
  perform public.chat_mentions_resolve(p_channel_id, v_actor, p_mentions);
  insert into public.chat_scheduled_messages (id, channel_id, workspace_id, sender_user_id, body, mentions, attachment_asset_ids,
    shared_post_ids, shared_brief_ids, reply_to_message_id, attachment_meta, send_at)
  values (p_id, p_channel_id, v_ws, v_actor, p_body, p_mentions, p_attachment_asset_ids, p_shared_post_ids, p_shared_brief_ids,
    p_reply_to_message_id, p_attachment_meta, p_send_at)
  returning * into v_row;
  perform public.audit_log_write('chat_message_schedule', 'success', p_trace_id, v_ws, 'chat_channel', p_channel_id,
    jsonb_build_object('scheduled_id', p_id, 'send_at', p_send_at));
  return v_row;
end $function$;

CREATE OR REPLACE FUNCTION public.chat_scheduled_update(p_id uuid, p_send_at timestamp with time zone, p_body text, p_mentions jsonb, p_trace_id uuid)
 RETURNS chat_scheduled_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor uuid := auth.uid(); v_row public.chat_scheduled_messages;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  if p_trace_id is null then raise exception 'p_trace_id is required'; end if;
  select * into v_row from public.chat_scheduled_messages
  where id = p_id and sender_user_id = v_actor and status in ('scheduled', 'failed') for update;
  if not found then raise exception 'scheduled message not found'; end if;
  if p_send_at is null or p_send_at < now() + interval '1 minute' or p_send_at > now() + interval '365 days' then
    raise exception 'send time must be between 1 minute and 1 year from now'; end if;
  if length(p_body) > 5000 then raise exception 'body exceeds 5000 characters'; end if;
  if coalesce(length(btrim(p_body)), 0) = 0 and coalesce(cardinality(v_row.attachment_asset_ids), 0) = 0
     and coalesce(cardinality(v_row.shared_post_ids), 0) = 0 and coalesce(cardinality(v_row.shared_brief_ids), 0) = 0 then
    raise exception 'message has no body, attachments, shared posts or shared briefs'; end if;
  if v_row.status = 'failed' and (select count(*) from public.chat_scheduled_messages where sender_user_id = v_actor and status = 'scheduled') >= 100 then
    raise exception 'too many scheduled messages'; end if;
  perform public.chat_mentions_resolve(v_row.channel_id, v_actor, p_mentions);
  update public.chat_scheduled_messages
  set send_at = p_send_at, body = p_body, mentions = p_mentions, status = 'scheduled', failure_reason = null, updated_at = now()
  where id = p_id returning * into v_row;
  perform public.chat_scheduled_clear_failed(v_actor, p_id);
  perform public.audit_log_write('chat_scheduled_update', 'success', p_trace_id, v_row.workspace_id, 'chat_channel', v_row.channel_id,
    jsonb_build_object('scheduled_id', p_id, 'send_at', p_send_at));
  return v_row;
end $function$;

CREATE OR REPLACE FUNCTION public.chat_scheduled_cancel(p_id uuid, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor uuid := auth.uid(); v_ws uuid; v_ch text;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  if p_trace_id is null then raise exception 'p_trace_id is required'; end if;
  update public.chat_scheduled_messages set status = 'cancelled', updated_at = now()
  where id = p_id and sender_user_id = v_actor and status in ('scheduled', 'failed')
  returning workspace_id, channel_id into v_ws, v_ch;
  if v_ws is null then raise exception 'scheduled message not found'; end if;
  perform public.chat_scheduled_clear_failed(v_actor, p_id);
  perform public.audit_log_write('chat_scheduled_cancel', 'success', p_trace_id, v_ws, 'chat_channel', v_ch, jsonb_build_object('scheduled_id', p_id));
end $function$;

CREATE OR REPLACE FUNCTION public.chat_scheduled_send_now(p_id uuid, p_trace_id uuid)
 RETURNS chat_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor uuid := auth.uid(); s public.chat_scheduled_messages; v_row public.chat_messages;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  if p_trace_id is null then raise exception 'p_trace_id is required'; end if;
  select * into s from public.chat_scheduled_messages
  where id = p_id and sender_user_id = v_actor and status in ('scheduled', 'failed') for update;
  if not found then raise exception 'scheduled message not found'; end if;
  v_row := public.chat_message_send(s.id, s.channel_id, p_trace_id, s.body, s.mentions, s.attachment_asset_ids,
    s.shared_post_ids, s.reply_to_message_id, s.attachment_meta, s.shared_brief_ids, null);
  update public.chat_scheduled_messages set status = 'sent', sent_at = now(), failure_reason = null, updated_at = now() where id = p_id;
  perform public.chat_scheduled_clear_failed(v_actor, p_id);
  perform public.audit_log_write('chat_scheduled_send_now', 'success', p_trace_id, s.workspace_id, 'chat_message', v_row.id,
    jsonb_build_object('scheduled_id', s.id));
  return v_row;
end $function$;

-- ---------------------------------------------------------------------------
-- 5. Dispatcher procs (service_role only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.chat_scheduled_due(p_limit integer)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select id from public.chat_scheduled_messages where status = 'scheduled' and send_at <= now()
  order by send_at limit least(greatest(coalesce(p_limit, 100), 1), 500);
$function$;

CREATE OR REPLACE FUNCTION public.chat_scheduled_dispatch(p_id uuid, p_trace_id uuid)
 RETURNS SETOF chat_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s public.chat_scheduled_messages; v_row public.chat_messages; v_err text;
begin
  if p_trace_id is null then raise exception 'p_trace_id is required'; end if;
  select * into s from public.chat_scheduled_messages where id = p_id and status = 'scheduled' and send_at <= now() for update skip locked;
  if not found then return; end if;
  perform set_config('request.jwt.claim.sub', s.sender_user_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', s.sender_user_id, 'role', 'authenticated')::text, true);
  begin
    v_row := public.chat_message_send(s.id, s.channel_id, p_trace_id, s.body, s.mentions, s.attachment_asset_ids,
      s.shared_post_ids, s.reply_to_message_id, s.attachment_meta, s.shared_brief_ids, null);
  exception when others then
    get stacked diagnostics v_err = message_text;
  end;
  if v_row.id is null then
    update public.chat_scheduled_messages set status = 'failed', failure_reason = left(v_err, 200), updated_at = now() where id = p_id;
    perform public.chat_scheduled_outcome_entry(s, 'scheduled_failed', jsonb_build_object('scheduled_id', s.id));
    perform public.audit_log_write('chat_scheduled_dispatch', 'failure', p_trace_id, s.workspace_id, 'chat_channel', s.channel_id,
      jsonb_build_object('scheduled_id', s.id, 'reason', left(v_err, 200)));
    return;
  end if;
  update public.chat_scheduled_messages set status = 'sent', sent_at = now(), updated_at = now() where id = p_id;
  perform public.chat_scheduled_outcome_entry(s, 'scheduled_sent', jsonb_build_object('scheduled_id', s.id, 'message_id', v_row.id));
  perform public.audit_log_write('chat_scheduled_dispatch', 'success', p_trace_id, s.workspace_id, 'chat_message', v_row.id,
    jsonb_build_object('scheduled_id', s.id));
  return next v_row;
end $function$;

-- ---------------------------------------------------------------------------
-- 6. inbox_mark_read_events (authenticated)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inbox_mark_read_events(p_workspace_id uuid, p_event_types text[], p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n int;
begin
  if not public.is_active_workspace_member(p_workspace_id) then raise exception 'workspace_member_only'; end if;
  if p_trace_id is null then raise exception 'p_trace_id is required'; end if;
  if coalesce(cardinality(p_event_types), 0) = 0 then return; end if;
  update public.inbox_entries set read_at = now()
  where user_id = auth.uid() and workspace_id = p_workspace_id and read_at is null and deleted_at is null
    and event_type = any (p_event_types);
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform public.audit_log_write('inbox_mark_read_events', 'success', p_trace_id, p_workspace_id, 'inbox_entry', null,
      jsonb_build_object('event_types', to_jsonb(p_event_types), 'count', v_n));
  end if;
end $function$;

-- ---------------------------------------------------------------------------
-- Function privileges mirror live proacl EXACTLY.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.chat_scheduled_outcome_entry(public.chat_scheduled_messages, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.chat_scheduled_clear_failed(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.chat_message_schedule(uuid, text, timestamptz, uuid, text, jsonb, uuid[], uuid[], uuid[], text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_message_schedule(uuid, text, timestamptz, uuid, text, jsonb, uuid[], uuid[], uuid[], text, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.chat_scheduled_update(uuid, timestamptz, text, jsonb, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_scheduled_update(uuid, timestamptz, text, jsonb, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.chat_scheduled_cancel(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_scheduled_cancel(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.chat_scheduled_send_now(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_scheduled_send_now(uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.chat_scheduled_due(integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_scheduled_due(integer) TO service_role;
REVOKE ALL ON FUNCTION public.chat_scheduled_dispatch(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_scheduled_dispatch(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.inbox_mark_read_events(uuid, text[], uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inbox_mark_read_events(uuid, text[], uuid) TO authenticated;

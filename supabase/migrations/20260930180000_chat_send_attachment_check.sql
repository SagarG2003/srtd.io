-- Applied live 30 Sep 2026 via MCP: rejects attachment ids the sender cannot use.
-- This file is the record; do not execute. The definition below is copied
-- verbatim from the live database (pg_get_functiondef) on project
-- movnexawfhsyuluspxoc. Every p_attachment_asset_ids entry must be an
-- asset_versions row in the chat's workspace whose asset is a library asset
-- or a chat file the sender can read (chat_attachment_readable); otherwise
-- the send raises 'attachment not available'. CREATE OR REPLACE keeps the
-- existing grants.

CREATE OR REPLACE FUNCTION public.chat_message_send(p_id uuid, p_channel_id text, p_trace_id uuid, p_body text DEFAULT NULL::text, p_mentions jsonb DEFAULT NULL::jsonb, p_attachment_asset_ids uuid[] DEFAULT NULL::uuid[], p_shared_post_ids uuid[] DEFAULT NULL::uuid[], p_reply_to_message_id text DEFAULT NULL::text, p_attachment_meta jsonb DEFAULT NULL::jsonb, p_shared_brief_ids uuid[] DEFAULT NULL::uuid[], p_forwarded_from_message_id text DEFAULT NULL::text)
 RETURNS chat_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := auth.uid(); v_workspace_id uuid; v_channel_type text;
  v_src_channel text; v_src_workspace uuid; v_mentioned uuid[]; v_row public.chat_messages;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  if p_id is null or p_trace_id is null then raise exception 'p_id and p_trace_id are required'; end if;
  if coalesce(length(btrim(p_body)), 0) = 0 and coalesce(cardinality(p_attachment_asset_ids), 0) = 0
     and coalesce(cardinality(p_shared_post_ids), 0) = 0 and coalesce(cardinality(p_shared_brief_ids), 0) = 0 then
    raise exception 'message has no body, attachments, shared posts or shared briefs';
  end if;
  if length(p_body) > 5000 then raise exception 'body exceeds 5000 characters'; end if;
  perform set_config('app.trace_id', p_trace_id::text, true);
  if not public.chat_channel_member(p_channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  select workspace_id, channel_type into v_workspace_id, v_channel_type from public.chat_channels where channel_id = p_channel_id;
  if coalesce(cardinality(p_attachment_asset_ids), 0) > 0 and exists (
    select 1 from unnest(p_attachment_asset_ids) vid
    where not exists (
      select 1 from public.asset_versions v join public.assets a on a.id = v.asset_id
      where v.id = vid and v.workspace_id = v_workspace_id
        and (a.origin = 'library' or public.chat_attachment_readable(vid, v_actor)))) then
    raise exception 'attachment not available';
  end if;
  if p_reply_to_message_id is not null and not exists (
    select 1 from public.chat_messages m where m.id = p_reply_to_message_id and m.channel_id = p_channel_id) then
    raise exception 'reply target not in this chat';
  end if;
  if p_forwarded_from_message_id is not null then
    select channel_id, workspace_id into v_src_channel, v_src_workspace
      from public.chat_messages where id = p_forwarded_from_message_id and deleted_at is null limit 1;
    if v_src_channel is null or v_src_workspace <> v_workspace_id or not public.chat_channel_member(v_src_channel, v_actor) then
      raise exception 'forward source not accessible';
    end if;
  end if;
  v_mentioned := public.chat_mentions_resolve(p_channel_id, v_actor, p_mentions);
  perform pg_advisory_xact_lock(hashtext(p_id::text));
  select * into v_row from public.chat_messages where id = p_id::text limit 1;
  if found then return v_row; end if;
  insert into public.chat_messages (id, channel_id, workspace_id, sender_user_id, body, mentions, attachment_asset_ids,
    shared_post_ids, reply_to_message_id, attachment_meta, shared_brief_ids, forwarded_from_message_id, agora_event_id, created_at)
  values (p_id::text, p_channel_id, v_workspace_id, v_actor, p_body,
    case when cardinality(v_mentioned) > 0 then to_jsonb(v_mentioned) end, p_attachment_asset_ids,
    p_shared_post_ids, p_reply_to_message_id, p_attachment_meta, p_shared_brief_ids, p_forwarded_from_message_id, null, now())
  returning * into v_row;
  if cardinality(v_mentioned) > 0 then
    insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
    select u, v_workspace_id, 'mention', 'chat_channel', p_channel_id,
           case when v_channel_type = 'dm' then 'people' else 'groups' end, p_channel_id, 'urgent',
           jsonb_build_object('message_id', p_id::text), v_actor
    from unnest(v_mentioned) u;
  end if;
  return v_row;
end $function$;

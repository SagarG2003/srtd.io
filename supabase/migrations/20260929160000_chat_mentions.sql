-- DESTRUCTIVE: drops and recreates chat_message_edit (signature change). No data dropped.
-- Rollback: recreate chat_message_edit(text,text,text,uuid) from 20260928190717 migration; drop chat_mentions_resolve; drop constraint chat_messages_mentions_is_array.

create or replace function public.chat_mentions_resolve(p_channel_id text, p_actor uuid, p_mentions jsonb)
returns uuid[] language plpgsql stable security definer set search_path to '' as $$
declare v_ids uuid[]; v_bad int;
begin
  if p_mentions is null or p_mentions = 'null'::jsonb then return array[]::uuid[]; end if;
  if jsonb_typeof(p_mentions) <> 'array' then raise exception 'mentions must be a list of people'; end if;
  if jsonb_array_length(p_mentions) > 50 then raise exception 'too many mentions'; end if;
  select coalesce(array_agg(distinct x::uuid), array[]::uuid[]) into v_ids
    from jsonb_array_elements_text(p_mentions) x where x::uuid <> p_actor;
  select count(*) into v_bad from unnest(v_ids) u where not public.chat_channel_member(p_channel_id, u);
  if v_bad > 0 then raise exception 'mentioned people must be in this chat'; end if;
  return v_ids;
end $$;
revoke all on function public.chat_mentions_resolve(text, uuid, jsonb) from public, anon, authenticated;

create or replace function public.chat_message_send(p_id uuid, p_channel_id text, p_trace_id uuid, p_body text default null, p_mentions jsonb default null, p_attachment_asset_ids uuid[] default null, p_shared_post_ids uuid[] default null, p_reply_to_message_id text default null, p_attachment_meta jsonb default null, p_shared_brief_ids uuid[] default null, p_forwarded_from_message_id text default null)
returns public.chat_messages language plpgsql security definer set search_path to '' as $$
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
end $$;

drop function public.chat_message_edit(text, text, text, uuid);
create function public.chat_message_edit(p_message_id text, p_channel_id text, p_body text, p_trace_id uuid, p_mentions jsonb default null)
returns public.chat_messages language plpgsql security definer set search_path to '' as $$
declare v_actor uuid := auth.uid(); v_row public.chat_messages; v_channel_type text; v_old uuid[]; v_new uuid[];
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  if p_message_id is null or p_trace_id is null then raise exception 'p_message_id and p_trace_id are required'; end if;
  if length(p_body) > 5000 then raise exception 'body exceeds 5000 characters'; end if;
  perform set_config('app.trace_id', p_trace_id::text, true);
  if not public.chat_channel_member(p_channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  select * into v_row from public.chat_messages where id = p_message_id and channel_id = p_channel_id limit 1;
  if not found or v_row.sender_user_id <> v_actor then raise exception 'only your own messages in this chat can be edited'; end if;
  if v_row.deleted_at is not null then raise exception 'deleted messages cannot be edited'; end if;
  if v_row.created_at < now() - interval '15 minutes' then raise exception 'edit window has closed'; end if;
  if exists (select 1 from public.chat_message_marks where message_id = p_message_id) then raise exception 'marked messages cannot be edited'; end if;
  if coalesce(length(btrim(p_body)), 0) = 0 and coalesce(cardinality(v_row.attachment_asset_ids), 0) = 0
     and coalesce(cardinality(v_row.shared_post_ids), 0) = 0 and coalesce(cardinality(v_row.shared_brief_ids), 0) = 0 then
    raise exception 'message has no body, attachments, shared posts or shared briefs';
  end if;
  v_old := array(select x::uuid from jsonb_array_elements_text(coalesce(v_row.mentions, '[]'::jsonb)) x);
  v_new := public.chat_mentions_resolve(p_channel_id, v_actor, p_mentions);
  select channel_type into v_channel_type from public.chat_channels where channel_id = p_channel_id;
  update public.chat_messages
     set body = p_body, mentions = case when cardinality(v_new) > 0 then to_jsonb(v_new) end, edited_at = now()
   where id = p_message_id and channel_id = p_channel_id
   returning * into v_row;
  update public.inbox_entries set deleted_at = now()
   where entity_type = 'chat_channel' and entity_id = p_channel_id and event_type = 'mention'
     and payload->>'message_id' = p_message_id and deleted_at is null
     and user_id = any(v_old) and not (user_id = any(v_new));
  insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  select u, v_row.workspace_id, 'mention', 'chat_channel', p_channel_id,
         case when v_channel_type = 'dm' then 'people' else 'groups' end, p_channel_id, 'urgent',
         jsonb_build_object('message_id', p_message_id), v_actor
  from unnest(v_new) u where not (u = any(v_old));
  return v_row;
end $$;
revoke all on function public.chat_message_edit(text, text, text, uuid, jsonb) from public, anon;
grant execute on function public.chat_message_edit(text, text, text, uuid, jsonb) to authenticated;

create or replace function public.chat_message_delete(p_message_ids text[], p_channel_id text, p_trace_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
declare v_actor uuid := auth.uid(); v_blocked int; v_deleted int;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  if coalesce(cardinality(p_message_ids), 0) = 0 or cardinality(p_message_ids) > 100 then raise exception 'select between 1 and 100 messages'; end if;
  perform set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  if not public.chat_channel_member(p_channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  select count(*) into v_blocked from public.chat_message_marks where message_id = any(p_message_ids);
  if v_blocked > 0 then raise exception 'marked messages cannot be deleted'; end if;
  update public.chat_messages
     set deleted_at = now(), body = null, mentions = null, attachment_asset_ids = null,
         attachment_meta = null, shared_post_ids = null, shared_brief_ids = null
   where id = any(p_message_ids) and channel_id = p_channel_id and sender_user_id = v_actor
     and deleted_at is null and created_at >= now() - interval '30 minutes';
  get diagnostics v_deleted = row_count;
  if v_deleted <> cardinality(p_message_ids) then raise exception 'only your own messages from the last 30 minutes can be deleted'; end if;
  update public.inbox_entries set deleted_at = now()
   where entity_type = 'chat_channel' and entity_id = p_channel_id and event_type = 'mention'
     and payload->>'message_id' = any(p_message_ids) and deleted_at is null;
end $$;

alter table public.chat_messages
  add constraint chat_messages_mentions_is_array check (mentions is null or jsonb_typeof(mentions) = 'array');

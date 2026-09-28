create or replace function public.chat_message_edit(
  p_message_id text, p_channel_id text, p_body text, p_trace_id uuid)
returns public.chat_messages
language plpgsql security definer set search_path to ''
as $$
declare v_actor uuid := auth.uid(); v_row public.chat_messages;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  if p_message_id is null or p_trace_id is null then raise exception 'p_message_id and p_trace_id are required'; end if;
  if length(p_body) > 5000 then raise exception 'body exceeds 5000 characters'; end if;
  perform set_config('app.trace_id', p_trace_id::text, true);
  if not public.chat_channel_member(p_channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  select * into v_row from public.chat_messages
    where id = p_message_id and channel_id = p_channel_id limit 1;
  if not found or v_row.sender_user_id <> v_actor then raise exception 'only your own messages in this chat can be edited'; end if;
  if v_row.deleted_at is not null then raise exception 'deleted messages cannot be edited'; end if;
  if v_row.created_at < now() - interval '15 minutes' then raise exception 'edit window has closed'; end if;
  if exists (select 1 from public.chat_message_marks where message_id = p_message_id) then raise exception 'marked messages cannot be edited'; end if;
  if coalesce(length(btrim(p_body)), 0) = 0
     and coalesce(cardinality(v_row.attachment_asset_ids), 0) = 0
     and coalesce(cardinality(v_row.shared_post_ids), 0) = 0
     and coalesce(cardinality(v_row.shared_brief_ids), 0) = 0 then
    raise exception 'message has no body, attachments, shared posts or shared briefs';
  end if;
  update public.chat_messages set body = p_body, edited_at = now()
    where id = p_message_id and channel_id = p_channel_id
    returning * into v_row;
  return v_row;
end; $$;

revoke all on function public.chat_message_edit(text, text, text, uuid) from public;
grant execute on function public.chat_message_edit(text, text, text, uuid) to authenticated;

create or replace function public.chat_message_delete(p_message_ids text[], p_channel_id text, p_trace_id uuid)
returns void
language plpgsql security definer set search_path to ''
as $$
declare v_actor uuid := auth.uid(); v_blocked int; v_deleted int;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  if coalesce(cardinality(p_message_ids), 0) = 0 or cardinality(p_message_ids) > 100 then raise exception 'select between 1 and 100 messages'; end if;
  perform set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  if not public.chat_channel_member(p_channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  select count(*) into v_blocked from public.chat_message_marks where message_id = any(p_message_ids);
  if v_blocked > 0 then raise exception 'marked messages cannot be deleted'; end if;
  update public.chat_messages set deleted_at = now()
    where id = any(p_message_ids) and channel_id = p_channel_id and sender_user_id = v_actor and deleted_at is null
      and created_at >= now() - interval '30 minutes';
  get diagnostics v_deleted = row_count;
  if v_deleted <> cardinality(p_message_ids) then raise exception 'only your own messages from the last 30 minutes can be deleted'; end if;
end; $$;

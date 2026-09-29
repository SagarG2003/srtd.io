-- Chat delete becomes a tombstone. Already applied to movnexawfhsyuluspxoc; this
-- file is the record. The proc and policy below are copied from the live
-- database (pg_get_functiondef, pg_policies).
--
-- 1. chat_message_delete wipes the content (body, mentions, attachments,
--    attachment_meta, shared posts and briefs) as it sets deleted_at.
-- 2. Existing deleted rows get the same wipe.
-- 3. The member SELECT policy no longer hides deleted rows: members read the
--    tombstone (id, sender, created_at, deleted_at) and render "Message deleted".

CREATE OR REPLACE FUNCTION public.chat_message_delete(p_message_ids text[], p_channel_id text, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end; $function$;

update public.chat_messages
   set body = null, mentions = null, attachment_asset_ids = null,
       attachment_meta = null, shared_post_ids = null, shared_brief_ids = null
 where deleted_at is not null;

drop policy if exists chat_messages_select_channel_member on public.chat_messages;
create policy chat_messages_select_channel_member on public.chat_messages
  for select to authenticated
  using (public.chat_channel_member(channel_id, auth.uid()) and created_at > public.chat_cleared_at(channel_id, auth.uid()));

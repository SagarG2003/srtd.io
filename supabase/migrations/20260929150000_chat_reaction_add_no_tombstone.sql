-- chat_reaction_add refuses a tombstone. Already applied to movnexawfhsyuluspxoc;
-- this file is the record. The proc below is copied from the live database
-- (pg_get_functiondef). The signature is unchanged, so grants and generated
-- types stay as they are.
--
-- Checks, in order: auth, channel membership, the target row by id + channel,
-- 'message not found', then 'message deleted' when deleted_at is set.

CREATE OR REPLACE FUNCTION public.chat_reaction_add(p_message_id text, p_channel_id text, p_emoji text, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_actor uuid := auth.uid(); v_workspace_id uuid; v_deleted timestamptz;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  PERFORM set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  IF NOT public.chat_channel_member(p_channel_id, v_actor) THEN RAISE EXCEPTION 'not a member of this chat'; END IF;
  SELECT workspace_id, deleted_at INTO v_workspace_id, v_deleted
    FROM public.chat_messages WHERE id = p_message_id AND channel_id = p_channel_id LIMIT 1;
  IF v_workspace_id IS NULL THEN RAISE EXCEPTION 'message not found'; END IF;
  IF v_deleted IS NOT NULL THEN RAISE EXCEPTION 'message deleted'; END IF;
  INSERT INTO public.chat_reactions (message_id, channel_id, workspace_id, user_id, emoji)
  VALUES (p_message_id, p_channel_id, v_workspace_id, v_actor, p_emoji) ON CONFLICT DO NOTHING;
END; $function$
;

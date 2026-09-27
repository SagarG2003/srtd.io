-- Chat: forward, clear-for-me. Applied to live 2026-09-27 via MCP.
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS forwarded_from_message_id text;

DROP FUNCTION IF EXISTS public.chat_message_send(uuid, text, uuid, text, jsonb, uuid[], uuid[], text, jsonb, uuid[]);
CREATE OR REPLACE FUNCTION public.chat_message_send(
  p_id uuid, p_channel_id text, p_trace_id uuid,
  p_body text DEFAULT NULL, p_mentions jsonb DEFAULT NULL, p_attachment_asset_ids uuid[] DEFAULT NULL,
  p_shared_post_ids uuid[] DEFAULT NULL, p_reply_to_message_id text DEFAULT NULL, p_attachment_meta jsonb DEFAULT NULL,
  p_shared_brief_ids uuid[] DEFAULT NULL, p_forwarded_from_message_id text DEFAULT NULL)
RETURNS public.chat_messages LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
  v_src_channel text;
  v_src_workspace uuid;
  v_row public.chat_messages;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF p_id IS NULL OR p_trace_id IS NULL THEN RAISE EXCEPTION 'p_id and p_trace_id are required'; END IF;
  IF coalesce(length(btrim(p_body)), 0) = 0
     AND coalesce(cardinality(p_attachment_asset_ids), 0) = 0
     AND coalesce(cardinality(p_shared_post_ids), 0) = 0
     AND coalesce(cardinality(p_shared_brief_ids), 0) = 0 THEN
    RAISE EXCEPTION 'message has no body, attachments, shared posts or shared briefs';
  END IF;
  IF length(p_body) > 5000 THEN RAISE EXCEPTION 'body exceeds 5000 characters'; END IF;
  PERFORM set_config('app.trace_id', p_trace_id::text, true);
  IF NOT public.chat_channel_member(p_channel_id, v_actor) THEN RAISE EXCEPTION 'not a member of this chat'; END IF;
  SELECT workspace_id INTO v_workspace_id FROM public.chat_channels WHERE channel_id = p_channel_id;
  IF p_reply_to_message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.chat_messages m WHERE m.id = p_reply_to_message_id AND m.channel_id = p_channel_id) THEN
    RAISE EXCEPTION 'reply target not in this chat';
  END IF;
  IF p_forwarded_from_message_id IS NOT NULL THEN
    SELECT channel_id, workspace_id INTO v_src_channel, v_src_workspace
      FROM public.chat_messages WHERE id = p_forwarded_from_message_id AND deleted_at IS NULL LIMIT 1;
    IF v_src_channel IS NULL OR v_src_workspace <> v_workspace_id
       OR NOT public.chat_channel_member(v_src_channel, v_actor) THEN
      RAISE EXCEPTION 'forward source not accessible';
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_id::text));
  SELECT * INTO v_row FROM public.chat_messages WHERE id = p_id::text LIMIT 1;
  IF FOUND THEN RETURN v_row; END IF;
  INSERT INTO public.chat_messages (id, channel_id, workspace_id, sender_user_id, body, mentions, attachment_asset_ids,
    shared_post_ids, reply_to_message_id, attachment_meta, shared_brief_ids, forwarded_from_message_id, agora_event_id, created_at)
  VALUES (p_id::text, p_channel_id, v_workspace_id, v_actor, p_body, p_mentions, p_attachment_asset_ids,
    p_shared_post_ids, p_reply_to_message_id, p_attachment_meta, p_shared_brief_ids, p_forwarded_from_message_id, NULL, now())
  RETURNING * INTO v_row;
  RETURN v_row;
END; $$;
REVOKE EXECUTE ON FUNCTION public.chat_message_send(uuid, text, uuid, text, jsonb, uuid[], uuid[], text, jsonb, uuid[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_message_send(uuid, text, uuid, text, jsonb, uuid[], uuid[], text, jsonb, uuid[], text) TO authenticated;

CREATE TABLE IF NOT EXISTS public.chat_channel_clears (
  channel_id text NOT NULL REFERENCES public.chat_channels(channel_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  cleared_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
ALTER TABLE public.chat_channel_clears ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_channel_clears_select_own ON public.chat_channel_clears;
CREATE POLICY chat_channel_clears_select_own ON public.chat_channel_clears FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.chat_cleared_at(p_channel_id text, p_user_id uuid)
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  SELECT coalesce((SELECT c.cleared_at FROM public.chat_channel_clears c WHERE c.channel_id = p_channel_id AND c.user_id = p_user_id), '-infinity'::timestamptz);
$$;
REVOKE EXECUTE ON FUNCTION public.chat_cleared_at(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_cleared_at(text, uuid) TO authenticated;
DROP POLICY IF EXISTS chat_messages_select_channel_member ON public.chat_messages;
CREATE POLICY chat_messages_select_channel_member ON public.chat_messages FOR SELECT TO authenticated
  USING (deleted_at IS NULL
         AND public.chat_channel_member(channel_id, auth.uid())
         AND created_at > public.chat_cleared_at(channel_id, auth.uid()));

CREATE OR REPLACE FUNCTION public.chat_channel_clear(p_channel_id text, p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_actor uuid := auth.uid(); v_workspace_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  PERFORM set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  IF NOT public.chat_channel_member(p_channel_id, v_actor) THEN RAISE EXCEPTION 'not a member of this chat'; END IF;
  SELECT workspace_id INTO v_workspace_id FROM public.chat_channels WHERE channel_id = p_channel_id;
  INSERT INTO public.chat_channel_clears (channel_id, user_id, workspace_id, cleared_at)
  VALUES (p_channel_id, v_actor, v_workspace_id, now())
  ON CONFLICT (channel_id, user_id) DO UPDATE SET cleared_at = now();
END; $$;
REVOKE EXECUTE ON FUNCTION public.chat_channel_clear(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_channel_clear(text, uuid) TO authenticated;
-- END MIGRATION

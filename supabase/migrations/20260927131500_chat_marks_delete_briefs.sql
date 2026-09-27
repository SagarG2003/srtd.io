-- Chat: marks, delete own messages, shared briefs. Applied to live 2026-09-27 via MCP.
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS shared_brief_ids uuid[];

DROP FUNCTION IF EXISTS public.chat_message_send(uuid, text, uuid, text, jsonb, uuid[], uuid[], text, jsonb);
CREATE OR REPLACE FUNCTION public.chat_message_send(
  p_id uuid, p_channel_id text, p_trace_id uuid,
  p_body text DEFAULT NULL, p_mentions jsonb DEFAULT NULL, p_attachment_asset_ids uuid[] DEFAULT NULL,
  p_shared_post_ids uuid[] DEFAULT NULL, p_reply_to_message_id text DEFAULT NULL, p_attachment_meta jsonb DEFAULT NULL,
  p_shared_brief_ids uuid[] DEFAULT NULL)
RETURNS public.chat_messages LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
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
  PERFORM pg_advisory_xact_lock(hashtext(p_id::text));
  SELECT * INTO v_row FROM public.chat_messages WHERE id = p_id::text LIMIT 1;
  IF FOUND THEN RETURN v_row; END IF;
  INSERT INTO public.chat_messages (id, channel_id, workspace_id, sender_user_id, body, mentions, attachment_asset_ids,
    shared_post_ids, reply_to_message_id, attachment_meta, shared_brief_ids, agora_event_id, created_at)
  VALUES (p_id::text, p_channel_id, v_workspace_id, v_actor, p_body, p_mentions, p_attachment_asset_ids,
    p_shared_post_ids, p_reply_to_message_id, p_attachment_meta, p_shared_brief_ids, NULL, now())
  RETURNING * INTO v_row;
  RETURN v_row;
END; $$;
REVOKE EXECUTE ON FUNCTION public.chat_message_send(uuid, text, uuid, text, jsonb, uuid[], uuid[], text, jsonb, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_message_send(uuid, text, uuid, text, jsonb, uuid[], uuid[], text, jsonb, uuid[]) TO authenticated;

CREATE TABLE IF NOT EXISTS public.chat_message_marks (
  message_id text PRIMARY KEY,
  channel_id text NOT NULL REFERENCES public.chat_channels(channel_id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  mark_type text NOT NULL CHECK (mark_type IN ('commitment','decision','pending')),
  priority smallint CHECK (priority IN (1,2)),
  marked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  marked_at timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  CHECK (priority IS NULL OR mark_type = 'pending'),
  CHECK (resolved_at IS NULL OR mark_type = 'pending')
);
ALTER TABLE public.chat_message_marks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_message_marks_select_channel_member ON public.chat_message_marks;
CREATE POLICY chat_message_marks_select_channel_member ON public.chat_message_marks FOR SELECT TO authenticated
  USING (public.chat_channel_member(channel_id, auth.uid()));
CREATE INDEX IF NOT EXISTS chat_message_marks_channel_idx ON public.chat_message_marks (channel_id, mark_type, resolved_at);

CREATE OR REPLACE FUNCTION public.chat_mark_set(p_message_id text, p_channel_id text, p_mark_type text, p_priority smallint, p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_actor uuid := auth.uid(); v_workspace_id uuid; v_existing public.chat_message_marks;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  PERFORM set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  IF NOT public.chat_channel_member(p_channel_id, v_actor) THEN RAISE EXCEPTION 'not a member of this chat'; END IF;
  IF p_priority IS NOT NULL AND p_mark_type <> 'pending' THEN RAISE EXCEPTION 'priority applies to pending only'; END IF;
  SELECT workspace_id INTO v_workspace_id FROM public.chat_messages
    WHERE id = p_message_id AND channel_id = p_channel_id AND deleted_at IS NULL LIMIT 1;
  IF v_workspace_id IS NULL THEN RAISE EXCEPTION 'message not found'; END IF;
  SELECT * INTO v_existing FROM public.chat_message_marks WHERE message_id = p_message_id;
  IF FOUND THEN
    IF v_existing.mark_type <> 'pending' OR v_existing.resolved_at IS NOT NULL THEN RAISE EXCEPTION 'mark is frozen'; END IF;
    IF p_mark_type <> 'pending' THEN RAISE EXCEPTION 'one mark per message'; END IF;
    UPDATE public.chat_message_marks SET priority = p_priority WHERE message_id = p_message_id;
    RETURN;
  END IF;
  INSERT INTO public.chat_message_marks (message_id, channel_id, workspace_id, mark_type, priority, marked_by)
  VALUES (p_message_id, p_channel_id, v_workspace_id, p_mark_type, p_priority, v_actor);
END; $$;
CREATE OR REPLACE FUNCTION public.chat_mark_resolve(p_message_id text, p_channel_id text, p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_actor uuid := auth.uid(); v_updated int;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  PERFORM set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  IF NOT public.chat_channel_member(p_channel_id, v_actor) THEN RAISE EXCEPTION 'not a member of this chat'; END IF;
  UPDATE public.chat_message_marks SET resolved_by = v_actor, resolved_at = now()
    WHERE message_id = p_message_id AND channel_id = p_channel_id AND mark_type = 'pending' AND resolved_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN RAISE EXCEPTION 'no open pending mark on this message'; END IF;
END; $$;
REVOKE EXECUTE ON FUNCTION public.chat_mark_set(text, text, text, smallint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_mark_set(text, text, text, smallint, uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_mark_resolve(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_mark_resolve(text, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.chat_message_delete(p_message_ids text[], p_channel_id text, p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_actor uuid := auth.uid(); v_blocked int; v_deleted int;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF coalesce(cardinality(p_message_ids), 0) = 0 OR cardinality(p_message_ids) > 100 THEN RAISE EXCEPTION 'select between 1 and 100 messages'; END IF;
  PERFORM set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  IF NOT public.chat_channel_member(p_channel_id, v_actor) THEN RAISE EXCEPTION 'not a member of this chat'; END IF;
  SELECT count(*) INTO v_blocked FROM public.chat_message_marks WHERE message_id = ANY(p_message_ids);
  IF v_blocked > 0 THEN RAISE EXCEPTION 'marked messages cannot be deleted'; END IF;
  UPDATE public.chat_messages SET deleted_at = now()
    WHERE id = ANY(p_message_ids) AND channel_id = p_channel_id AND sender_user_id = v_actor AND deleted_at IS NULL;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> cardinality(p_message_ids) THEN RAISE EXCEPTION 'only your own messages in this chat can be deleted'; END IF;
END; $$;
REVOKE EXECUTE ON FUNCTION public.chat_message_delete(text[], text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_message_delete(text[], text, uuid) TO authenticated;
-- END MIGRATION

-- Chat marks: every mark type (commitment / decision / pending) is resolvable by any member
-- (Delivered / Closed / Completed) and a resolved mark can be reopened by any member. Marks are
-- hidden by the caller's clear, the same as messages. Applied live 2026-09-28 via MCP and verified.
-- Non-destructive: dropping a CHECK loosens it; no data is lost.
BEGIN;

ALTER TABLE public.chat_message_marks DROP CONSTRAINT chat_message_marks_check1;   -- was CHECK (resolved_at IS NULL OR mark_type='pending')

CREATE OR REPLACE FUNCTION public.chat_mark_resolve(p_message_id text, p_channel_id text, p_trace_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_actor uuid := auth.uid(); v_updated int;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  PERFORM set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  IF NOT public.chat_channel_member(p_channel_id, v_actor) THEN RAISE EXCEPTION 'not a member of this chat'; END IF;
  UPDATE public.chat_message_marks SET resolved_by = v_actor, resolved_at = now()
    WHERE message_id = p_message_id AND channel_id = p_channel_id AND resolved_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN RAISE EXCEPTION 'no open mark on this message'; END IF;
END; $function$;

ALTER POLICY chat_message_marks_select_channel_member ON public.chat_message_marks USING (public.chat_channel_member(channel_id, auth.uid()) AND marked_at > public.chat_cleared_at(channel_id, auth.uid()));

CREATE OR REPLACE FUNCTION public.chat_mark_reopen(p_message_id text, p_channel_id text, p_trace_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_actor uuid := auth.uid(); v_updated int;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  PERFORM set_config('app.trace_id', coalesce(p_trace_id::text, ''), true);
  IF NOT public.chat_channel_member(p_channel_id, v_actor) THEN RAISE EXCEPTION 'not a member of this chat'; END IF;
  UPDATE public.chat_message_marks SET resolved_by = NULL, resolved_at = NULL
    WHERE message_id = p_message_id AND channel_id = p_channel_id AND resolved_at IS NOT NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN RAISE EXCEPTION 'no resolved mark on this message'; END IF;
END; $function$;
REVOKE ALL ON FUNCTION public.chat_mark_reopen(text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_mark_reopen(text, text, uuid) TO authenticated;

COMMIT;

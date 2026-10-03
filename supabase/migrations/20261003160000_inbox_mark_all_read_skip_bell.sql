-- Applied live 3 Oct 2026 15:45 IST via MCP on project movnexawfhsyuluspxoc.
-- This file is the record; do not execute.
--
-- inbox_mark_all_read (Activity "Mark all read") skips the chat bell's types:
-- reminders, scheduled sent / failed, and chat mentions stay unread for the
-- bell. Signature, security and grants are unchanged.

-- 20261003160000_inbox_mark_all_read_skip_bell.sql  (project movnexawfhsyuluspxoc)
CREATE OR REPLACE FUNCTION public.inbox_mark_all_read(
  p_workspace_id uuid, p_trace_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_n int;
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  UPDATE public.inbox_entries SET read_at = now()
   WHERE workspace_id = p_workspace_id AND user_id = auth.uid()
     AND read_at IS NULL AND snoozed_until IS NULL AND deleted_at IS NULL
     AND event_type NOT IN ('reminder','scheduled_sent','scheduled_failed')
     AND NOT (event_type = 'mention' AND entity_type = 'chat_channel');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    PERFORM public.audit_log_write('inbox_mark_all_read','success',p_trace_id,p_workspace_id,'inbox_entry',NULL::text,jsonb_build_object('count',v_n));
  END IF;
END; $function$;

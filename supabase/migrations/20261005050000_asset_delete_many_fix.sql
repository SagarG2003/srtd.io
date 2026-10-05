-- asset_delete_many: max(workspace_id) over uuid has no Postgres 17 aggregate, so every
-- call raised 'function max(uuid) does not exist'. The one changed line picks the single
-- workspace with (array_agg(DISTINCT workspace_id))[1]; v_distinct <> 1 still refuses a
-- set spanning workspaces. Body is otherwise the live definition from 20261005040000.
-- Signature, return type, SECURITY DEFINER, search_path and grants are unchanged
-- (CREATE OR REPLACE keeps the ACL).

CREATE OR REPLACE FUNCTION public.asset_delete_many(p_asset_ids uuid[], p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ws uuid;
  v_distinct integer;
  v_id uuid;
BEGIN
  IF p_asset_ids IS NULL OR array_length(p_asset_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;
  IF array_length(p_asset_ids, 1) > 200 THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  SELECT count(DISTINCT workspace_id), (array_agg(DISTINCT workspace_id))[1]
    INTO v_distinct, v_ws
    FROM public.assets
    WHERE id = ANY(p_asset_ids) AND deleted_at IS NULL;

  IF v_ws IS NULL OR v_distinct <> 1 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF EXISTS (SELECT 1 FROM public.assets
             WHERE id = ANY(p_asset_ids) AND workspace_id = v_ws AND deleted_at IS NULL AND origin = 'chat') THEN
    RAISE EXCEPTION 'chat files are deleted with their message'; END IF;

  FOR v_id IN
    WITH deleted AS (
      UPDATE public.assets SET deleted_at = now()
        WHERE id = ANY(p_asset_ids) AND workspace_id = v_ws AND deleted_at IS NULL
        RETURNING id
    )
    SELECT id FROM deleted
  LOOP
    PERFORM public.audit_log_write('asset_delete','success',p_trace_id,v_ws,'asset',v_id::text);
  END LOOP;
END; $function$;

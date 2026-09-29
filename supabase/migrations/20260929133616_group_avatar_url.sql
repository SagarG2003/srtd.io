ALTER TABLE public.groups
  ADD COLUMN avatar_url text
  CONSTRAINT groups_avatar_url_check CHECK (avatar_url IS NULL OR avatar_url ~ '^https?://');

CREATE OR REPLACE FUNCTION public.group_avatar_set(p_group_id uuid, p_avatar_url text, p_trace_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_ws uuid; v_creator uuid;
BEGIN
  SELECT workspace_id, created_by INTO v_ws, v_creator FROM public.groups
  WHERE id = p_group_id AND deleted_at IS NULL;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'group_not_found'; END IF;
  IF NOT (v_creator = auth.uid() OR EXISTS (SELECT 1 FROM public.workspace_members
      WHERE workspace_id = v_ws AND user_id = auth.uid() AND active AND role IN ('owner','admin'))) THEN
    RAISE EXCEPTION 'group_manage_denied'; END IF;
  BEGIN
    UPDATE public.groups SET avatar_url = p_avatar_url WHERE id = p_group_id;
  EXCEPTION WHEN check_violation THEN RAISE EXCEPTION 'group_avatar_invalid';
  END;
END; $$;

REVOKE ALL ON FUNCTION public.group_avatar_set(uuid, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.group_avatar_set(uuid, text, uuid) TO authenticated;

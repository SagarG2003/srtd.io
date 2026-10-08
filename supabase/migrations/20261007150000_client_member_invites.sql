CREATE OR REPLACE FUNCTION public.member_invite(
  p_workspace_id uuid,
  p_email text,
  p_role text,
  p_trace_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_id uuid;
  v_inviter_role text;
BEGIN
  SELECT wm.role
  INTO v_inviter_role
  FROM public.workspace_members wm
  WHERE wm.workspace_id = p_workspace_id
    AND wm.user_id = auth.uid()
    AND wm.active = true
    AND wm.removed_at IS NULL;

  IF v_inviter_role IS NULL THEN
    RAISE EXCEPTION 'workspace_member_only';
  END IF;

  IF v_inviter_role = 'client' THEN
    IF p_role IS DISTINCT FROM 'client' THEN
      RAISE EXCEPTION 'forbidden_role';
    END IF;
  ELSIF NOT public.proc_capability(p_workspace_id, 'workspace.manage_members') THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;

  IF p_role IS NULL
    OR p_role NOT IN ('admin', 'agency', 'client')
    OR p_email IS NULL
    OR length(trim(p_email)) = 0
  THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  SELECT id
  INTO v_uid
  FROM auth.users
  WHERE lower(email) = lower(p_email)
  LIMIT 1;

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  BEGIN
    INSERT INTO public.workspace_members (
      workspace_id,
      user_id,
      role,
      active,
      invited_by,
      invited_at
    )
    VALUES (p_workspace_id, v_uid, p_role, false, auth.uid(), now())
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN unique_violation OR check_violation OR not_null_violation OR foreign_key_violation THEN
      RAISE EXCEPTION 'invalid_payload';
  END;

  PERFORM public.audit_log_write(
    p_action => 'member_invite',
    p_outcome => 'success',
    p_trace_id => p_trace_id,
    p_workspace_id => p_workspace_id,
    p_entity_type => 'workspace_member',
    p_entity_id => v_id::text,
    p_payload => jsonb_build_object('role', p_role)
  );

  RETURN v_id;
END;
$$;

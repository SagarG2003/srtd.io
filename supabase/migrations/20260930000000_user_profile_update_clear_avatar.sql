CREATE OR REPLACE FUNCTION public.user_profile_update(p_display_name text, p_designation text, p_avatar_url text, p_email_opt_in boolean, p_trace_id uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_uid uuid := auth.uid(); v_name text := nullif(trim(p_display_name),''); v_done boolean;
BEGIN
  IF v_uid IS NULL OR v_name IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  UPDATE public.users SET
    display_name = v_name,
    designation  = coalesce(nullif(trim(p_designation), ''), designation),
    avatar_url   = CASE WHEN p_avatar_url = '' THEN NULL ELSE coalesce(p_avatar_url, avatar_url) END,
    email_opt_in = coalesce(p_email_opt_in, email_opt_in),
    profile_completed_at = CASE
      WHEN profile_completed_at IS NULL AND nullif(coalesce(p_avatar_url, avatar_url), '') IS NOT NULL
      THEN now() ELSE profile_completed_at END
  WHERE id = v_uid
  RETURNING (profile_completed_at IS NOT NULL) INTO v_done;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  PERFORM public.audit_log_write(
    p_action => 'user_profile_update', p_outcome => 'success', p_trace_id => p_trace_id,
    p_entity_type => 'user', p_entity_id => v_uid::text,
    p_payload => jsonb_build_object('completed', v_done, 'email_opt_in', coalesce(p_email_opt_in, true)));
  RETURN v_uid;
END; $function$;

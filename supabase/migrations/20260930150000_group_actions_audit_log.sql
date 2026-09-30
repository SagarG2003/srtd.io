-- Group and DM actions record who did what in audit_log (applied live 30 Sep 2026).
CREATE OR REPLACE FUNCTION public.dm_channel_ensure(p_workspace_id uuid, p_other_user_id uuid, p_trace_id uuid)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_a uuid; v_b uuid; v_channel_id text; v_n int;
BEGIN
  IF p_other_user_id = auth.uid() THEN RAISE EXCEPTION 'cannot_dm_self'; END IF;
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN
    RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members
      WHERE workspace_id = p_workspace_id AND user_id = p_other_user_id AND active) THEN
    RAISE EXCEPTION 'member_not_in_workspace'; END IF;
  v_a := least(auth.uid(), p_other_user_id);
  v_b := greatest(auth.uid(), p_other_user_id);
  v_channel_id := 'dm__' || p_workspace_id::text || '__' || v_a::text || '__' || v_b::text;
  INSERT INTO public.chat_channels(channel_id, workspace_id, channel_type, dm_user_a, dm_user_b)
  VALUES (v_channel_id, p_workspace_id, 'dm', v_a, v_b) ON CONFLICT (channel_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    PERFORM public.audit_log_write(p_action=>'dm_channel_create', p_outcome=>'success', p_trace_id=>p_trace_id,
      p_workspace_id=>p_workspace_id, p_entity_type=>'chat_channel', p_entity_id=>v_channel_id,
      p_payload=>jsonb_build_object('other_user_id', p_other_user_id));
  END IF;
  RETURN v_channel_id;
END; $function$;

CREATE OR REPLACE FUNCTION public.group_create(p_workspace_id uuid, p_name text, p_member_user_ids uuid[], p_trace_id uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_group_id uuid; v_channel_id text;
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN
    RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_member_user_ids,'{}'::uuid[])) AS u
    WHERE NOT EXISTS (SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = p_workspace_id AND wm.user_id = u AND wm.active)) THEN
    RAISE EXCEPTION 'member_not_in_workspace'; END IF;
  BEGIN
    INSERT INTO public.groups(workspace_id, name, created_by)
    VALUES (p_workspace_id, p_name, auth.uid()) RETURNING id INTO v_group_id;
  EXCEPTION
    WHEN unique_violation THEN RAISE EXCEPTION 'group_name_taken';
    WHEN check_violation THEN RAISE EXCEPTION 'group_name_invalid';
  END;
  INSERT INTO public.group_members(group_id, user_id, workspace_id)
  SELECT v_group_id, m, p_workspace_id
  FROM (SELECT auth.uid() AS m UNION SELECT unnest(coalesce(p_member_user_ids,'{}'::uuid[]))) s
  ON CONFLICT DO NOTHING;
  v_channel_id := 'group__' || p_workspace_id::text || '__' || v_group_id::text;
  INSERT INTO public.chat_channels(channel_id, workspace_id, channel_type, entity_id)
  VALUES (v_channel_id, p_workspace_id, 'group', v_group_id);
  PERFORM public.audit_log_write(p_action=>'group_create', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>p_workspace_id, p_entity_type=>'group', p_entity_id=>v_group_id::text,
    p_payload=>jsonb_build_object('name', p_name, 'member_user_ids', to_jsonb(coalesce(p_member_user_ids,'{}'::uuid[]))));
  RETURN v_group_id;
END; $function$;

CREATE OR REPLACE FUNCTION public.group_rename(p_group_id uuid, p_name text, p_trace_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_ws uuid; v_creator uuid; v_old text;
BEGIN
  SELECT workspace_id, created_by, name INTO v_ws, v_creator, v_old FROM public.groups
  WHERE id = p_group_id AND deleted_at IS NULL;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'group_not_found'; END IF;
  IF NOT (v_creator = auth.uid() OR EXISTS (SELECT 1 FROM public.workspace_members
      WHERE workspace_id = v_ws AND user_id = auth.uid() AND active AND role IN ('owner','admin'))) THEN
    RAISE EXCEPTION 'group_manage_denied'; END IF;
  BEGIN
    UPDATE public.groups SET name = p_name WHERE id = p_group_id;
  EXCEPTION
    WHEN unique_violation THEN RAISE EXCEPTION 'group_name_taken';
    WHEN check_violation THEN RAISE EXCEPTION 'group_name_invalid';
  END;
  IF v_old IS DISTINCT FROM p_name THEN
    PERFORM public.audit_log_write(p_action=>'group_rename', p_outcome=>'success', p_trace_id=>p_trace_id,
      p_workspace_id=>v_ws, p_entity_type=>'group', p_entity_id=>p_group_id::text,
      p_payload=>jsonb_build_object('old_name', v_old, 'new_name', p_name));
  END IF;
END; $function$;

CREATE OR REPLACE FUNCTION public.group_avatar_set(p_group_id uuid, p_avatar_url text, p_trace_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
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
  PERFORM public.audit_log_write(p_action=>'group_avatar_set', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>v_ws, p_entity_type=>'group', p_entity_id=>p_group_id::text,
    p_payload=>jsonb_build_object('avatar_url', p_avatar_url));
END; $function$;

CREATE OR REPLACE FUNCTION public.group_member_add(p_group_id uuid, p_user_id uuid, p_trace_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_ws uuid; v_creator uuid; v_n int;
BEGIN
  SELECT workspace_id, created_by INTO v_ws, v_creator FROM public.groups
  WHERE id = p_group_id AND deleted_at IS NULL;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'group_not_found'; END IF;
  IF NOT (v_creator = auth.uid() OR EXISTS (SELECT 1 FROM public.workspace_members
      WHERE workspace_id = v_ws AND user_id = auth.uid() AND active AND role IN ('owner','admin'))) THEN
    RAISE EXCEPTION 'group_manage_denied'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members
      WHERE workspace_id = v_ws AND user_id = p_user_id AND active) THEN
    RAISE EXCEPTION 'member_not_in_workspace'; END IF;
  INSERT INTO public.group_members(group_id, user_id, workspace_id)
  VALUES (p_group_id, p_user_id, v_ws) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    PERFORM public.audit_log_write(p_action=>'group_member_add', p_outcome=>'success', p_trace_id=>p_trace_id,
      p_workspace_id=>v_ws, p_entity_type=>'group', p_entity_id=>p_group_id::text,
      p_payload=>jsonb_build_object('user_id', p_user_id));
  END IF;
END; $function$;

CREATE OR REPLACE FUNCTION public.group_member_remove(p_group_id uuid, p_user_id uuid, p_trace_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_ws uuid; v_creator uuid; v_n int;
BEGIN
  SELECT workspace_id, created_by INTO v_ws, v_creator FROM public.groups
  WHERE id = p_group_id AND deleted_at IS NULL;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'group_not_found'; END IF;
  IF NOT (v_creator = auth.uid() OR EXISTS (SELECT 1 FROM public.workspace_members
      WHERE workspace_id = v_ws AND user_id = auth.uid() AND active AND role IN ('owner','admin'))) THEN
    RAISE EXCEPTION 'group_manage_denied'; END IF;
  DELETE FROM public.group_members WHERE group_id = p_group_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    PERFORM public.audit_log_write(p_action=>'group_member_remove', p_outcome=>'success', p_trace_id=>p_trace_id,
      p_workspace_id=>v_ws, p_entity_type=>'group', p_entity_id=>p_group_id::text,
      p_payload=>jsonb_build_object('user_id', p_user_id));
  END IF;
END; $function$;

CREATE OR REPLACE FUNCTION public.group_leave(p_group_id uuid, p_trace_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_ws uuid;
BEGIN
  DELETE FROM public.group_members WHERE group_id = p_group_id AND user_id = auth.uid()
  RETURNING workspace_id INTO v_ws;
  IF v_ws IS NOT NULL THEN
    PERFORM public.audit_log_write(p_action=>'group_leave', p_outcome=>'success', p_trace_id=>p_trace_id,
      p_workspace_id=>v_ws, p_entity_type=>'group', p_entity_id=>p_group_id::text,
      p_payload=>'{}'::jsonb);
  END IF;
END; $function$;

-- Restates the live definition so migrations match the database (the DM branch
-- requiring both DM users to be active members was missing from earlier migration files).
CREATE OR REPLACE FUNCTION public.chat_channel_member(p_channel_id text, p_user_id uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.chat_channels c
    JOIN public.workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = p_user_id AND wm.active = true
    WHERE c.channel_id = p_channel_id
      AND (
        (c.channel_type = 'dm' AND p_user_id IN (c.dm_user_a, c.dm_user_b)
          AND EXISTS (SELECT 1 FROM public.workspace_members pa WHERE pa.workspace_id = c.workspace_id AND pa.user_id = c.dm_user_a AND pa.active = true)
          AND EXISTS (SELECT 1 FROM public.workspace_members pb WHERE pb.workspace_id = c.workspace_id AND pb.user_id = c.dm_user_b AND pb.active = true))
        OR (c.channel_type = 'group' AND EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.group_id = c.entity_id AND gm.user_id = p_user_id))
        OR (c.channel_type = 'plan_period')
      )
  );
$function$;

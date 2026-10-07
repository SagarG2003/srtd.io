-- DESTRUCTIVE: constraint + function replace, no data loss. Already applied 7 Oct.
--
-- Agency acts on behalf of client + who-did-what in Activity.
--   * inbox_entries_event_type_check also allows 'post_deleted' and 'assets_deleted' (21 types).
--   * workspace_role_permissions: agency gains post.delete, client gains asset.delete
--     (every existing workspace, and seed_workspace_role_defaults for new ones).
--   * stage_transition: approved / rejected need post.approve, parked / review need
--     post.edit; the audit row and the stage_change inbox payload carry actor_role.
--   * post_soft_delete: needs post.delete; writes one post_deleted inbox row per
--     other active member, payload {number, title (<=120), actor_role}.
--   * asset_delete / asset_delete_many: any active member; after a delete, ONE
--     assets_deleted inbox row per other active member, payload
--     {count, filenames (up to 3), actor_role}. Nothing deleted = no row.
-- Function bodies below are the live definitions (pg_get_functiondef, project
-- movnexawfhsyuluspxoc, 7 Oct), verbatim. Signatures, return types, SECURITY
-- DEFINER and search_path are unchanged (CREATE OR REPLACE keeps the ACL).

begin;

-- Event types: the drop/add on the partitioned parent applies to every partition.
alter table public.inbox_entries drop constraint inbox_entries_event_type_check;
alter table public.inbox_entries add constraint inbox_entries_event_type_check check (event_type = any (array[
 'comment','mention','stage_change','comment_resolved','brief_created','brief_closed','asset_uploaded','asset_version_added',
 'invite','trial_warning','billing_failure','system','checkpoints_added','post_ready','checkpoint_reopened','checkpoint_asked',
 'scheduled_sent','scheduled_failed','reminder','post_deleted','assets_deleted']));

-- Permissions across every existing workspace.
insert into public.workspace_role_permissions (workspace_id, role, capability, allowed)
select w.id, 'agency', 'post.delete', true
  from public.workspaces w
 where not exists (
   select 1 from public.workspace_role_permissions p
    where p.workspace_id = w.id and p.role = 'agency' and p.capability = 'post.delete');

insert into public.workspace_role_permissions (workspace_id, role, capability, allowed)
select w.id, 'client', 'asset.delete', true
  from public.workspaces w
 where not exists (
   select 1 from public.workspace_role_permissions p
    where p.workspace_id = w.id and p.role = 'client' and p.capability = 'asset.delete');

CREATE OR REPLACE FUNCTION public.seed_workspace_role_defaults()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  insert into public.workspace_role_permissions (workspace_id, role, capability, allowed) values
    (new.id, 'owner', 'workspace.manage_billing', true),
    (new.id, 'owner', 'workspace.delete', true),
    (new.id, 'owner', 'workspace.transfer_ownership', true),
    (new.id, 'owner', 'workspace.manage_members', true),
    (new.id, 'owner', 'workspace.manage_settings', true),
    (new.id, 'owner', 'pipeline.view_all_stages', true),
    (new.id, 'owner', 'pipeline.bulk_actions', true),
    (new.id, 'owner', 'post.create', true),
    (new.id, 'owner', 'post.edit', true),
    (new.id, 'owner', 'post.approve', true),
    (new.id, 'owner', 'post.publish', true),
    (new.id, 'owner', 'post.delete', true),
    (new.id, 'owner', 'brief.view_all', true),
    (new.id, 'owner', 'brief.close', true),
    (new.id, 'owner', 'asset.upload', true),
    (new.id, 'owner', 'asset.delete', true),
    (new.id, 'owner', 'insights.view_full', true),
    (new.id, 'owner', 'inbox.view', true);

  insert into public.workspace_role_permissions (workspace_id, role, capability, allowed) values
    (new.id, 'admin', 'workspace.manage_members', true),
    (new.id, 'admin', 'workspace.manage_settings', true),
    (new.id, 'admin', 'pipeline.view_all_stages', true),
    (new.id, 'admin', 'pipeline.bulk_actions', true),
    (new.id, 'admin', 'post.create', true),
    (new.id, 'admin', 'post.edit', true),
    (new.id, 'admin', 'post.approve', true),
    (new.id, 'admin', 'post.publish', true),
    (new.id, 'admin', 'post.delete', true),
    (new.id, 'admin', 'brief.view_all', true),
    (new.id, 'admin', 'brief.close', true),
    (new.id, 'admin', 'asset.upload', true),
    (new.id, 'admin', 'asset.delete', true),
    (new.id, 'admin', 'insights.view_full', true),
    (new.id, 'admin', 'inbox.view', true);

  insert into public.workspace_role_permissions (workspace_id, role, capability, allowed) values
    (new.id, 'agency', 'pipeline.view_all_stages', true),
    (new.id, 'agency', 'pipeline.bulk_actions', true),
    (new.id, 'agency', 'post.create', true),
    (new.id, 'agency', 'post.edit', true),
    (new.id, 'agency', 'post.approve', true),
    (new.id, 'agency', 'post.publish', true),
    (new.id, 'agency', 'post.delete', true),
    (new.id, 'agency', 'brief.view_all', true),
    (new.id, 'agency', 'brief.close', true),
    (new.id, 'agency', 'asset.upload', true),
    (new.id, 'agency', 'asset.delete', true),
    (new.id, 'agency', 'insights.view_full', true),
    (new.id, 'agency', 'inbox.view', true);

  insert into public.workspace_role_permissions (workspace_id, role, capability, allowed) values
    (new.id, 'client', 'pipeline.view_non_draft', true),
    (new.id, 'client', 'post.approve', true),
    (new.id, 'client', 'brief.view_own', true),
    (new.id, 'client', 'brief.create', true),
    (new.id, 'client', 'brief.close_own', true),
    (new.id, 'client', 'asset.upload', true),
    (new.id, 'client', 'asset.delete', true),
    (new.id, 'client', 'insights.view_curated', true),
    (new.id, 'client', 'inbox.view', true);

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.stage_transition(p_post_id uuid, p_to_stage text, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_ws uuid; v_from text; v_cap text; v_ok boolean; v_closed int := 0; v_role text;
begin
  select workspace_id, stage into v_ws, v_from from public.posts where id=p_post_id and deleted_at is null;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_active_workspace_member(v_ws) then raise exception 'workspace_member_only'; end if;
  v_ok := (v_from='draft'    and p_to_stage in ('review','parked'))
       or (v_from='review'   and p_to_stage in ('approved','rejected','parked'))
       or (v_from='approved' and p_to_stage in ('parked','rejected'))
       or (v_from='parked'   and p_to_stage='review')
       or (v_from='rejected' and p_to_stage='review');
  if not v_ok then raise exception 'invalid_stage_transition'; end if;
  v_cap := case when p_to_stage in ('approved','rejected') then 'post.approve' else 'post.edit' end;
  if not public.proc_capability(v_ws, v_cap) then raise exception 'forbidden_role'; end if;
  select wm.role into v_role from public.workspace_members wm
   where wm.workspace_id = v_ws and wm.user_id = auth.uid() and wm.active = true;
  update public.posts
     set stage=p_to_stage, stage_entered_at=now(), row_version=row_version+1,
         approved_by = case when p_to_stage='approved' then auth.uid() when v_from='approved' then null else approved_by end,
         approved_at = case when p_to_stage='approved' then now()      when v_from='approved' then null else approved_at end
   where id=p_post_id;

  if p_to_stage = 'approved' then
    update public.comments set closed_at = now(), closed_by = auth.uid()
     where entity_type = 'post' and entity_id = p_post_id
       and ledger_seq is not null and deleted_at is null
       and accepted_at is null and closed_at is null;
    get diagnostics v_closed = row_count;
  elsif v_from = 'approved' then
    update public.comments set closed_at = null, closed_by = null
     where entity_type = 'post' and entity_id = p_post_id
       and ledger_seq is not null and closed_at is not null;
  end if;

  perform public.audit_log_write('stage_transition','success',p_trace_id,v_ws,'post',p_post_id::text,
          jsonb_build_object('from',v_from,'to',p_to_stage,'checkpoints_closed',v_closed,'actor_role',v_role));
  insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  select wm.user_id, v_ws, 'stage_change', 'post', p_post_id::text, 'posts', p_post_id::text, 'active',
         jsonb_build_object('from', v_from, 'to', p_to_stage, 'actor_role', v_role), auth.uid()
    from public.workspace_members wm
   where wm.workspace_id=v_ws and wm.active = true and wm.user_id <> auth.uid();
  return p_post_id;
end; $function$;

CREATE OR REPLACE FUNCTION public.post_soft_delete(p_post_id uuid, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_ws uuid; v_role text;
begin
  select workspace_id into v_ws from public.posts where id=p_post_id and deleted_at is null;
  if v_ws is null then raise exception 'invalid_payload'; end if;
  if not public.is_active_workspace_member(v_ws) then raise exception 'workspace_member_only'; end if;
  if not public.proc_capability(v_ws, 'post.delete') then raise exception 'forbidden_role'; end if;
  select wm.role into v_role from public.workspace_members wm
   where wm.workspace_id = v_ws and wm.user_id = auth.uid() and wm.active = true;
  update public.posts set deleted_at=now(), row_version=row_version+1 where id=p_post_id;
  perform public.audit_log_write('post_soft_delete','success',p_trace_id,v_ws,'post',p_post_id::text,'{}'::jsonb);
  insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  select wm.user_id, v_ws, 'post_deleted', 'post', p_post_id::text, 'posts', p_post_id::text, 'active',
         jsonb_build_object('number', p.number, 'title', left(coalesce(p.title, p.caption, ''), 120), 'actor_role', v_role),
         auth.uid()
    from public.workspace_members wm, public.posts p
   where wm.workspace_id = v_ws and wm.active = true and wm.user_id <> auth.uid() and p.id = p_post_id;
  return p_post_id;
end; $function$;

CREATE OR REPLACE FUNCTION public.asset_delete(p_asset_id uuid, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_ws uuid; v_name text; v_role text;
BEGIN
  SELECT workspace_id INTO v_ws
    FROM public.assets WHERE id = p_asset_id AND deleted_at IS NULL;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF EXISTS (SELECT 1 FROM public.assets WHERE id = p_asset_id AND origin = 'chat') THEN
    RAISE EXCEPTION 'chat files are deleted with their message'; END IF;
  UPDATE public.assets SET deleted_at = now() WHERE id = p_asset_id RETURNING filename INTO v_name;
  PERFORM public.audit_log_write('asset_delete','success',p_trace_id,v_ws,'asset',p_asset_id::text);
  SELECT wm.role INTO v_role FROM public.workspace_members wm
   WHERE wm.workspace_id = v_ws AND wm.user_id = auth.uid() AND wm.active = true;
  INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  SELECT wm.user_id, v_ws, 'assets_deleted', 'workspace', v_ws::text, 'everything', v_ws::text, 'active',
         jsonb_build_object('count', 1, 'filenames', jsonb_build_array(v_name), 'actor_role', v_role), auth.uid()
    FROM public.workspace_members wm
   WHERE wm.workspace_id = v_ws AND wm.active = true AND wm.user_id <> auth.uid();
END; $function$;

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
  v_ids uuid[];
  v_names text[];
  v_role text;
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

  WITH deleted AS (
    UPDATE public.assets SET deleted_at = now()
      WHERE id = ANY(p_asset_ids) AND workspace_id = v_ws AND deleted_at IS NULL
      RETURNING id, filename
  )
  SELECT array_agg(id), (array_agg(filename ORDER BY filename))[1:3]
    INTO v_ids, v_names
    FROM deleted;

  IF v_ids IS NULL THEN RETURN; END IF;

  FOREACH v_id IN ARRAY v_ids LOOP
    PERFORM public.audit_log_write('asset_delete','success',p_trace_id,v_ws,'asset',v_id::text);
  END LOOP;

  SELECT wm.role INTO v_role FROM public.workspace_members wm
   WHERE wm.workspace_id = v_ws AND wm.user_id = auth.uid() AND wm.active = true;
  INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  SELECT wm.user_id, v_ws, 'assets_deleted', 'workspace', v_ws::text, 'everything', v_ws::text, 'active',
         jsonb_build_object('count', cardinality(v_ids), 'filenames', to_jsonb(v_names), 'actor_role', v_role), auth.uid()
    FROM public.workspace_members wm
   WHERE wm.workspace_id = v_ws AND wm.active = true AND wm.user_id <> auth.uid();
END; $function$;

commit;

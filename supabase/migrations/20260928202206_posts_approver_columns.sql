alter table public.posts
  add column approved_by uuid references auth.users(id) on delete set null,
  add column approved_at timestamptz;

create or replace function public.stage_transition(p_post_id uuid, p_to_stage text, p_trace_id uuid)
returns uuid language plpgsql security definer set search_path to 'public'
as $$
declare v_ws uuid; v_from text; v_cap text; v_ok boolean; v_closed int := 0;
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
          jsonb_build_object('from',v_from,'to',p_to_stage,'checkpoints_closed',v_closed));
  insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  select wm.user_id, v_ws, 'stage_change', 'post', p_post_id::text, 'posts', p_post_id::text, 'active',
         jsonb_build_object('from', v_from, 'to', p_to_stage), auth.uid()
    from public.workspace_members wm
   where wm.workspace_id=v_ws and wm.active = true and wm.user_id <> auth.uid();
  return p_post_id;
end; $$;

update public.posts p
   set approved_by = a.actor_user_id, approved_at = a.created_at, row_version = p.row_version + 1
  from (
    select distinct on (entity_id) entity_id, actor_user_id, created_at
      from public.audit_log
     where action='stage_transition' and entity_type='post' and outcome='success'
       and payload->>'to'='approved'
     order by entity_id, created_at desc
  ) a
 where p.id::text = a.entity_id and p.stage='approved' and p.approved_by is null;

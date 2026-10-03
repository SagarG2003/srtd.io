-- Applied live 3 Oct 2026 via MCP on project movnexawfhsyuluspxoc. This file is
-- the record; do not execute.
--
-- The one difference from the applied SQL: the cron.schedule call is wrapped in
-- IF to_regclass('cron.job') IS NOT NULL (the same guard as
-- 20260710153728_record_live_procs_and_version_fold.sql). CI containers have no
-- pg_cron, so an unguarded call fails every migration-built test database. Live
-- has pg_cron, so the guard is true there and the job is scheduled as applied.

-- 20261003140000_chat_message_reminders.sql  (project movnexawfhsyuluspxoc)
begin;

-- Bell: reminders become inbox entries
alter table public.inbox_entries drop constraint inbox_entries_event_type_check;
alter table public.inbox_entries add constraint inbox_entries_event_type_check check (event_type = any (array[
 'comment','mention','stage_change','comment_resolved','brief_created','brief_closed','asset_uploaded','asset_version_added',
 'invite','trial_warning','billing_failure','system','checkpoints_added','post_ready','checkpoint_reopened','checkpoint_asked',
 'scheduled_sent','scheduled_failed','reminder']));

create table public.chat_message_reminders (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  message_id text not null,
  channel_id text not null references public.chat_channels(channel_id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  remind_at timestamptz not null,
  fired_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now());
create unique index chat_reminders_one_active on public.chat_message_reminders (user_id, message_id) where fired_at is null and cancelled_at is null;
create index chat_reminders_due_idx on public.chat_message_reminders (remind_at) where fired_at is null and cancelled_at is null;
create index chat_reminders_user_idx on public.chat_message_reminders (user_id, workspace_id, remind_at);
create index chat_reminders_channel_idx on public.chat_message_reminders (channel_id);
create index chat_reminders_workspace_idx on public.chat_message_reminders (workspace_id);
create index chat_reminders_message_idx on public.chat_message_reminders (message_id);

alter table public.chat_message_reminders enable row level security;
create policy chat_reminders_select_own on public.chat_message_reminders for select to authenticated using (user_id = auth.uid());
revoke all on public.chat_message_reminders from anon, authenticated;
grant select on public.chat_message_reminders to authenticated;

-- Set a reminder (also "Change time": replaces the caller's pending one on the same message)
create or replace function public.chat_reminder_set(p_id uuid, p_message_id text, p_channel_id text, p_remind_at timestamptz, p_trace_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
declare v_actor uuid := auth.uid(); v_ws uuid;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  if p_id is null or p_trace_id is null then raise exception 'p_id and p_trace_id are required'; end if;
  if exists (select 1 from public.chat_message_reminders where id = p_id) then return; end if;
  if p_remind_at is null or p_remind_at < now() + interval '1 minute' or p_remind_at > now() + interval '365 days' then
    raise exception 'reminder must be between 1 minute and 1 year from now'; end if;
  if not public.chat_channel_member(p_channel_id, v_actor) then raise exception 'not a member of this chat'; end if;
  select workspace_id into v_ws from public.chat_messages where id = p_message_id and channel_id = p_channel_id and deleted_at is null limit 1;
  if v_ws is null then raise exception 'message not found'; end if;
  update public.chat_message_reminders set cancelled_at = now()
  where user_id = v_actor and message_id = p_message_id and fired_at is null and cancelled_at is null;
  insert into public.chat_message_reminders (id, user_id, message_id, channel_id, workspace_id, remind_at)
  values (p_id, v_actor, p_message_id, p_channel_id, v_ws, p_remind_at);
  perform public.audit_log_write('chat_reminder_set', 'success', p_trace_id, v_ws, 'chat_message', p_message_id,
    jsonb_build_object('reminder_id', p_id, 'remind_at', p_remind_at));
end $$;

create or replace function public.chat_reminder_cancel(p_id uuid, p_trace_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
declare v_actor uuid := auth.uid(); v_ws uuid; v_msg text;
begin
  if v_actor is null then raise exception 'not authenticated'; end if;
  if p_trace_id is null then raise exception 'p_trace_id is required'; end if;
  update public.chat_message_reminders set cancelled_at = now()
  where id = p_id and user_id = v_actor and fired_at is null and cancelled_at is null
  returning workspace_id, message_id into v_ws, v_msg;
  if v_ws is not null then
    perform public.audit_log_write('chat_reminder_cancel', 'success', p_trace_id, v_ws, 'chat_message', v_msg,
      jsonb_build_object('reminder_id', p_id));
  end if;
end $$;

-- Cron only: fire due reminders into the bell (skips people who left the chat and deleted messages)
create or replace function public.chat_reminders_fire(p_limit integer default 500)
returns integer language plpgsql security definer set search_path to '' as $$
declare v_count integer;
begin
  with due as (
    select r.id from public.chat_message_reminders r
    where r.fired_at is null and r.cancelled_at is null and r.remind_at <= now()
    order by r.remind_at limit least(greatest(coalesce(p_limit, 500), 1), 2000) for update skip locked),
  marked as (
    update public.chat_message_reminders r set fired_at = now() from due where r.id = due.id
    returning r.id, r.user_id, r.message_id, r.channel_id, r.workspace_id),
  ins as (
    insert into public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
    select m.user_id, m.workspace_id, 'reminder', 'chat_channel', m.channel_id,
      case when c.channel_type = 'group' then 'groups' else 'people' end, m.channel_id, 'urgent',
      jsonb_build_object('message_id', m.message_id, 'reminder_id', m.id), null
    from marked m join public.chat_channels c on c.channel_id = m.channel_id
    where public.chat_channel_member(m.channel_id, m.user_id)
      and exists (select 1 from public.chat_messages x where x.id = m.message_id and x.channel_id = m.channel_id and x.deleted_at is null)
    returning 1)
  select count(*) into v_count from ins;
  return v_count;
end $$;

-- Deleting a message cancels its pending reminders
create or replace function public.chat_messages_reminders_on_delete()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  update public.chat_message_reminders set cancelled_at = now()
  where message_id = new.id and fired_at is null and cancelled_at is null;
  return null;
end $$;
create trigger chat_messages_reminders_on_delete after update of deleted_at on public.chat_messages
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function public.chat_messages_reminders_on_delete();

revoke all on function
  public.chat_reminder_set(uuid, text, text, timestamptz, uuid),
  public.chat_reminder_cancel(uuid, uuid),
  public.chat_reminders_fire(integer),
  public.chat_messages_reminders_on_delete()
from public, anon, authenticated, service_role;
grant execute on function
  public.chat_reminder_set(uuid, text, text, timestamptz, uuid),
  public.chat_reminder_cancel(uuid, uuid)
to authenticated;

do $$
begin
  if to_regclass('cron.job') is not null then
    perform cron.schedule('chat-reminders-fire', '* * * * *', $cron$select public.chat_reminders_fire(500)$cron$);
  end if;
end $$;

commit;

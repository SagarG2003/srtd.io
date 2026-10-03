-- Applied live 3 Oct 2026 via MCP on project movnexawfhsyuluspxoc. This file is
-- the record; do not execute. Statements and order match what was applied.
--
-- Chat thread root: every reply carries the id of the top-level message of its
-- thread, so a thread can be read and counted without walking reply chains.
--   1. chat_messages.thread_root_message_id text, null for non-replies.
--   2. chat_messages_set_thread_root() (BEFORE INSERT OR UPDATE OF
--      reply_to_message_id) derives it from the parent in the same channel:
--      coalesce(parent.thread_root_message_id, parent.id). Clients never set it.
--   3. Backfill of existing replies via a recursive walk from top-level rows.
--   4. Partial index for per-thread reads.
--   5. chat_thread_reply_counts: per-root reply count and last reply time,
--      SECURITY INVOKER so chat_messages RLS applies; first 200 ids only.

alter table public.chat_messages add column thread_root_message_id text;

create or replace function public.chat_messages_set_thread_root()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.reply_to_message_id is null then
    new.thread_root_message_id := null;
  else
    select coalesce(p.thread_root_message_id, p.id)
      into new.thread_root_message_id
      from public.chat_messages p
     where p.id = new.reply_to_message_id
       and p.channel_id = new.channel_id
     limit 1;
  end if;
  return new;
end
$$;

create trigger chat_messages_thread_root
  before insert or update of reply_to_message_id on public.chat_messages
  for each row execute function public.chat_messages_set_thread_root();

with recursive chain as (
  select id, created_at, id as root
    from public.chat_messages
   where reply_to_message_id is null
  union all
  select c.id, c.created_at, ch.root
    from public.chat_messages c
    join chain ch on c.reply_to_message_id = ch.id
)
update public.chat_messages m
   set thread_root_message_id = chain.root
  from chain
 where m.id = chain.id
   and m.created_at = chain.created_at
   and m.reply_to_message_id is not null;

create index chat_messages_thread_root_idx
  on public.chat_messages (channel_id, thread_root_message_id, created_at)
  where thread_root_message_id is not null;

create or replace function public.chat_thread_reply_counts(
  p_trace_id uuid,
  p_channel_id text,
  p_root_ids text[]
)
returns table (root_id text, reply_count bigint, last_reply_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select m.thread_root_message_id, count(*), max(m.created_at)
    from public.chat_messages m
   where m.channel_id = p_channel_id
     and m.thread_root_message_id = any (p_root_ids[1:200])
     and m.deleted_at is null
   group by m.thread_root_message_id
$$;

revoke all on function public.chat_thread_reply_counts(uuid, text, text[]) from public;
grant execute on function public.chat_thread_reply_counts(uuid, text, text[]) to authenticated;

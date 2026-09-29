create or replace function public.chat_mentions_resolve(p_channel_id text, p_actor uuid, p_mentions jsonb)
returns uuid[] language plpgsql stable security definer set search_path to '' as $$
declare v_ids uuid[]; v_bad int; v_all boolean; v_type text; v_group text;
begin
  if p_mentions is null or p_mentions = 'null'::jsonb then return array[]::uuid[]; end if;
  if jsonb_typeof(p_mentions) <> 'array' then raise exception 'mentions must be a list of people'; end if;
  if jsonb_array_length(p_mentions) > 50 then raise exception 'too many mentions'; end if;
  v_all := exists (select 1 from jsonb_array_elements_text(p_mentions) x where x = 'all');
  select coalesce(array_agg(distinct x::uuid), array[]::uuid[]) into v_ids
    from jsonb_array_elements_text(p_mentions) x
   where case when x = 'all' then false else x::uuid <> p_actor end;
  select count(*) into v_bad from unnest(v_ids) u where not public.chat_channel_member(p_channel_id, u);
  if v_bad > 0 then raise exception 'mentioned people must be in this chat'; end if;
  if v_all then
    select channel_type, entity_id::text into v_type, v_group from public.chat_channels where channel_id = p_channel_id;
    if v_type is distinct from 'group' then raise exception 'everyone mention works only in groups'; end if;
    select coalesce(array_agg(distinct u), array[]::uuid[]) into v_ids
      from (select unnest(v_ids) u
            union
            select gm.user_id from public.group_members gm where gm.group_id::text = v_group) s
     where u <> p_actor and public.chat_channel_member(p_channel_id, u);
  end if;
  return v_ids;
end $$;
revoke all on function public.chat_mentions_resolve(text, uuid, jsonb) from public, anon, authenticated;

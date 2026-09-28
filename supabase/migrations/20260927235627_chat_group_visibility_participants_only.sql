-- chat_channels, groups and group_members SELECT were workspace-wide, so every active member saw every DM
-- and group in the workspace (list metadata only; chat_messages RLS was already correct). Narrow them to
-- participants / group members (plan_period channels stay visible to all active members via
-- chat_channel_member), auto-archive a group when its last member leaves, and archive existing empty groups.
-- Applied live 2026-09-27 23:54Z. Non-destructive (the final UPDATE is a soft-delete via deleted_at).
BEGIN;

CREATE OR REPLACE FUNCTION public.is_group_member(p_group_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members gm
    JOIN public.workspace_members wm
      ON wm.workspace_id = gm.workspace_id AND wm.user_id = gm.user_id AND wm.active = true
    WHERE gm.group_id = p_group_id AND gm.user_id = auth.uid()
  );
$$;
REVOKE ALL ON FUNCTION public.is_group_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_group_member(uuid) TO authenticated;

ALTER POLICY chat_channels_select_member ON public.chat_channels
  USING (public.chat_channel_member(channel_id, auth.uid()));
ALTER POLICY groups_select_member ON public.groups
  USING (deleted_at IS NULL AND public.is_group_member(id));
ALTER POLICY group_members_select_member ON public.group_members
  USING (public.is_group_member(group_id));

CREATE OR REPLACE FUNCTION public.group_archive_when_empty()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
BEGIN
  UPDATE public.groups g SET deleted_at = now()
  WHERE g.id = OLD.group_id AND g.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.group_id = OLD.group_id);
  RETURN NULL;
END; $$;
REVOKE ALL ON FUNCTION public.group_archive_when_empty() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER group_archive_when_empty
  AFTER DELETE ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.group_archive_when_empty();

UPDATE public.groups g SET deleted_at = now()
WHERE g.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.group_id = g.id);

COMMIT;
-- END MIGRATION

-- Applied live 30 Sep 2026 via MCP. Chat files are private to their chat; Assets shows library only.
-- This file is the record. Definitions are copied from the live database
-- (information_schema.columns, pg_constraint, pg_policies, pg_indexes,
-- pg_get_functiondef) on project movnexawfhsyuluspxoc.
--
-- 1. assets.origin ('library' | 'chat'), default 'library'.
-- 2. Backfill: chat-only assets become origin 'chat' (25 chat, 562 library live).
-- 3. assets_select_member lists library assets only.
-- 4. asset_versions_select_member reads versions of library assets only.
-- 5. GIN index on chat_messages.attachment_asset_ids for the containment lookup.
-- 6. chat_attachment_readable: service-role check for chat file reads.

-- 1. Column
ALTER TABLE public.assets
  ADD COLUMN origin text NOT NULL DEFAULT 'library'::text,
  ADD CONSTRAINT assets_origin_check CHECK ((origin = ANY (ARRAY['library'::text, 'chat'::text])));

-- 2. Backfill: no asset_attachments row, and either referenced by a chat
--    message (via asset_versions) or a recorded voice note with an audio version.
UPDATE public.assets a
   SET origin = 'chat'
 WHERE NOT EXISTS (SELECT 1 FROM public.asset_attachments x WHERE x.asset_id = a.id)
   AND (EXISTS (SELECT 1
                  FROM public.chat_messages m
                  JOIN public.asset_versions v ON v.id = ANY (m.attachment_asset_ids)
                 WHERE v.asset_id = a.id)
        OR (a.filename LIKE 'voice-note.%'
            AND EXISTS (SELECT 1 FROM public.asset_versions v
                         WHERE v.asset_id = a.id AND v.kind = 'audio')));

-- 3. Assets read policy: library only
DROP POLICY IF EXISTS assets_select_member ON public.assets;
CREATE POLICY assets_select_member ON public.assets AS PERMISSIVE FOR SELECT TO authenticated
  USING (((deleted_at IS NULL) AND (origin = 'library'::text) AND (EXISTS ( SELECT 1
   FROM workspace_members wm
  WHERE ((wm.workspace_id = assets.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true))))));

-- 4. Asset versions read policy: versions of library assets only
DROP POLICY IF EXISTS asset_versions_select_member ON public.asset_versions;
CREATE POLICY asset_versions_select_member ON public.asset_versions AS PERMISSIVE FOR SELECT TO authenticated
  USING (((EXISTS ( SELECT 1
   FROM workspace_members wm
  WHERE ((wm.workspace_id = asset_versions.workspace_id) AND (wm.user_id = auth.uid()) AND (wm.active = true)))) AND (EXISTS ( SELECT 1
   FROM assets a
  WHERE ((a.id = asset_versions.asset_id) AND (a.origin = 'library'::text))))));

-- 5. Index (created on the partitioned parent; Postgres propagates it to every partition)
CREATE INDEX IF NOT EXISTS chat_messages_attachment_asset_ids_gin ON public.chat_messages USING gin (attachment_asset_ids);

-- 6. Chat attachment read check
CREATE OR REPLACE FUNCTION public.chat_attachment_readable(p_asset_version_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
      select 1 from public.asset_versions v join public.assets a on a.id = v.asset_id
      where v.id = p_asset_version_id and a.uploaded_by = p_user_id)
    or exists (
      select 1 from public.chat_messages m
      where m.attachment_asset_ids @> array[p_asset_version_id]
        and m.deleted_at is null
        and public.chat_channel_member(m.channel_id, p_user_id)
        and m.created_at > coalesce(public.chat_cleared_at(m.channel_id, p_user_id), '-infinity'::timestamptz));
$function$;

REVOKE ALL ON FUNCTION public.chat_attachment_readable(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_attachment_readable(uuid, uuid) TO service_role;

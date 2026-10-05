-- Chat files stay in chat (decision 72).
-- D1 gallery_set, brief_create, comment_create, comment_batch_create refuse a version whose asset is
--    origin='chat' or soft-deleted: 'attachment not available'. gallery_set exempts versions
--    already live-attached to the same post, so an unchanged gallery still saves.
-- D2 asset_delete, asset_delete_many refuse origin='chat' assets.
-- D3 chat_attachment_readable uploader branch reads asset_versions.uploaded_by.
-- Bodies are the live definitions with only these additions. Signatures, return types,
-- SECURITY DEFINER, search_path and grants are unchanged (CREATE OR REPLACE keeps the ACL).

CREATE OR REPLACE FUNCTION public.gallery_set(p_post_id uuid, p_asset_version_ids uuid[], p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_ws uuid; v_ver uuid; v_uid uuid := auth.uid(); i int; v_len int;
BEGIN
  SELECT workspace_id INTO v_ws FROM public.posts WHERE id=p_post_id AND deleted_at IS NULL FOR UPDATE;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF NOT public.proc_capability(v_ws,'post.edit') THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  IF p_asset_version_ids IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  v_len := COALESCE(array_length(p_asset_version_ids,1),0);
  IF EXISTS (SELECT 1 FROM unnest(p_asset_version_ids) av(id)
             LEFT JOIN public.asset_versions v ON v.id=av.id AND v.workspace_id=v_ws
             WHERE v.id IS NULL) THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF EXISTS (SELECT 1 FROM public.asset_versions v JOIN public.assets a ON a.id = v.asset_id
             WHERE v.id = ANY(p_asset_version_ids) AND v.workspace_id = v_ws
               AND (a.origin = 'chat' OR a.deleted_at IS NOT NULL)
               AND NOT EXISTS (SELECT 1 FROM public.asset_attachments x
                               WHERE x.entity_type='post' AND x.entity_id=p_post_id::text
                                 AND x.deleted_at IS NULL AND x.asset_version_id = v.id)) THEN
    RAISE EXCEPTION 'attachment not available'; END IF;
  IF COALESCE((SELECT array_agg(asset_version_id ORDER BY position) FROM public.asset_attachments
      WHERE entity_type='post' AND entity_id=p_post_id::text AND deleted_at IS NULL), '{}'::uuid[])
     IS NOT DISTINCT FROM p_asset_version_ids THEN
    SELECT id INTO v_ver FROM public.post_versions WHERE post_id=p_post_id ORDER BY version_number DESC LIMIT 1;
    IF v_ver IS NOT NULL THEN RETURN v_ver; END IF;
  END IF;
  UPDATE public.asset_attachments SET deleted_at=now()
   WHERE entity_type='post' AND entity_id=p_post_id::text AND deleted_at IS NULL
     AND asset_version_id <> ALL(p_asset_version_ids);
  IF v_len > 0 THEN
    FOR i IN 1..v_len LOOP
      UPDATE public.asset_attachments SET position=i-1, deleted_at=NULL
       WHERE entity_type='post' AND entity_id=p_post_id::text AND asset_version_id=p_asset_version_ids[i];
      IF NOT FOUND THEN
        INSERT INTO public.asset_attachments
          (asset_id, asset_version_id, entity_type, entity_id, workspace_id, position, attached_by)
        SELECT v.asset_id, v.id, 'post', p_post_id::text, v_ws, i-1, v_uid
          FROM public.asset_versions v WHERE v.id=p_asset_version_ids[i];
      END IF;
    END LOOP;
  END IF;
  UPDATE public.posts SET row_version=row_version+1, updated_at=now() WHERE id=p_post_id;
  v_ver := public.post_version_create(p_post_id, public._post_snapshot(p_post_id), p_trace_id);
  PERFORM public.audit_log_write('gallery_set','success',p_trace_id,v_ws,'post',p_post_id::text,
          jsonb_build_object('count',v_len,'version_id',v_ver));
  RETURN v_ver;
END; $function$;

CREATE OR REPLACE FUNCTION public.brief_create(p_workspace_id uuid, p_payload jsonb, p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_id uuid; v_title text; v_obj text; v_version_ids uuid[]; v_uid uuid := auth.uid(); i int; v_number integer;
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF NOT public.proc_capability(p_workspace_id, 'brief.create') THEN RAISE EXCEPTION 'forbidden_role'; END IF;
  v_title := p_payload->>'title'; v_obj := p_payload->>'objective';
  IF v_title IS NULL OR v_obj IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF p_payload ? 'attachment_asset_version_ids' THEN
    IF jsonb_typeof(p_payload->'attachment_asset_version_ids') <> 'array' THEN RAISE EXCEPTION 'invalid_payload'; END IF;
    BEGIN
      SELECT array_agg(value::uuid) INTO v_version_ids
      FROM jsonb_array_elements_text(p_payload->'attachment_asset_version_ids');
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'invalid_payload';
    END;
  END IF;
  IF v_version_ids IS NOT NULL AND array_length(v_version_ids,1) IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM unnest(v_version_ids) av(id)
               LEFT JOIN public.asset_versions v ON v.id=av.id AND v.workspace_id=p_workspace_id
               WHERE v.id IS NULL) THEN RAISE EXCEPTION 'invalid_payload'; END IF;
    IF EXISTS (SELECT 1 FROM public.asset_versions v JOIN public.assets a ON a.id = v.asset_id
               WHERE v.id = ANY(v_version_ids) AND v.workspace_id = p_workspace_id
                 AND (a.origin = 'chat' OR a.deleted_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'attachment not available'; END IF;
  END IF;
  UPDATE public.workspace_counters
     SET next_entity_number = next_entity_number + 1
   WHERE workspace_id = p_workspace_id
   RETURNING next_entity_number - 1 INTO v_number;
  IF v_number IS NULL THEN RAISE EXCEPTION 'workspace_counter_missing'; END IF;
  BEGIN
    INSERT INTO public.briefs (workspace_id, number, title, objective, format_requested, brand_requirements,
      target_date, reference_links, created_by, created_via)
    VALUES (p_workspace_id, v_number, v_title, v_obj, p_payload->>'format_requested', p_payload->>'brand_requirements',
      (p_payload->>'target_date')::date, p_payload->'reference_links', v_uid,
      coalesce(p_payload->>'created_via','app'))
    RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'invalid_payload';
  END;
  IF v_version_ids IS NOT NULL AND array_length(v_version_ids,1) IS NOT NULL THEN
    FOR i IN 1..array_length(v_version_ids,1) LOOP
      INSERT INTO public.asset_attachments
        (asset_id, asset_version_id, entity_type, entity_id, workspace_id, position, attached_by)
      SELECT v.asset_id, v.id, 'brief', v_id::text, p_workspace_id, i-1, v_uid
      FROM public.asset_versions v WHERE v.id=v_version_ids[i];
    END LOOP;
  END IF;
  PERFORM public.audit_log_write(p_action=>'brief_create', p_outcome=>'success', p_trace_id=>p_trace_id,
    p_workspace_id=>p_workspace_id, p_entity_type=>'brief', p_entity_id=>v_id::text,
    p_payload=>jsonb_build_object('title', v_title, 'attachments', coalesce(array_length(v_version_ids,1),0), 'number', v_number));
  RETURN v_id;
END; $function$;

CREATE OR REPLACE FUNCTION public.comment_create(p_workspace_id uuid, p_entity_type text, p_entity_id uuid, p_parent_comment_id uuid, p_body text, p_mentions jsonb, p_attachment_asset_ids uuid[], p_trace_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_id uuid; v_scope text; v_is_draft boolean := false; v_brief_owner uuid; v_mentioned uuid[];
BEGIN
  IF NOT public.is_active_workspace_member(p_workspace_id) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF p_entity_type = 'post' AND p_parent_comment_id IS NULL AND EXISTS (
       SELECT 1 FROM public.workspace_members wm
       WHERE wm.workspace_id = p_workspace_id AND wm.user_id = auth.uid()
         AND wm.active = true AND wm.role = 'client') THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;
  IF p_entity_type NOT IN ('post','brief') OR p_entity_id IS NULL
     OR p_body IS NULL OR char_length(p_body) > 10000 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF char_length(btrim(p_body)) = 0
     AND coalesce(array_length(p_attachment_asset_ids,1),0) = 0 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF p_parent_comment_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.comments WHERE id=p_parent_comment_id AND parent_comment_id IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_payload'; END IF;
  BEGIN
    INSERT INTO public.comments (workspace_id, entity_type, entity_id, parent_comment_id, author_user_id,
      body, mentions, attachment_asset_ids)
    VALUES (p_workspace_id, p_entity_type, p_entity_id, p_parent_comment_id, auth.uid(),
      p_body, p_mentions, p_attachment_asset_ids) RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation OR not_null_violation OR foreign_key_violation THEN
    RAISE EXCEPTION 'invalid_payload';
  END;
  IF p_attachment_asset_ids IS NOT NULL AND array_length(p_attachment_asset_ids,1) IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.asset_versions v JOIN public.assets a ON a.id = v.asset_id
               WHERE v.id = ANY(p_attachment_asset_ids) AND v.workspace_id = p_workspace_id
                 AND (a.origin = 'chat' OR a.deleted_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'attachment not available'; END IF;
    IF (SELECT count(*) FROM public.asset_versions av
          JOIN public.assets a ON a.id = av.asset_id
         WHERE av.id = ANY(p_attachment_asset_ids) AND av.workspace_id = p_workspace_id
           AND a.deleted_at IS NULL)
       <> array_length(p_attachment_asset_ids,1) THEN RAISE EXCEPTION 'invalid_payload'; END IF;
    INSERT INTO public.asset_attachments
      (asset_id, asset_version_id, entity_type, entity_id, workspace_id, position, attached_by)
    SELECT av.asset_id, av.id, 'comment', v_id::text, p_workspace_id, (u.ord-1)::int, auth.uid()
    FROM unnest(p_attachment_asset_ids) WITH ORDINALITY AS u(version_id, ord)
    JOIN public.asset_versions av ON av.id = u.version_id;
  END IF;
  IF p_mentions IS NOT NULL AND jsonb_typeof(p_mentions)='array' THEN
    SELECT array_agg(val::uuid) INTO v_mentioned FROM jsonb_array_elements_text(p_mentions) AS val;
  END IF;
  v_mentioned := coalesce(v_mentioned, ARRAY[]::uuid[]);
  IF p_entity_type='post' THEN
    v_scope := 'posts';
    SELECT (stage='draft') INTO v_is_draft FROM public.posts WHERE id=p_entity_id;
    v_is_draft := coalesce(v_is_draft,false);
  ELSE
    v_scope := 'briefs';
    SELECT created_by INTO v_brief_owner FROM public.briefs WHERE id=p_entity_id;
  END IF;
  INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  SELECT wm.user_id, p_workspace_id, 'comment', p_entity_type, p_entity_id::text, v_scope, p_entity_id::text, 'active',
         jsonb_build_object('comment_id', v_id), auth.uid()
  FROM public.workspace_members wm
  WHERE wm.workspace_id=p_workspace_id AND wm.active = true
    AND wm.user_id <> auth.uid() AND wm.user_id <> ALL(v_mentioned)
    AND ( (p_entity_type='post'  AND (NOT v_is_draft OR wm.role IN ('owner','admin','agency')))
       OR (p_entity_type='brief' AND (wm.role IN ('owner','admin','agency') OR wm.user_id = v_brief_owner)) );
  IF array_length(v_mentioned,1) IS NOT NULL THEN
    INSERT INTO public.inbox_entries (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
    SELECT wm.user_id, p_workspace_id, 'mention', p_entity_type, p_entity_id::text, v_scope, p_entity_id::text, 'urgent',
           jsonb_build_object('comment_id', v_id), auth.uid()
    FROM public.workspace_members wm
    WHERE wm.workspace_id=p_workspace_id AND wm.active = true
      AND wm.user_id = ANY(v_mentioned) AND wm.user_id <> auth.uid()
      AND ( (p_entity_type='post'  AND (NOT v_is_draft OR wm.role IN ('owner','admin','agency')))
         OR (p_entity_type='brief' AND (wm.role IN ('owner','admin','agency') OR wm.user_id = v_brief_owner)) );
  END IF;
  PERFORM public.audit_log_write('comment_create','success',p_trace_id,p_workspace_id,'comment',v_id::text,
          jsonb_build_object('entity_type',p_entity_type));
  RETURN v_id;
END; $function$;

CREATE OR REPLACE FUNCTION public.comment_batch_create(p_workspace_id uuid, p_post_id uuid, p_points jsonb, p_trace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_batch uuid := uuidv7(); v_seq int; v_id uuid; v_body text; v_atts uuid[];
  v_point jsonb; v_out jsonb := '[]'::jsonb; v_n int; v_seqs int[] := '{}';
  v_stage text; v_words int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members wm
                 WHERE wm.workspace_id = p_workspace_id AND wm.user_id = auth.uid()
                   AND wm.active = true AND wm.role = 'client') THEN
    RAISE EXCEPTION 'forbidden_role';
  END IF;
  v_n := CASE WHEN jsonb_typeof(p_points) = 'array' THEN jsonb_array_length(p_points) ELSE 0 END;
  IF v_n < 1 OR v_n > 20 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  SELECT stage INTO v_stage FROM public.posts
   WHERE id = p_post_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF v_stage IS NULL THEN RAISE EXCEPTION 'not_found'; END IF;
  IF v_stage = 'draft' THEN RAISE EXCEPTION 'invalid_stage'; END IF;
  SELECT coalesce(max(ledger_seq), 0) INTO v_seq FROM public.comments
   WHERE entity_type = 'post' AND entity_id = p_post_id AND ledger_seq IS NOT NULL;
  FOR v_point IN SELECT * FROM jsonb_array_elements(p_points) LOOP
    v_body := btrim(coalesce(v_point->>'body', ''));
    v_words := coalesce(array_length(regexp_split_to_array(v_body, '\s+'), 1), 0);
    IF v_words < 1 OR v_words > 50 OR length(v_body) > 10000 THEN
      RAISE EXCEPTION 'invalid_payload';
    END IF;
    v_atts := NULL;
    IF v_point ? 'attachment_version_ids'
       AND jsonb_typeof(v_point->'attachment_version_ids') = 'array' THEN
      SELECT array_agg(x::uuid) INTO v_atts
      FROM jsonb_array_elements_text(v_point->'attachment_version_ids') x;
    END IF;
    v_seq := v_seq + 1;
    BEGIN
      INSERT INTO public.comments (workspace_id, entity_type, entity_id, parent_comment_id,
        author_user_id, body, mentions, attachment_asset_ids, ledger_seq, ledger_batch_id)
      VALUES (p_workspace_id, 'post', p_post_id, NULL,
        auth.uid(), v_body, NULL, v_atts, v_seq, v_batch)
      RETURNING id INTO v_id;
    EXCEPTION WHEN check_violation OR not_null_violation OR foreign_key_violation OR unique_violation THEN
      RAISE EXCEPTION 'invalid_payload';
    END;
    IF v_atts IS NOT NULL AND array_length(v_atts, 1) IS NOT NULL THEN
      IF EXISTS (SELECT 1 FROM public.asset_versions v JOIN public.assets a ON a.id = v.asset_id
                 WHERE v.id = ANY(v_atts) AND v.workspace_id = p_workspace_id
                   AND (a.origin = 'chat' OR a.deleted_at IS NOT NULL)) THEN
        RAISE EXCEPTION 'attachment not available'; END IF;
      IF (SELECT count(*) FROM public.asset_versions av
            JOIN public.assets a ON a.id = av.asset_id
           WHERE av.id = ANY(v_atts) AND av.workspace_id = p_workspace_id
             AND a.deleted_at IS NULL) <> array_length(v_atts, 1) THEN
        RAISE EXCEPTION 'invalid_payload';
      END IF;
      INSERT INTO public.asset_attachments
        (asset_id, asset_version_id, entity_type, entity_id, workspace_id, position, attached_by)
      SELECT av.asset_id, av.id, 'comment', v_id::text, p_workspace_id, (u.ord - 1)::int, auth.uid()
      FROM unnest(v_atts) WITH ORDINALITY AS u(version_id, ord)
      JOIN public.asset_versions av ON av.id = u.version_id;
    END IF;
    v_seqs := v_seqs || v_seq;
    v_out := v_out || jsonb_build_object('id', v_id, 'seq', v_seq);
  END LOOP;
  INSERT INTO public.inbox_entries
    (user_id, workspace_id, event_type, entity_type, entity_id, scope, scope_key, tier, payload, actor_user_id)
  SELECT wm.user_id, p_workspace_id, 'checkpoints_added', 'post', p_post_id::text,
         'posts', p_post_id::text, 'active',
         jsonb_build_object('batch_id', v_batch, 'count', v_n, 'seqs', to_jsonb(v_seqs)),
         auth.uid()
  FROM public.workspace_members wm
  WHERE wm.workspace_id = p_workspace_id AND wm.active = true
    AND wm.user_id <> auth.uid();
  PERFORM public.audit_log_write('comment_batch_create', 'success', p_trace_id, p_workspace_id,
          'post', p_post_id::text,
          jsonb_build_object('batch_id', v_batch, 'count', v_n, 'seqs', to_jsonb(v_seqs)));
  RETURN v_out;
END; $function$;

CREATE OR REPLACE FUNCTION public.asset_delete(p_asset_id uuid, p_trace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_ws uuid;
BEGIN
  SELECT workspace_id INTO v_ws
    FROM public.assets WHERE id = p_asset_id AND deleted_at IS NULL;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF EXISTS (SELECT 1 FROM public.assets WHERE id = p_asset_id AND origin = 'chat') THEN
    RAISE EXCEPTION 'chat files are deleted with their message'; END IF;
  UPDATE public.assets SET deleted_at = now() WHERE id = p_asset_id;
  PERFORM public.audit_log_write('asset_delete','success',p_trace_id,v_ws,'asset',p_asset_id::text);
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
BEGIN
  IF p_asset_ids IS NULL OR array_length(p_asset_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;
  IF array_length(p_asset_ids, 1) > 200 THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;

  SELECT count(DISTINCT workspace_id), max(workspace_id)
    INTO v_distinct, v_ws
    FROM public.assets
    WHERE id = ANY(p_asset_ids) AND deleted_at IS NULL;

  IF v_ws IS NULL OR v_distinct <> 1 THEN RAISE EXCEPTION 'invalid_payload'; END IF;
  IF NOT public.is_active_workspace_member(v_ws) THEN RAISE EXCEPTION 'workspace_member_only'; END IF;
  IF EXISTS (SELECT 1 FROM public.assets
             WHERE id = ANY(p_asset_ids) AND workspace_id = v_ws AND deleted_at IS NULL AND origin = 'chat') THEN
    RAISE EXCEPTION 'chat files are deleted with their message'; END IF;

  FOR v_id IN
    WITH deleted AS (
      UPDATE public.assets SET deleted_at = now()
        WHERE id = ANY(p_asset_ids) AND workspace_id = v_ws AND deleted_at IS NULL
        RETURNING id
    )
    SELECT id FROM deleted
  LOOP
    PERFORM public.audit_log_write('asset_delete','success',p_trace_id,v_ws,'asset',v_id::text);
  END LOOP;
END; $function$;

CREATE OR REPLACE FUNCTION public.chat_attachment_readable(p_asset_version_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
      select 1 from public.asset_versions v join public.assets a on a.id = v.asset_id
      where v.id = p_asset_version_id and v.uploaded_by = p_user_id)
    or exists (
      select 1 from public.chat_messages m
      where m.attachment_asset_ids @> array[p_asset_version_id]
        and m.deleted_at is null
        and public.chat_channel_member(m.channel_id, p_user_id)
        and m.created_at > coalesce(public.chat_cleared_at(m.channel_id, p_user_id), '-infinity'::timestamptz));
$function$;

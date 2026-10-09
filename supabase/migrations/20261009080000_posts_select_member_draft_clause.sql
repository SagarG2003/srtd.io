-- Restates live policy (applied out of band). No-op on movnexawfhsyuluspxoc.
ALTER POLICY posts_select_member ON public.posts USING ((deleted_at IS NULL)
AND EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id = posts.workspace_id AND wm.user_id = auth.uid() AND wm.active = true)
AND ((stage <> 'draft') OR EXISTS (SELECT 1 FROM public.workspace_members wm2 WHERE wm2.workspace_id = posts.workspace_id AND wm2.user_id = auth.uid() AND wm2.active = true AND wm2.role = ANY (ARRAY['owner','admin','agency']))));

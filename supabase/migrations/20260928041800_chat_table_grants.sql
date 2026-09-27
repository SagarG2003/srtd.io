-- Chat tables were created without table grants; RLS policies existed but authenticated had no SELECT,
-- so marks, reactions and read cursors vanished on refresh, and service_role could not drain chat_sync_events
-- or read chat_messages for catch-up email. Applied live 2026-09-28. Non-destructive.
GRANT SELECT ON public.chat_message_marks TO authenticated;
GRANT SELECT ON public.chat_reactions TO authenticated;
GRANT SELECT ON public.chat_read_cursors TO authenticated;
GRANT SELECT ON public.chat_channel_clears TO authenticated;
GRANT SELECT, UPDATE ON public.chat_sync_events TO service_role;
GRANT SELECT ON public.chat_messages TO service_role;
-- END MIGRATION

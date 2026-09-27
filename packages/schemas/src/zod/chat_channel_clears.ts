import { z } from 'zod';

export const ChatChannelClearSchema = z.object({
  channel_id: z.string(),
  user_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  cleared_at: z.string(),
});

export type ChatChannelClear = z.infer<typeof ChatChannelClearSchema>;

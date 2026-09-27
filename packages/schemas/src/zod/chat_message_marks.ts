import { z } from 'zod';

export const ChatMessageMarkSchema = z.object({
  message_id: z.string(),
  channel_id: z.string(),
  workspace_id: z.string().uuid(),
  mark_type: z.enum(['commitment', 'decision', 'pending']),
  priority: z.union([z.literal(1), z.literal(2)]).nullable(),
  marked_by: z.string().uuid().nullable(),
  marked_at: z.string(),
  resolved_by: z.string().uuid().nullable(),
  resolved_at: z.string().nullable(),
});

export type ChatMessageMark = z.infer<typeof ChatMessageMarkSchema>;

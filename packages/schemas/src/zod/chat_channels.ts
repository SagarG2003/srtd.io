import { z } from 'zod';

/**
 * One chat_channels row. 'notes' is a person's private Personal notes chat:
 * owner_user_id is its owner and is required for it (null for dm and group),
 * mirroring the chat_channels_shape check.
 */
export const ChatChannelSchema = z
  .object({
    channel_id: z.string(),
    workspace_id: z.string().uuid(),
    channel_type: z.enum(['dm', 'group', 'notes']),
    entity_id: z.string().uuid().nullable(),
    dm_user_a: z.string().uuid().nullable(),
    dm_user_b: z.string().uuid().nullable(),
    owner_user_id: z.string().uuid().nullable(),
    last_synced_at: z.string().nullable(),
    created_at: z.string(),
  })
  .superRefine((row, ctx) => {
    switch (row.channel_type) {
      case 'notes':
        if (row.owner_user_id === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['owner_user_id'],
            message: 'a notes channel needs owner_user_id',
          });
        }
        return;
      case 'dm':
      case 'group':
        if (row.owner_user_id !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['owner_user_id'],
            message: `a ${row.channel_type} channel has no owner_user_id`,
          });
        }
        return;
    }
  });

export type ChatChannel = z.infer<typeof ChatChannelSchema>;

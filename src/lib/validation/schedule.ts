// src/lib/validation/schedule.ts
import { z } from 'zod';
import { idSchema } from './allocation';

export const reassignSchema = z.object({
  draftItemId: idSchema,
  newSessionId: idSchema,
});

export const overridePublishWithGapSchema = z.object({
  draftItemId: idSchema,
  overrideReason: z.string().min(1, 'Override reason is required'),
});

// Exactly one of allocationRunId / changeEventIds, mirroring the DB
// constraint schedule_publication_drafts_one_source.
export const stagePublicationSchema = z
  .object({
    allocationRunId: idSchema.optional(),
    changeEventIds: z.array(idSchema).min(1).optional(),
  })
  .refine((v) => (v.allocationRunId != null) !== (v.changeEventIds != null), {
    message: 'Exactly one of allocationRunId or changeEventIds must be provided',
  });

export const confirmPublicationSchema = z.object({
  draftId: idSchema,
});

import { z } from 'zod';

const mediaUrl = z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }).max(2048);
const headerValue = z
  .string()
  .max(500)
  .refine((value) => !/[\r\n]/.test(value), 'must be a single line');

/** Where a job's media comes from (SPEC §5). Field names follow the spec. */
export const inputSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('media_url'), url: mediaUrl }),
  z.strictObject({
    type: z.literal('url'),
    url: mediaUrl,
    headers: z
      .strictObject({ Referer: headerValue.optional(), 'User-Agent': headerValue.optional() })
      .optional(),
  }),
  z.strictObject({ type: z.literal('upload'), uploadId: z.uuid() }),
  z.strictObject({ type: z.literal('inbox'), name: z.string().min(1).max(255) }),
  z.strictObject({ type: z.literal('output'), outputId: z.uuid() }),
  z.strictObject({
    type: z.literal('google_drive'),
    fileId: z.string().regex(/^[A-Za-z0-9_-]{10,200}$/),
  }),
]);

export type Input = z.output<typeof inputSchema>;

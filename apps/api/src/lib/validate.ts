import { z, type ZodType } from 'zod';

/** Parses request input; a ZodError becomes a 400 validation_error via the error handler. */
export function parse<T extends ZodType>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data ?? {});
}

export const uuid = z.uuid();
export const paise = z.number().int().min(0).max(100_000_000);
export const rateBp = z.number().int().min(0).max(2800);

export const idParams = z.object({ id: z.uuid() });
export const outletQuery = z.object({ outlet_id: z.uuid() });

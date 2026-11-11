import { z } from "zod";

function isTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** An IANA timezone name, e.g. "America/New_York". */
export const timeZoneSchema = z
  .string()
  .refine(isTimeZone, "Unknown IANA timezone");

// A user-chosen slot. Recurrence is defined by the owning schedule service;
// AI Visibility weekly schedules currently preserve local wall-clock time
// across DST.
export const scheduleTimeSchema = z.object({
  weekday: z
    .number()
    .int()
    .min(0)
    .max(6)
    .optional()
    .describe(
      "Day of week, 0 = Sunday. Required for weekly schedules, ignored by the others.",
    ),
  hour: z.number().int().min(0).max(23).describe("Hour, 0-23."),
  minute: z.number().int().min(0).max(59).describe("Minute, 0-59."),
  timeZone: timeZoneSchema
    .optional()
    .describe(
        'Optional IANA timezone, e.g. "America/New_York". How it affects the first run and recurrence depends on the schedule service.',
    ),
});

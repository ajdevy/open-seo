import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { aiProviderRunReservations } from "@/db/schema";

/** Fail closed when a persisted workflow resumes without an active hold. */
export async function hasReservedAiProviderRunBudget(runId: string) {
  const reservation = await db
    .select({ status: aiProviderRunReservations.status })
    .from(aiProviderRunReservations)
    .where(eq(aiProviderRunReservations.runId, runId))
    .limit(1);
  return reservation[0]?.status === "reserved";
}

/** A confirmed workflow completion settles at the provider-reported charge. */
export async function settleAiProviderRunBudget(
  runId: string,
  accountedUsdMicros: number,
  settledAt: string,
) {
  if (!Number.isSafeInteger(accountedUsdMicros) || accountedUsdMicros < 0)
    throw new Error("Provider budget settled amount is invalid.");
  const reservation = await db
    .select()
    .from(aiProviderRunReservations)
    .where(eq(aiProviderRunReservations.runId, runId))
    .limit(1);
  if (!reservation[0] || reservation[0].status !== "reserved") return;
  await db
    .update(aiProviderRunReservations)
    .set({ status: "settled", accountedUsdMicros, settledAt })
    .where(
      and(
        eq(aiProviderRunReservations.id, reservation[0].id),
        eq(aiProviderRunReservations.status, "reserved"),
      ),
    );
}

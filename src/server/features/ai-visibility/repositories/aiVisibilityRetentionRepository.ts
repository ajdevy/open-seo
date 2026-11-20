import { and, asc, eq, inArray, lt, notExists } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import { aiProviderRunReservations, aiRuns } from "@/db/schema";

/** Deletes up to 80 finished runs older than 13 months, with their answers. */
export async function pruneAiHistory(now: Date) {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 13);
  const runs = await db
    .select({ id: aiRuns.id })
    .from(aiRuns)
    .where(
      and(
        lt(aiRuns.createdAt, cutoff.toISOString()),
        inArray(aiRuns.status, ["completed", "partial", "failed"]),
        notExists(
          db
            .select({ id: aiProviderRunReservations.id })
            .from(aiProviderRunReservations)
            .where(
              and(
                eq(aiProviderRunReservations.runId, aiRuns.id),
                inArray(aiProviderRunReservations.status, [
                  "reserved",
                  "unknown",
                ]),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(aiRuns.createdAt))
    .limit(80);
  if (runs.length) {
    const runIds = runs.map((run) => run.id);
    await runBatch((tx) => [
      tx
        .delete(aiProviderRunReservations)
        .where(inArray(aiProviderRunReservations.runId, runIds)),
      tx.delete(aiRuns).where(inArray(aiRuns.id, runIds)),
    ]);
  }
}

import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiProviderRunReservations } from "@/db/schema";

export const AI_PROVIDER_BUDGET_WINDOW_MS = 7 * 24 * 60 * 60_000;

export interface AiProviderBudgetUsage {
  accountedUsdMicros: number;
  heldUsdMicros: number;
}

function usageWindow(cutoff: string) {
  return or(
    inArray(aiProviderRunReservations.status, ["reserved", "unknown"]),
    and(
      eq(aiProviderRunReservations.status, "settled"),
      or(
        gte(aiProviderRunReservations.settledAt, cutoff),
        and(
          isNull(aiProviderRunReservations.settledAt),
          gte(aiProviderRunReservations.createdAt, cutoff),
        ),
      ),
    ),
  );
}

export function usageTotalSql(cutoff: string, projectId?: string) {
  const window = usageWindow(cutoff);
  const filter = projectId
    ? and(window, eq(aiProviderRunReservations.projectId, projectId))
    : window;
  return sql<number>`COALESCE((
    SELECT SUM(
      CASE
        WHEN ${aiProviderRunReservations.status} = 'settled'
          THEN COALESCE(${aiProviderRunReservations.accountedUsdMicros}, ${aiProviderRunReservations.reservedUsdMicros})
        ELSE ${aiProviderRunReservations.reservedUsdMicros}
      END
    )
    FROM ${aiProviderRunReservations}
    WHERE ${filter}
  ), 0)`;
}

async function getBudgetUsage(projectId: string | undefined, now: number) {
  const cutoff = new Date(now - AI_PROVIDER_BUDGET_WINDOW_MS).toISOString();
  const rows = await db
    .select({
      status: aiProviderRunReservations.status,
      reservedUsdMicros: aiProviderRunReservations.reservedUsdMicros,
      accountedUsdMicros: aiProviderRunReservations.accountedUsdMicros,
    })
    .from(aiProviderRunReservations)
    .where(
      projectId
        ? and(
            usageWindow(cutoff),
            eq(aiProviderRunReservations.projectId, projectId),
          )
        : usageWindow(cutoff),
    );
  return rows.reduce(
    (usage, row) => {
      if (row.status === "settled")
        usage.accountedUsdMicros +=
          row.accountedUsdMicros ?? row.reservedUsdMicros;
      else usage.heldUsdMicros += row.reservedUsdMicros;
      return usage;
    },
    { accountedUsdMicros: 0, heldUsdMicros: 0 },
  );
}

/** Provider-reported totals count for seven days; unresolved holds never expire. */
export async function getAiProviderBudgetUsage(
  projectId: string,
  now = Date.now(),
): Promise<AiProviderBudgetUsage> {
  return getBudgetUsage(projectId, now);
}

/** Provider-neutral usage shared by every project on this installation. */
export async function getAiProviderGlobalBudgetUsage(
  now = Date.now(),
): Promise<AiProviderBudgetUsage> {
  return getBudgetUsage(undefined, now);
}

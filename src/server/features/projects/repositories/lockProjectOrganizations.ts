import { inArray } from "drizzle-orm";
import { organization } from "@/db/schema";
import type { runBatch } from "@/db/runBatch";

type BatchExecutor = Parameters<Parameters<typeof runBatch>[0]>[0];

// The no-op update obtains a transactional row lock in PostgreSQL and
// serializes D1 batches. Project creation and legacy-workspace deletion share
// it so a create is either included by the merge or rejected after deletion.
export function lockProjectOrganizations(
  tx: BatchExecutor,
  organizationIds: string[],
) {
  return tx
    .update(organization)
    .set({ name: organization.name })
    .where(inArray(organization.id, organizationIds));
}

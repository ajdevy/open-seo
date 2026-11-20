import { env } from "cloudflare:workers";
import { getDatabaseProvider } from "./provider";
import { d1Db } from "./d1/client";
import { pgDb } from "./pg/client";

// The executor handed to the `build` callback. Typed as the D1 client so call
// sites get full Drizzle inference; at runtime it is either `d1Db` or a Postgres
// transaction handle.
type BatchExecutor = typeof d1Db;
type BatchStatement = Parameters<typeof d1Db.batch>[0][number];

// D1 caps bound parameters at ~100 per statement; keep batches bounded so each
// runBatch call stays under that limit. (Postgres allows far more, but the same
// chunk size is harmless there.)
export const DB_BATCH_SIZE = 100;

/**
 * Run a read/write sequence on one Postgres transaction connection.
 *
 * Unlike `runBatch`, this is for decisions that must read state after an
 * awaited lock statement. READ COMMITTED gives each following query a fresh
 * snapshot, which matters when the lock waited for another transaction to
 * reserve a target-bound archive row.
 */
export async function runPostgresTransaction(
  work: (tx: BatchExecutor) => Promise<void>,
): Promise<void> {
  if (getDatabaseProvider() !== "postgres") {
    throw new Error(
      "Postgres transaction requested for a non-Postgres database.",
    );
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pg tx exposes the same query builder surface as d1Db
  const pg = pgDb as unknown as {
    transaction: (
      fn: (tx: BatchExecutor) => Promise<unknown>,
      config: { isolationLevel: "read committed" },
    ) => Promise<unknown>;
  };
  await pg.transaction(work, { isolationLevel: "read committed" });
}

/**
 * Run ordered writes atomically on either backend. Build statements from the
 * `tx` handle, not module-level `db`, so Postgres stays inside the transaction.
 */
function executeBatch(
  build: (tx: BatchExecutor) => readonly Promise<unknown>[],
  captureResults: true,
): Promise<unknown[]>;
function executeBatch(
  build: (tx: BatchExecutor) => readonly Promise<unknown>[],
  captureResults: false,
): Promise<void>;
async function executeBatch(
  build: (tx: BatchExecutor) => readonly Promise<unknown>[],
  captureResults: boolean,
): Promise<unknown[] | void> {
  if (getDatabaseProvider() === "postgres") {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pg tx exposes the same query builder surface as d1Db
    const pg = pgDb as unknown as {
      transaction: (
        fn: (tx: BatchExecutor) => Promise<unknown>,
      ) => Promise<unknown>;
    };
    const results: unknown[] = [];
    await pg.transaction(async (tx) => {
      for (const statement of build(tx)) {
        const result = await statement;
        if (captureResults) results.push(result);
      }
    });
    return captureResults ? results : undefined;
  }

  const statements = build(d1Db);
  if (statements.length === 0) return captureResults ? [] : undefined;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- d1 query builders are BatchItems; length checked above
  const batch = statements as unknown as [BatchStatement, ...BatchStatement[]];
  const results = await d1Db.batch(batch);
  return captureResults ? results : undefined;
}

/** Run a write sequence and retain each dialect's statement results. */
export async function runBatchWithResults(
  build: (tx: BatchExecutor) => readonly Promise<unknown>[],
) {
  return executeBatch(build, true);
}

/** Normalize RETURNING rows from Postgres and D1 batch statement results. */
export function getBatchRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (typeof result !== "object" || result === null || !("results" in result))
    return [];
  return Array.isArray(result.results) ? result.results : [];
}

export async function runBatch(
  build: (tx: BatchExecutor) => readonly Promise<unknown>[],
): Promise<void> {
  await executeBatch(build, false);
}

/**
 * Chunk `items` into D1-safe batches and run each chunk atomically via
 * `runBatch`. Shared by repositories that bulk-insert/update (audit pages,
 * rank snapshots, etc.).
 */
export async function executeInBatches<T>(
  items: T[],
  buildStatement: (tx: BatchExecutor, item: T) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < items.length; i += DB_BATCH_SIZE) {
    const chunk = items.slice(i, i + DB_BATCH_SIZE);
    if (chunk.length === 0) continue;
    await runBatch((tx) => chunk.map((item) => buildStatement(tx, item)));
  }
}

/**
 * The standalone Docker edition's legacy import writes prepared D1 SQL rather
 * than Drizzle statements (its raw SQL builder cannot be batched with bound
 * values in 0.45.2). It lives here because every batch goes through this
 * module, which schema-parity.test.ts enforces.
 */
export async function runD1ImportBatch(statements: D1PreparedStatement[]) {
  if (getDatabaseProvider() !== "d1") {
    throw new Error("Legacy Docker import requires SQLite");
  }
  if (statements.length) await env.DB.batch(statements);
}

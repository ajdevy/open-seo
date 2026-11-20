import { readdirSync, readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { sort } from "remeda";
import { expect, it } from "vitest";

it("preserves SQLite Drive connections and permits an unavailable email", async () => {
  const client = createClient({ url: "file::memory:" });
  try {
    const migrations = sort(
      readdirSync("drizzle/sqlite").filter((file) => file.endsWith(".sql")),
      (a, b) => a.localeCompare(b),
    );
    const migration = "0068_burly_cannonball.sql";
    expect(migrations).toContain(migration);
    for (const file of migrations) {
      if (file === migration) break;
      await client.executeMultiple(
        readFileSync(`drizzle/sqlite/${file}`, "utf8").replaceAll(
          "--> statement-breakpoint",
          "",
        ),
      );
    }

    await client.executeMultiple(`
      INSERT INTO organization (id, name, slug, created_at)
        VALUES ('drive-org', 'Drive Org', 'drive-org', 0);
      INSERT INTO user (id, name, email)
        VALUES ('drive-user', 'Drive User', 'drive@example.invalid');
      INSERT INTO google_drive_archive_connections (
        id, organization_id, connected_by_user_id, google_account_id,
        account_email, access_token_ciphertext, refresh_token_ciphertext,
        access_token_expires_at, scope, folder_id, folder_name, status,
        created_at, updated_at
      ) VALUES (
        'drive-connection', 'drive-org', 'drive-user', 'permission-id-1',
        'drive@example.invalid', 'encrypted-access', 'encrypted-refresh',
        '2026-11-20T00:00:00.000Z',
        'https://www.googleapis.com/auth/drive.file', 'folder-id',
        'Archive', 'connected', '2026-11-20T00:00:00.000Z',
        '2026-11-20T00:00:00.000Z'
      );
    `);
    await client.executeMultiple(
      readFileSync(`drizzle/sqlite/${migration}`, "utf8").replaceAll(
        "--> statement-breakpoint",
        "",
      ),
    );

    const preserved = await client.execute(
      `SELECT id, google_account_id, account_email, folder_id, folder_name
       FROM google_drive_archive_connections WHERE id = 'drive-connection'`,
    );
    expect(preserved.rows).toEqual([
      {
        id: "drive-connection",
        google_account_id: "permission-id-1",
        account_email: "drive@example.invalid",
        folder_id: "folder-id",
        folder_name: "Archive",
      },
    ]);

    await client.execute(
      `UPDATE google_drive_archive_connections
       SET account_email = NULL WHERE id = 'drive-connection'`,
    );
    const withoutEmail = await client.execute(
      `SELECT account_email FROM google_drive_archive_connections
       WHERE id = 'drive-connection'`,
    );
    expect(withoutEmail.rows).toEqual([{ account_email: null }]);
  } finally {
    client.close();
  }
});

it("drops only the PostgreSQL email nullability constraint", () => {
  expect(
    readFileSync("drizzle/pg/0046_purple_roland_deschain.sql", "utf8").trim(),
  ).toBe(
    'ALTER TABLE "google_drive_archive_connections" ALTER COLUMN "account_email" DROP NOT NULL;',
  );
});

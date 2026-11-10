import { z } from "zod";
import { exportClientRestoreArchive } from "./client-restore-export";
import { importClientRestoreArchive } from "./client-restore-import";
import { ClientRestoreError } from "./client-restore-schema";
import { isOperatorRequest } from "./operator-auth";

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_REQUEST_BYTES = 52 * 1024 * 1024;

const commandSchema = z.discriminatedUnion("command", [
  z
    .object({ command: z.literal("export"), organizationId: z.string().min(1) })
    .strict(),
  z
    .object({
      command: z.literal("import"),
      targetOrganizationId: z.string().min(1),
      archive: z.unknown(),
    })
    .strict(),
]);

export async function handleClientRestore(request: Request): Promise<Response> {
  if (request.method !== "POST" || !isOperatorRequest(request.headers))
    return new Response("Not found", { status: 404 });
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES)
    return Response.json(
      { error: "Client restore request exceeds the 52 MiB limit" },
      { status: 413 },
    );
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES)
    return Response.json(
      { error: "Client restore request exceeds the 52 MiB limit" },
      { status: 413 },
    );
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return Response.json(
      { error: "Invalid client restore request" },
      { status: 400 },
    );
  }
  const command = commandSchema.safeParse(raw);
  if (!command.success)
    return Response.json(
      { error: "Invalid client restore request" },
      { status: 400 },
    );
  try {
    if (command.data.command === "export") {
      const archive = await exportClientRestoreArchive(
        command.data.organizationId,
      );
      if (
        new TextEncoder().encode(JSON.stringify(archive)).byteLength >
        MAX_ARCHIVE_BYTES
      )
        return Response.json(
          { error: "Client restore archive exceeds the 50 MiB limit" },
          { status: 413 },
        );
      return Response.json(archive);
    }
    return Response.json(
      await importClientRestoreArchive(
        command.data.targetOrganizationId,
        command.data.archive,
      ),
    );
  } catch (error) {
    if (error instanceof ClientRestoreError)
      return Response.json({ error: error.message }, { status: error.status });
    return Response.json(
      { error: "Client restore failed; no cutover is safe" },
      { status: 500 },
    );
  }
}

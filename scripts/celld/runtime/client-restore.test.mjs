import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./client-restore.mjs", import.meta.url));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function runExport(port, outputPath, operatorSecret, key) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [script, "export", "synthetic-client", outputPath],
      {
        env: {
          PATH: process.env.PATH,
          OPENSEO_URL: `http://127.0.0.1:${port}`,
          OPENSEO_OPERATOR_SECRET: operatorSecret,
          OPENSEO_CLIENT_RESTORE_KEY: key,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("operator secret is not forwarded through an HTTP redirect", async () => {
  let receivedSecret;
  let redirectedRequests = 0;
  const destination = createServer((_request, response) => {
    redirectedRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const destinationPort = await listen(destination);
  const source = createServer((request, response) => {
    receivedSecret = request.headers["x-openseo-operator-secret"];
    response.writeHead(302, {
      location: `http://127.0.0.1:${destinationPort}/collect`,
    });
    response.end();
  });
  const sourcePort = await listen(source);
  const directory = await mkdtemp(join(tmpdir(), "client-restore-redirect-"));
  const outputPath = join(directory, "archive.opsc");
  const operatorSecret = "synthetic-operator-secret-for-redirect-test";
  const key = Buffer.alloc(32, 17).toString("base64");

  try {
    const result = await runExport(sourcePort, outputPath, operatorSecret, key);

    assert.notEqual(result.code, 0);
    assert.equal(receivedSecret, operatorSecret);
    assert.equal(redirectedRequests, 0);
    assert.equal(
      `${result.stdout}${result.stderr}`.includes(operatorSecret),
      false,
    );
  } finally {
    await close(source);
    await close(destination);
    await rm(directory, { recursive: true, force: true });
  }
});

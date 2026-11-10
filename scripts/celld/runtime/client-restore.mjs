import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const [command, organizationId, filePath] = process.argv.slice(2);
const fileMagic = Buffer.from("OPSC1");
const maxBytes = 50 * 1024 * 1024;

function keyFromEnvironment() {
  const encoded = process.env.OPENSEO_CLIENT_RESTORE_KEY;
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw new Error("Inject OPENSEO_CLIENT_RESTORE_KEY from Keynv");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded)
    throw new Error("OPENSEO_CLIENT_RESTORE_KEY must decode to 32 bytes");
  return key;
}

function endpointFromEnvironment() {
  const baseUrl = process.env.OPENSEO_URL ?? "http://127.0.0.1:8080";
  const base = new URL(baseUrl);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (base.protocol !== "https:" && !localHosts.has(base.hostname))
    throw new Error("Remote client restore connections require HTTPS");
  const operatorSecret = process.env.OPENSEO_OPERATOR_SECRET;
  if (!operatorSecret || operatorSecret.length < 32)
    throw new Error("Inject OPENSEO_OPERATOR_SECRET from Keynv");
  return {
    url: new URL("/api/standalone/client-restore", base),
    operatorSecret,
  };
}

function encrypt(plaintext, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([fileMagic, nonce, cipher.getAuthTag(), ciphertext]);
}

function decrypt(encrypted, key) {
  if (
    encrypted.length <= fileMagic.length + 12 + 16 ||
    !encrypted.subarray(0, fileMagic.length).equals(fileMagic)
  )
    throw new Error("Invalid encrypted client snapshot");
  const nonceStart = fileMagic.length;
  const tagStart = nonceStart + 12;
  const dataStart = tagStart + 16;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    encrypted.subarray(nonceStart, tagStart),
  );
  decipher.setAuthTag(encrypted.subarray(tagStart, dataStart));
  return Buffer.concat([
    decipher.update(encrypted.subarray(dataStart)),
    decipher.final(),
  ]).toString("utf8");
}

async function callApi(url, operatorSecret, body) {
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      "x-openseo-operator-secret": operatorSecret,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(`Client restore request failed (${response.status})`);
  }
  if (!response.ok)
    throw new Error(
      result.error ?? `Client restore request failed (${response.status})`,
    );
  return result;
}

if (
  !(
    (command === "export" || command === "import") &&
    organizationId &&
    filePath
  )
)
  throw new Error(
    "Usage: node scripts/celld/runtime/client-restore.mjs export ORGANIZATION_ID ARCHIVE.opsc | import TARGET_ORGANIZATION_ID ARCHIVE.opsc",
  );

const key = keyFromEnvironment();
const { url, operatorSecret } = endpointFromEnvironment();

if (command === "export") {
  const archive = await callApi(url, operatorSecret, {
    command: "export",
    organizationId,
  });
  const archiveText = JSON.stringify(archive);
  if (Buffer.byteLength(archiveText) > maxBytes)
    throw new Error("Client snapshot exceeds the 50 MiB limit");
  const encrypted = encrypt(archiveText, key);
  await writeFile(filePath, encrypted, { mode: 0o600, flag: "wx" });
  console.log(
    JSON.stringify({
      status: "encrypted_snapshot_written",
      contentSha256: archive.contentSha256,
      recovery: archive.recovery,
      bytes: encrypted.length,
    }),
  );
} else {
  const encrypted = await readFile(filePath);
  if (encrypted.length > maxBytes + 33)
    throw new Error("Encrypted client snapshot exceeds the 50 MiB limit");
  let archive;
  try {
    archive = JSON.parse(decrypt(encrypted, key));
  } catch {
    throw new Error("Cannot decrypt or parse the client snapshot");
  }
  const result = await callApi(url, operatorSecret, {
    command: "import",
    targetOrganizationId: organizationId,
    archive,
  });
  console.log(
    JSON.stringify({
      status: result.verified ? "verified" : "not_verified",
      contentSha256: result.contentSha256,
      importedContentSha256: result.importedContentSha256,
      importedProjectIds: result.importedProjectIds,
      rowCounts: result.rowCounts,
      recovery: result.recovery,
    }),
  );
}

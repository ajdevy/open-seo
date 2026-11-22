import { describe, expect, it } from "vitest";
import {
  deliverEncryptedAutoGeoSourceArchive,
  prepareEncryptedAutoGeoSourceArchive,
  type EncryptedAutoGeoSourceArchive,
  type AutoGeoSourceArchivePort,
} from "./autogeo-source-archive";
import { AUTOGEO_SOURCE_CONTRACT_REVISION } from "./autogeo-source-contract";

const sourceArtifacts = {
  "prompts/matrix-v1.jsonl": new TextEncoder().encode(
    '{"text":"private synthetic question"}\n',
  ),
  "runs/run-1/claims.jsonl": new TextEncoder().encode(
    "private synthetic unsupported claim\n",
  ),
};

async function testKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function memoryPort(options?: { loseFirstWriteAck?: boolean }): {
  port: AutoGeoSourceArchivePort;
  writes: EncryptedAutoGeoSourceArchive[];
} {
  const stored = new Map<string, EncryptedAutoGeoSourceArchive>();
  const writes: EncryptedAutoGeoSourceArchive[] = [];
  let loseFirstWriteAck = options?.loseFirstWriteAck ?? false;
  return {
    writes,
    port: {
      async putEncryptedSourceArchive(envelope) {
        const key = `${envelope.clientRef}:${envelope.idempotencyKey}`;
        const existing = stored.get(key);
        if (existing) {
          if (
            existing.iv.some((byte, index) => byte !== envelope.iv[index]) ||
            existing.ciphertext.some(
              (byte, index) => byte !== envelope.ciphertext[index],
            )
          )
            throw new Error("idempotency key was reused with different bytes");
        } else {
          stored.set(key, {
            ...envelope,
            iv: envelope.iv.slice(),
            ciphertext: envelope.ciphertext.slice(),
          });
        }
        writes.push({
          ...envelope,
          iv: envelope.iv.slice(),
          ciphertext: envelope.ciphertext.slice(),
        });
        if (loseFirstWriteAck) {
          loseFirstWriteAck = false;
          throw new Error("acknowledgement was lost after the durable write");
        }
        return { fileId: "synthetic-drive-file-1" };
      },
      async readEncryptedSourceArchive(clientRef, idempotencyKey) {
        const value = stored.get(`${clientRef}:${idempotencyKey}`);
        return value
          ? {
              fileId: "synthetic-drive-file-1",
              envelope: {
                ...value,
                iv: value.iv.slice(),
                ciphertext: value.ciphertext.slice(),
              },
            }
          : null;
      },
    },
  };
}

describe("encrypted AutoGeo source archive delivery", () => {
  it("refuses an extractable key for client archive encryption", async () => {
    const extractableKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );

    await expect(
      prepareEncryptedAutoGeoSourceArchive(
        {
          clientRef: "synthetic-client-1",
          sourceContractRevision: AUTOGEO_SOURCE_CONTRACT_REVISION,
          idempotencyKey: "archive-extractable-key",
          artifacts: sourceArtifacts,
        },
        extractableKey,
      ),
    ).rejects.toThrow("invalid source archive key");
  });

  it("stores source paths and bytes as ciphertext and confirms only after read-back", async () => {
    const key = await testKey();
    const envelope = await prepareEncryptedAutoGeoSourceArchive(
      {
        clientRef: "synthetic-client-1",
        sourceContractRevision: AUTOGEO_SOURCE_CONTRACT_REVISION,
        idempotencyKey: "archive-attempt-1",
        artifacts: sourceArtifacts,
      },
      key,
    );
    const { port } = memoryPort();
    const serializedEnvelope = JSON.stringify({
      ...envelope,
      iv: [...envelope.iv],
      ciphertext: [...envelope.ciphertext],
    });
    const ciphertextText = new TextDecoder().decode(envelope.ciphertext);

    expect(serializedEnvelope).not.toContain("private synthetic question");
    expect(serializedEnvelope).not.toContain(
      "private synthetic unsupported claim",
    );
    expect(serializedEnvelope).not.toContain("prompts/matrix-v1.jsonl");
    expect(ciphertextText).not.toContain("private synthetic question");
    expect(ciphertextText).not.toContain("prompts/matrix-v1.jsonl");
    await expect(
      deliverEncryptedAutoGeoSourceArchive(envelope, key, port),
    ).resolves.toEqual({
      status: "confirmed",
      fileId: "synthetic-drive-file-1",
      artifactCount: 2,
    });
  });

  it("does not accept ciphertext rebound to another client", async () => {
    const key = await testKey();
    const envelope = await prepareEncryptedAutoGeoSourceArchive(
      {
        clientRef: "synthetic-client-1",
        sourceContractRevision: AUTOGEO_SOURCE_CONTRACT_REVISION,
        idempotencyKey: "archive-attempt-other-client",
        artifacts: sourceArtifacts,
      },
      key,
    );
    const { port } = memoryPort();

    await expect(
      deliverEncryptedAutoGeoSourceArchive(
        { ...envelope, clientRef: "synthetic-client-2" },
        key,
        port,
      ),
    ).resolves.toMatchObject({
      status: "unconfirmed",
      reason: "archive_payload_invalid",
    });
  });

  it("leaves delivery unconfirmed when read-back bytes differ", async () => {
    const key = await testKey();
    const envelope = await prepareEncryptedAutoGeoSourceArchive(
      {
        clientRef: "synthetic-client-1",
        sourceContractRevision: AUTOGEO_SOURCE_CONTRACT_REVISION,
        idempotencyKey: "archive-attempt-2",
        artifacts: sourceArtifacts,
      },
      key,
    );
    const { port } = memoryPort();
    const corruptingPort: AutoGeoSourceArchivePort = {
      ...port,
      async readEncryptedSourceArchive(clientRef, idempotencyKey) {
        const saved = await port.readEncryptedSourceArchive(
          clientRef,
          idempotencyKey,
        );
        if (!saved) return null;
        const ciphertext = saved.envelope.ciphertext.slice();
        ciphertext[0] ^= 1;
        return {
          ...saved,
          envelope: { ...saved.envelope, ciphertext },
        };
      },
    };

    await expect(
      deliverEncryptedAutoGeoSourceArchive(envelope, key, corruptingPort),
    ).resolves.toMatchObject({
      status: "unconfirmed",
      reason: "readback_mismatch",
      fileId: "synthetic-drive-file-1",
    });
  });

  it("retries the same encrypted envelope after a lost write acknowledgement", async () => {
    const key = await testKey();
    const envelope = await prepareEncryptedAutoGeoSourceArchive(
      {
        clientRef: "synthetic-client-1",
        sourceContractRevision: AUTOGEO_SOURCE_CONTRACT_REVISION,
        idempotencyKey: "archive-attempt-3",
        artifacts: sourceArtifacts,
      },
      key,
    );
    const { port, writes } = memoryPort({ loseFirstWriteAck: true });

    await expect(
      deliverEncryptedAutoGeoSourceArchive(envelope, key, port),
    ).resolves.toMatchObject({
      status: "unconfirmed",
      reason: "write_unconfirmed",
    });
    await expect(
      deliverEncryptedAutoGeoSourceArchive(envelope, key, port),
    ).resolves.toMatchObject({
      status: "confirmed",
      fileId: "synthetic-drive-file-1",
      artifactCount: 2,
    });
    expect(writes).toHaveLength(2);
    expect(writes[1].idempotencyKey).toBe(writes[0].idempotencyKey);
    expect(writes[1].ciphertext).toEqual(writes[0].ciphertext);
    expect(writes[1].iv).toEqual(writes[0].iv);
  });
});

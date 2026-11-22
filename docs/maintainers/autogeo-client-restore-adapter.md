# AutoGeo client-history restore adapter

`prepareAutoGeoClientRestore` converts a synthetic JSONL adapter contract into
a candidate OpenSEO client-restore archive. The local adapter-contract
revision is `f676d4cef76cc2b6b1bf93865f8d480c9df25dfb`, matching the generic
source repository commit used to define the contract. Its generic runner and
artifact-sync code were inspected; no client export or client-specific data
was opened. The contract has not been verified against any actual client
export. No permitted client inventory is available in this worktree, so
mappings and per-client permissions remain unverified.

The adapter accepts caller-supplied bytes and a strict reviewed-mapping object.
It does not open a client workspace, read credentials, write the database, call
the OpenSEO importer, prove authorization, or verify evidence references. Its
`canImport` result is always `false`. No runtime caller is wired to this
function.

The mapping object must include:

- The exact source contract revision, one pseudonymous client reference, and an
  opaque field-map evidence reference.
- Explicit target project and tracker configuration. Imported trackers are
  always disabled, all engine flags are cleared, and imported prompts are
  archived and paused. Credential fields such as IndexNow keys are rejected
  from the mapping and never enter the target archive.
- A mapping for each prompt keyed by `v{matrix-version}:{prompt-id}`.
- A complete run row for each imported answer group. Its trigger, timestamps,
  project, tracker, status, location, and language are supplied explicitly;
  the adapter never infers them from `asked_utc` or the answer file path.
- An answer mapping keyed by `{run-id}:{answer-id}` with an explicit source
  status and provider match, target engine, result status, collection
  timestamp, and the citation indexes confirmed for that client. The target
  requested model is copied from the source `model_id`; it is not inferred or
  independently renamed by the mapping.

The pinned producer writes answers with `answer_id`, `prompt_id`, `provider`,
`locale`, `retrieval_mode`, `model_id`, `asked_utc`, `status`, `attempt`,
`provider_calls`, `cost_usd`, and `cost_source`; `run_id` is supplied by the
`runs/{run-id}/answers.jsonl` path, and prompt intent comes from the matched
matrix row. The adapter allow-lists the producer's optional fields and rejects
unknown fields. It never treats `asked_utc` as a completion timestamp. Under
the `ephemeral` privacy profile, successful answers omit `text` and
`citations` and retain only accounting metadata plus `privacy_match`; those
rows are archived but not mapped to an OpenSEO answer. When present,
`observed_version` and `search_executed` are copied as recorded evidence;
`route` remains `unknown` because the source artifact does not establish the
OpenSEO route contract, and `eligibleForVisibility` remains unset. The source
provider and every source artifact remain in the byte-for-byte
`archiveArtifacts` result. Only explicitly confirmed HTTPS citations become
target source rows. Answers with ambiguous prompt versions, unresolved
relationships, pending outcomes, or active runs remain outside the candidate
restore payload.
Fully mapped prompt-only histories can still produce a restore archive; if any
supported prompt or answer row is unmapped, no target restore archive is emitted,
while the original bytes remain available for the separate encrypted archive.

`archiveArtifacts` contains the original source bytes in memory. Before a real
migration, the caller must pass those bytes to
`prepareEncryptedAutoGeoSourceArchive` with a non-extractable 256-bit AES-GCM
key and a stable idempotency key, then persist the resulting envelope before
delivery. The authenticated data binds the ciphertext to the pseudonymous
client reference, source contract revision, and idempotency key. Retries must
reuse that exact envelope.

`deliverEncryptedAutoGeoSourceArchive` uses an injected port. The port must
resolve a client-scoped private destination, create an object without
overwriting a different envelope for the same idempotency key, and return that
object on read-back. The helper reports confirmation only after the exact
envelope is read back, decrypted, and its file hashes validate. A lost write
acknowledgement remains unconfirmed; the caller can retry the same saved
envelope. Tests use a synthetic in-memory port and do not exercise Drive.

`runAutoGeoSourceMigration` is the fail-closed orchestration entry point. It
requires a trusted authorization verifier, reads artifacts only after approval,
persists the exact encrypted envelope through an atomic outbox port, waits for
Drive read-back, and then uses the existing idempotent target importer. Changed
source bytes under a reused idempotency key are rejected.

The current Story 4.3 source change wires an operator-authenticated
`POST /api/standalone/autogeo-source-migration` route, database-backed approval
and encrypted outbox records, a Google Drive source-archive port, and the existing
idempotent client restore importer. The Drive target is the organization OAuth
connection and folder selected through Picker. The source archive is persisted
before delivery and is imported only after exact Drive read-back.

The route currently accepts at most 8 MiB of request JSON and 4 MiB of decoded
source artifacts. This is a conservative bound for a Worker path that still
materializes the archive plan, ciphertext, and Drive multipart body in memory.
Larger inputs fail closed before Drive delivery and must remain with the source
owner; they are not supported migrations until the full path is streaming and
verified in the deployed runtime.

Two production authorization boundaries remain open. Approval stores opaque
evidence references but does not retrieve or validate the referenced evidence;
`approvedBy` is currently the fixed `standalone-operator` principal. The route
also accepts artifact bytes in its authenticated request instead of reading a
verified client workspace. Consequently, source rights, target write rights,
retention, mapping approval, client inventory, and the source-to-target data
mapping have not been verified against a real client. The source-defined OAuth
readiness probe at
`https://autogeo.flexsentlabs.com/api/google-drive/archive/oauth/callback`
still returns 404, so no OAuth client, consent, Drive write, or migration was
performed. Local tests use synthetic evidence, request artifacts, and Drive
responses; they validate fail-closed ordering, encryption, retry/idempotency,
and tenant binding only. They do not establish production readiness or a
verified restore.

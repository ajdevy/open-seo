import { z } from "zod";

/** Exact source repository revision whose documented JSONL contract this adapter accepts. */
export const AUTOGEO_SOURCE_CONTRACT_REVISION =
  "f676d4cef76cc2b6b1bf93865f8d480c9df25dfb";

const promptFields = [
  "id",
  "locale",
  "intent_category",
  "pair_id",
  "entities",
  "translation_of",
  "text",
] as const;
const answerRequiredFields = [
  "answer_id",
  "run_id",
  "prompt_id",
  "intent_category",
  "locale",
  "provider",
  "model_id",
  "model_snapshot_date",
  "requested_at",
  "status",
  "answer_text",
  "citations",
  "error",
] as const;
const nonblank = z.string().refine((value) => value.trim().length > 0);

const promptRowSchema = z
  .object({
    id: nonblank,
    locale: nonblank,
    intent_category: nonblank,
    pair_id: nonblank.nullable(),
    entities: z.array(nonblank),
    translation_of: nonblank.nullable(),
    text: nonblank,
  })
  .strict();

const answerRowSchema = z
  .object({
    answer_id: nonblank,
    run_id: nonblank,
    prompt_id: nonblank,
    intent_category: nonblank,
    locale: nonblank,
    provider: nonblank,
    model_id: nonblank,
    model_snapshot_date: z.string().date(),
    requested_at: z.string().datetime(),
    status: z.enum(["ok", "error"]),
    answer_text: z.string().nullable(),
    citations: z.array(z.unknown()),
    error: z.string().nullable(),
  })
  .strict();

export type PromptSourceRow = z.infer<typeof promptRowSchema>;
export type AnswerSourceRow = z.infer<typeof answerRowSchema>;
export type PromptRef = { version: number; row: PromptSourceRow };
export type SourceRun = { runId: string; rows: AnswerSourceRow[] };
export type SourceRows = { prompts: PromptRef[]; runs: SourceRun[] };

export type ClassifiedSourceFile =
  | { path: string; kind: "invalid" | "private" | "archive-only" | "opaque" }
  | { path: string; kind: "prompt"; version: number }
  | { path: string; kind: "answers"; runId: string };

const matrixPath = /^prompts\/matrix-v([1-9][0-9]*)\.jsonl$/;
const answerPath = /^runs\/([A-Za-z0-9_.:-]{1,160})\/answers\.jsonl$/;
const knownPath =
  /^(?:prompts\/(?:demo-set-v[1-9][0-9]*\.jsonl)|runs\/[A-Za-z0-9_.:-]{1,160}\/(?:matches|claims)\.jsonl|runs\/[A-Za-z0-9_.:-]{1,160}\/run\.md|facts\/(?:sources|facts|contradictions)\.jsonl)$/;
const windowsDrivePath = /^[A-Za-z]:/;

export function classifyAutoGeoSourcePaths(
  paths: string[],
): ClassifiedSourceFile[] {
  const classified = paths.map((path): ClassifiedSourceFile => {
    if (
      !path ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.startsWith("/") ||
      windowsDrivePath.test(path) ||
      path
        .split("/")
        .some((part) => part === "" || part === "." || part === "..")
    )
      return { path, kind: "invalid" };
    if (path.split("/").includes("private")) return { path, kind: "private" };
    const matrix = matrixPath.exec(path);
    if (matrix) return { path, kind: "prompt", version: Number(matrix[1]) };
    const answers = answerPath.exec(path);
    if (answers) return { path, kind: "answers", runId: answers[1] };
    return { path, kind: knownPath.test(path) ? "archive-only" : "opaque" };
  });
  if (classified.some((entry) => entry.kind === "private"))
    throw new Error("private source path is excluded");
  if (classified.some((entry) => entry.kind === "invalid"))
    throw new Error("invalid source artifact path");
  return classified;
}

function parseJsonWithoutDuplicateKeys(line: string): unknown {
  let offset = 0;
  const skipWhitespace = () => {
    while (/\s/.test(line[offset] ?? "")) offset++;
  };
  const parseString = (): string => {
    const start = offset;
    if (line[offset] !== '"') throw new Error("invalid_json");
    offset++;
    while (offset < line.length) {
      const character = line[offset++];
      if (character === '"') {
        const parsed: unknown = JSON.parse(line.slice(start, offset));
        if (typeof parsed !== "string") throw new Error("invalid_json");
        return parsed;
      }
      if (character === "\\") {
        const escape = line[offset++];
        if (escape === "u") offset += 4;
      }
    }
    throw new Error("invalid_json");
  };
  const parseValue = (): void => {
    skipWhitespace();
    if (line[offset] === '"') {
      parseString();
      return;
    }
    if (line[offset] === "{") {
      offset++;
      skipWhitespace();
      const keys = new Set<string>();
      if (line[offset] === "}") {
        offset++;
        return;
      }
      while (offset < line.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) throw new Error("duplicate_json_key");
        keys.add(key);
        skipWhitespace();
        if (line[offset++] !== ":") throw new Error("invalid_json");
        parseValue();
        skipWhitespace();
        const delimiter = line[offset++];
        if (delimiter === "}") return;
        if (delimiter !== ",") throw new Error("invalid_json");
      }
      throw new Error("invalid_json");
    }
    if (line[offset] === "[") {
      offset++;
      skipWhitespace();
      if (line[offset] === "]") {
        offset++;
        return;
      }
      while (offset < line.length) {
        parseValue();
        skipWhitespace();
        const delimiter = line[offset++];
        if (delimiter === "]") return;
        if (delimiter !== ",") throw new Error("invalid_json");
      }
      throw new Error("invalid_json");
    }
    const primitive =
      /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
        line.slice(offset),
      );
    if (!primitive) throw new Error("invalid_json");
    offset += primitive[0].length;
  };

  parseValue();
  skipWhitespace();
  if (offset !== line.length) throw new Error("invalid_json");
  return JSON.parse(line) as unknown;
}

function parseJsonl<T>(
  bytes: Uint8Array,
  requiredFields: readonly string[],
  allowedFields: readonly string[],
  schema: z.ZodType<T>,
): T[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("invalid_source_contract");
  }
  if (text.includes("\r") || (text.length > 0 && !text.endsWith("\n")))
    throw new Error("invalid_source_contract");
  if (text.length === 0) return [];
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0))
    throw new Error("invalid_source_contract");
  const rows: T[] = [];
  try {
    for (const line of lines) {
      const raw = parseJsonWithoutDuplicateKeys(line);
      if (
        raw === null ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        requiredFields.some((field) => !Object.hasOwn(raw, field)) ||
        Object.keys(raw).some((field) => !allowedFields.includes(field))
      )
        throw new Error("invalid_source_contract");
      rows.push(schema.parse(raw));
    }
  } catch {
    throw new Error("invalid_source_contract");
  }
  return rows;
}

export function parseAutoGeoSourceRows(
  artifacts: Record<string, Uint8Array>,
  classified: ClassifiedSourceFile[],
): SourceRows {
  const prompts: PromptRef[] = [];
  const runs: SourceRun[] = [];
  const seenMatrixPaths = new Set<number>();
  const seenRunPaths = new Set<string>();
  for (const file of classified) {
    if (file.kind === "prompt") {
      if (seenMatrixPaths.has(file.version))
        throw new Error("invalid_source_contract");
      seenMatrixPaths.add(file.version);
      const rows = parseJsonl(
        artifacts[file.path],
        promptFields,
        promptFields,
        promptRowSchema,
      );
      const ids = new Set<string>();
      for (const row of rows) {
        if (ids.has(row.id)) throw new Error("invalid_source_contract");
        ids.add(row.id);
        prompts.push({ version: file.version, row });
      }
    } else if (file.kind === "answers") {
      if (seenRunPaths.has(file.runId))
        throw new Error("invalid_source_contract");
      seenRunPaths.add(file.runId);
      const rows = parseJsonl(
        artifacts[file.path],
        answerRequiredFields,
        answerRequiredFields,
        answerRowSchema,
      );
      const ids = new Set<string>();
      for (const row of rows) {
        if (row.run_id !== file.runId || ids.has(row.answer_id))
          throw new Error("invalid_source_contract");
        ids.add(row.answer_id);
      }
      runs.push({ runId: file.runId, rows });
    }
  }
  return { prompts, runs };
}

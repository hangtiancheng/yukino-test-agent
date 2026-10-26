/**
 * Settings service: multiple LLM profiles (text / vision) + env migration +
 * connectivity tests.
 *
 * - Profiles live in `llm_profiles`; each kind may have several rows and one
 *   default (isDefault).
 * - On first read, single-set env configuration is migrated into default
 *   profiles; env remains the fallback when no DB profile exists.
 * - The API only ever returns masked keys; sending the mask back on update
 *   keeps the stored key.
 */
import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";

import { db } from "#/db";
import { llmProfiles } from "#/db/schema";
import { serverEnv } from "#/server/env";
import { LlmClient, LlmUnavailableError } from "#/server/lib/llm";

import type { LlmKind, LlmProfileDict } from "#/lib/types";

type LlmProfileRow = typeof llmProfiles.$inferSelect;

export class BizError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = "BizError";
  }
}

const KINDS: LlmKind[] = ["text", "vision"];

// 1x1 PNG: the vision connectivity test must actually send an image, so a
// text-only ping cannot fake success on a model that rejects images.
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n7sAAAAASUVORK5CYII=";

function uuid(): string {
  return randomUUID().replace(/-/g, "");
}

export function maskKey(key: string | null | undefined): string {
  if (!key) return "";
  if (key.length <= 8) return `${key.slice(0, 4)}***`;
  return `${key.slice(0, 4)}***${key.slice(-4)}`;
}

function isMasked(value: string | null | undefined): boolean {
  return Boolean(value && value.includes("***"));
}

function profileToDict(row: LlmProfileRow): LlmProfileDict {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as LlmKind,
    apiKey: maskKey(row.apiKey),
    apiKeyConfigured: Boolean(row.apiKey),
    baseUrl: row.baseUrl || "",
    model: row.model || "",
    enabled: row.enabled,
    isDefault: row.isDefault,
    createdAt: row.createdAt?.toISOString() ?? null,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

/** Migrate env configuration into default profiles when the table is empty. */
export async function ensureSeedProfiles(): Promise<LlmProfileRow[]> {
  const rows = await db
    .select()
    .from(llmProfiles)
    .orderBy(asc(llmProfiles.createdAt));
  const kinds = new Set(rows.map((row) => row.kind));
  const created: LlmProfileRow[] = [];

  if (!kinds.has("text") && (serverEnv.llm.apiKey || serverEnv.llm.model)) {
    const row = {
      id: uuid(),
      name: "Default Text LLM",
      kind: "text",
      apiKey: serverEnv.llm.apiKey,
      baseUrl: serverEnv.llm.baseUrl,
      model: serverEnv.llm.model,
      enabled: true,
      isDefault: true,
    };
    await db.insert(llmProfiles).values(row);
    created.push(
      (
        await db.select().from(llmProfiles).where(eq(llmProfiles.id, row.id))
      )[0],
    );
  }
  if (
    !kinds.has("vision") &&
    (serverEnv.llmVision.apiKey || serverEnv.llmVision.model)
  ) {
    const row = {
      id: uuid(),
      name: "Default Vision LLM",
      kind: "vision",
      apiKey: serverEnv.llmVision.apiKey,
      baseUrl: serverEnv.llmVision.baseUrl,
      model: serverEnv.llmVision.model,
      enabled: true,
      isDefault: true,
    };
    await db.insert(llmProfiles).values(row);
    created.push(
      (
        await db.select().from(llmProfiles).where(eq(llmProfiles.id, row.id))
      )[0],
    );
  }

  const all = [...rows, ...created];
  for (const kind of KINDS) {
    const kindRows = all.filter((row) => row.kind === kind);
    if (kindRows.length > 0 && !kindRows.some((row) => row.isDefault)) {
      await db
        .update(llmProfiles)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(llmProfiles.id, kindRows[0].id));
      kindRows[0].isDefault = true;
    }
  }
  return all;
}

function defaultProfile(
  rows: LlmProfileRow[],
  kind: LlmKind,
): LlmProfileRow | null {
  const candidates = rows.filter((row) => row.kind === kind && row.enabled);
  if (candidates.length === 0) return null;
  return candidates.find((row) => row.isDefault) ?? candidates[0];
}

export async function listProfiles(): Promise<LlmProfileDict[]> {
  const rows = await ensureSeedProfiles();
  const order: Record<string, number> = { text: 0, vision: 1 };
  const sorted = [...rows].sort(
    (a, b) =>
      (order[a.kind] ?? 9) - (order[b.kind] ?? 9) ||
      Number(b.isDefault) - Number(a.isDefault) ||
      (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0),
  );
  return sorted.map(profileToDict);
}

export interface SettingsInfo {
  profiles: LlmProfileDict[];
  textConfigured: boolean;
  visionConfigured: boolean;
  visionUsesTextFallback: boolean;
  env: {
    llmApiKey: string;
    llmApiKeyConfigured: boolean;
    llmBaseUrl: string;
    llmModel: string;
    llmVisionApiKey: string;
    llmVisionBaseUrl: string;
    llmVisionModel: string;
  };
  targetUrlDefault: string;
  outputDir: string;
}

export async function getSettingsInfo(): Promise<SettingsInfo> {
  const profiles = await listProfiles();
  const textDefault = profiles.find((p) => p.kind === "text" && p.isDefault);
  const visionDefault = profiles.find(
    (p) => p.kind === "vision" && p.isDefault,
  );
  return {
    profiles,
    textConfigured: Boolean(textDefault?.apiKeyConfigured && textDefault.model),
    visionConfigured: Boolean(
      (visionDefault?.model || textDefault?.model || "").trim() &&
      (visionDefault?.apiKeyConfigured || textDefault?.apiKeyConfigured),
    ),
    visionUsesTextFallback: !visionDefault?.apiKeyConfigured,
    env: {
      llmApiKey: maskKey(serverEnv.llm.apiKey),
      llmApiKeyConfigured: Boolean(serverEnv.llm.apiKey),
      llmBaseUrl: serverEnv.llm.baseUrl,
      llmModel: serverEnv.llm.model,
      llmVisionApiKey: maskKey(serverEnv.llmVision.apiKey),
      llmVisionBaseUrl: serverEnv.llmVision.baseUrl,
      llmVisionModel: serverEnv.llmVision.model,
    },
    targetUrlDefault: serverEnv.targetUrlDefault,
    outputDir: serverEnv.outputDir,
  };
}

export interface ProfileUpsertInput {
  name?: string;
  kind?: LlmKind;
  apiKey?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  enabled?: boolean;
  isDefault?: boolean;
}

export async function createProfile(
  input: ProfileUpsertInput,
): Promise<LlmProfileDict> {
  const name = (input.name || "").trim();
  if (!name) throw new BizError(40030, "Profile name is required");
  const model = (input.model || "").trim();
  if (!model) throw new BizError(40032, "Model name is required");
  const kind = input.kind === "vision" ? "vision" : "text";
  const id = uuid();
  const isFirstOfKind =
    (
      await db
        .select({ id: llmProfiles.id })
        .from(llmProfiles)
        .where(eq(llmProfiles.kind, kind))
    ).length === 0;
  await db.insert(llmProfiles).values({
    id,
    name: name.slice(0, 120),
    kind,
    apiKey: input.apiKey || "",
    baseUrl: (input.baseUrl || "").trim(),
    model,
    enabled: input.enabled ?? true,
    isDefault: input.isDefault ?? isFirstOfKind,
  });
  if (input.isDefault || isFirstOfKind) {
    await clearOtherDefaults(kind, id);
  }
  return profileToDict(await getProfileRow(id));
}

async function getProfileRow(id: string): Promise<LlmProfileRow> {
  const rows = await db
    .select()
    .from(llmProfiles)
    .where(eq(llmProfiles.id, id));
  const row = rows[0];
  if (!row) throw new BizError(40404, `LLM profile not found: ${id}`);
  return row;
}

async function clearOtherDefaults(kind: string, keepId: string): Promise<void> {
  const rows = await db
    .select()
    .from(llmProfiles)
    .where(and(eq(llmProfiles.kind, kind), eq(llmProfiles.isDefault, true)));
  for (const row of rows) {
    if (row.id !== keepId) {
      await db
        .update(llmProfiles)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(llmProfiles.id, row.id));
    }
  }
}

export async function updateProfile(
  id: string,
  input: ProfileUpsertInput,
): Promise<LlmProfileDict> {
  const row = await getProfileRow(id);
  const patch: Partial<LlmProfileRow> = { updatedAt: new Date() };
  if (input.name !== undefined) {
    if (!input.name.trim()) {
      throw new BizError(40030, "Profile name is required");
    }
    patch.name = input.name.trim().slice(0, 120);
  }
  if (input.baseUrl !== undefined) patch.baseUrl = (input.baseUrl || "").trim();
  if (input.model !== undefined) {
    const model = (input.model || "").trim();
    if (!model) {
      throw new BizError(40032, "Model name is required");
    }
    patch.model = model;
  }
  if (input.apiKey !== undefined && input.apiKey !== null) {
    // A masked value means "keep the stored key".
    if (!isMasked(input.apiKey)) patch.apiKey = input.apiKey;
  }
  if (input.enabled !== undefined) {
    patch.enabled = input.enabled;
    if (!input.enabled && row.isDefault) {
      // Promote another enabled profile of the same kind to default.
      const fallback = (
        await db
          .select()
          .from(llmProfiles)
          .where(
            and(eq(llmProfiles.kind, row.kind), eq(llmProfiles.enabled, true)),
          )
      ).find((item) => item.id !== id);
      if (fallback) patch.isDefault = false;
      if (fallback) {
        await db
          .update(llmProfiles)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(eq(llmProfiles.id, fallback.id));
      }
    }
  }
  if (input.isDefault) {
    patch.isDefault = true;
    patch.enabled = true;
    await clearOtherDefaults(row.kind, id);
  }
  await db.update(llmProfiles).set(patch).where(eq(llmProfiles.id, id));
  return profileToDict(await getProfileRow(id));
}

export async function setDefaultProfile(id: string): Promise<LlmProfileDict> {
  const row = await getProfileRow(id);
  await clearOtherDefaults(row.kind, id);
  await db
    .update(llmProfiles)
    .set({ isDefault: true, enabled: true, updatedAt: new Date() })
    .where(eq(llmProfiles.id, id));
  return profileToDict(await getProfileRow(id));
}

export async function deleteProfile(id: string): Promise<void> {
  const row = await getProfileRow(id);
  const sameKind = await db
    .select()
    .from(llmProfiles)
    .where(eq(llmProfiles.kind, row.kind));
  if (sameKind.length <= 1) {
    throw new BizError(
      40032,
      "Keep at least one profile per kind; disable it instead of deleting.",
    );
  }
  await db.delete(llmProfiles).where(eq(llmProfiles.id, id));
  if (row.isDefault) {
    const fallback = sameKind.find((item) => item.id !== id);
    if (fallback) {
      await db
        .update(llmProfiles)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(llmProfiles.id, fallback.id));
    }
  }
}

function clientFromRow(row: LlmProfileRow): LlmClient {
  return new LlmClient(
    row.apiKey || "",
    row.baseUrl || "",
    row.model || "",
    serverEnv.llmExtraBody,
  );
}

function envTextClient(): LlmClient {
  return new LlmClient(
    serverEnv.llm.apiKey,
    serverEnv.llm.baseUrl,
    serverEnv.llm.model,
    serverEnv.llmExtraBody,
  );
}

function envVisionClient(): LlmClient {
  return new LlmClient(
    serverEnv.llmVision.apiKey || serverEnv.llm.apiKey,
    serverEnv.llmVision.baseUrl || serverEnv.llm.baseUrl,
    serverEnv.llmVision.model || serverEnv.llm.model,
    serverEnv.llmExtraBody,
  );
}

/** Text client by profile id; falls back to the default profile, then env. */
export async function getTextClient(
  profileId?: string | null,
): Promise<LlmClient> {
  try {
    const rows = await ensureSeedProfiles();
    if (profileId) {
      const row = rows.find((item) => item.id === profileId);
      if (!row || row.kind !== "text") {
        throw new BizError(
          40033,
          `Text LLM profile not found or kind mismatch: ${profileId}`,
        );
      }
      if (!row.enabled) {
        throw new BizError(40033, `Text LLM profile is disabled: ${row.name}`);
      }
      return clientFromRow(row);
    }
    const fallback = defaultProfile(rows, "text");
    if (fallback) return clientFromRow(fallback);
  } catch (error) {
    if (error instanceof BizError) throw error;
    // Table missing / DB unavailable: fall back to env.
  }
  return envTextClient();
}

/** Vision client; falls back to the default text profile, then env vision/text. */
export async function getVisionClient(): Promise<LlmClient> {
  try {
    const rows = await ensureSeedProfiles();
    const vision = defaultProfile(rows, "vision");
    if (vision && (vision.model || "").trim() && vision.apiKey) {
      return clientFromRow(vision);
    }
    const text = defaultProfile(rows, "text");
    if (text) return clientFromRow(text);
  } catch {
    // fall back to env
  }
  return envVisionClient();
}

export async function testLlm(
  profileId?: string | null,
  kind: LlmKind = "text",
): Promise<{ ok: true; model: string }> {
  let client: LlmClient;
  let model: string;
  if (profileId) {
    const row = await getProfileRow(profileId);
    if (row.kind !== kind) {
      throw new BizError(40033, "LLM profile kind mismatch");
    }
    client = clientFromRow(row);
    model = row.model || "";
  } else {
    client =
      kind === "vision" ? await getVisionClient() : await getTextClient();
    model = client.model;
  }
  if (!client.available()) {
    throw new BizError(40030, "No LLM API key configured; fill one in first");
  }
  try {
    // Do not require JSON here: reasoning models may spend all tokens on
    // hidden reasoning. A vision profile must really send an image, otherwise
    // a text-only ping would report "vision works" for a model that cannot
    // accept images at all.
    const text =
      kind === "vision"
        ? await client.chatText(
            [
              {
                role: "user",
                content: [
                  { type: "text", text: "Reply with exactly: ok" },
                  {
                    type: "image_url",
                    image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` },
                  },
                ],
              },
            ],
            256,
          )
        : await client.chatText(
            [{ role: "user", content: "Reply with exactly: ok" }],
            256,
          );
    if (!text.trim())
      throw new LlmUnavailableError("Model returned empty content");
    return { ok: true, model };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BizError(40031, `LLM connectivity failed: ${message}`);
  }
}

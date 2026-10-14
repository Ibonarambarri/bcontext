/**
 * Recall.ai provider implementation of `MeetingBotProvider`.
 *
 * Recall.ai is the v1 vendor for the meeting-bot connector. The wire format
 * targeted here is Recall's REST API (v1):
 *
 *   POST /api/v1/bot/                  — schedule a bot
 *   GET  /api/v1/bot/{id}/              — bot status + metadata
 *   POST /api/v1/bot/{id}/leave_call/   — cancel / pull the bot out
 *   GET  /api/v1/bot/{id}/transcript/   — diarized transcript
 *   Webhook header: `recall-signature: t=<ts>,v1=<hex>` (HMAC-SHA256
 *                   over `<ts>.<raw_body>` keyed by the webhook secret).
 *
 * Auth is a single API key set via RECALL_API_KEY. Region-specific base
 * URLs (us-east, eu-central) are selected via RECALL_API_BASE. Defaults
 * to the global endpoint.
 *
 * Consent disclosure: Recall handles the in-call announcement; we set
 * `bot_name` and rely on the workspace-default disclosure copy. The
 * record-meeting modal surfaces a checkbox so the requester acknowledges
 * recording before the bot is dispatched.
 */
import { ConnectorSignatureError } from "@bcontext-dev/contract/connectors/types";
import type { WebhookEnvelope } from "@bcontext-dev/contract/connectors/types";
import type {
  MeetingBotEvent,
  MeetingBotProvider,
  MeetingBotStatus,
  MeetingState,
  ScheduleBotInput,
  ScheduleBotResult,
  TranscriptSegment,
} from "@bcontext-dev/contract/connectors/meeting-bot/provider";

const DEFAULT_BASE = "https://api.recall.ai";
const DEFAULT_BOT_NAME = "Bcontext recorder";

function apiBase(): string {
  return process.env.RECALL_API_BASE?.replace(/\/+$/, "") ?? DEFAULT_BASE;
}

function apiKey(): string {
  const key = process.env.RECALL_API_KEY;
  if (!key) {
    throw new Error(
      "RECALL_API_KEY missing — set it to wire the meeting-bot connector",
    );
  }
  return key;
}

function webhookSecret(): string {
  // Recall lets you set a webhook secret per project. We require it
  // explicitly so signature verification never silently degrades.
  const secret = process.env.RECALL_WEBHOOK_SECRET;
  if (!secret) {
    throw new ConnectorSignatureError("RECALL_WEBHOOK_SECRET missing");
  }
  return secret;
}

interface RecallMediaShortcut {
  id?: string;
  status?: { code?: string };
  data?: { download_url?: string | null };
}

interface RecallBot {
  id: string;
  bot_id?: string;
  status_changes?: Array<{ code: string; created_at: string; sub_code?: string | null; message?: string | null }>;
  status?: { code?: string };
  meeting_url?: { meeting_id?: string; platform?: string } | string;
  join_at?: string | null;
  meeting_metadata?: { title?: string | null };
  recording?: { id?: string; recording_url?: string | null } | null;
  recordings?: Array<{
    id: string;
    status?: { code?: string };
    media_shortcuts?: {
      video_mixed?: RecallMediaShortcut;
      audio_mixed?: RecallMediaShortcut;
      transcript?: RecallMediaShortcut;
    };
  }>;
  participants?: Array<{ name?: string | null }>;
  duration?: number | null;
}

interface RecallTranscriptResponse {
  /** Legacy /transcript/ endpoint shape (deprecated, returns a message string now). */
  monologues?: Array<{
    speaker: { name?: string | null; id?: number } | null;
    words: Array<{ text: string; start_timestamp?: { relative?: number } | null; end_timestamp?: { relative?: number } | null }>;
  }>;
  /** Some accounts ship a top-level `data` list with simple speaker strings. */
  data?: Array<{ speaker: string; words: Array<{ text: string; start_time?: number; end_time?: number }> }>;
}

/**
 * New Recall API shape — what you get when you download the JSON from
 * `recordings[].media_shortcuts.transcript.data.download_url`.
 *
 * Each entry is one diarized turn. The diarization is processed
 * (consecutive words by the same speaker are grouped) so each entry is
 * already a speaker block.
 */
type RecallTranscriptDownloadEntry = {
  participant: {
    id: number;
    name?: string | null;
    is_host?: boolean;
  } | null;
  words: Array<{
    text: string;
    start_timestamp?: { relative?: number; absolute?: string } | null;
    end_timestamp?: { relative?: number; absolute?: string } | null;
  }>;
};

/**
 * Whitelist of Recall per-status event codes we care about. Other `bot.*`
 * events (breakout rooms, permission_allowed/denied sub-events) are
 * ignored — they're either redundant with the timeline we already track
 * or out of scope for v1.
 */
const KNOWN_BOT_EVENTS = new Set<string>([
  "ready",
  "joining_call",
  "in_waiting_room",
  "in_call_not_recording",
  "in_call_recording",
  "recording_permission_allowed",
  "recording_permission_denied",
  "call_ended",
  "recording_done",
  "processing",
  "transcribing",
  "post_processing",
  "done",
  "fatal",
  "media_expired",
  "cancelled",
]);

function statusFromRecall(code: string | undefined): MeetingBotStatus {
  switch (code) {
    case "ready":
    case "joining_call":
    case "in_waiting_room":
      return "joining";
    case "in_call_not_recording":
    case "in_call_recording":
    case "recording_permission_allowed":
      return "in_call";
    case "call_ended":
    case "recording_done":
      return "call_ended";
    case "processing":
    case "transcribing":
    case "post_processing":
      return "transcribing";
    case "done":
      return "done";
    case "fatal":
    case "media_expired":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "scheduled";
  }
}

async function recallFetch<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Token ${apiKey()}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  const body = init?.json !== undefined ? JSON.stringify(init.json) : init?.body;
  const res = await fetch(`${apiBase()}${path}`, {
    method: init?.method ?? (init?.json ? "POST" : "GET"),
    headers,
    body,
    // Surface failures fast rather than letting a bot schedule hang the route.
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`recall ${res.status} ${path}: ${text.slice(0, 280)}`);
  }
  return (await res.json()) as T;
}

function toState(bot: RecallBot): MeetingState {
  const latestStatus = bot.status_changes?.length
    ? bot.status_changes[bot.status_changes.length - 1]
    : null;
  const code = latestStatus?.code ?? bot.status?.code;
  const meetingUrl =
    typeof bot.meeting_url === "string"
      ? bot.meeting_url
      : (bot.meeting_url?.meeting_id ?? "");
  const joinedAt = bot.status_changes?.find((s) => s.code === "in_call_recording" || s.code === "in_call_not_recording")?.created_at ?? null;
  const endedAt = bot.status_changes?.find((s) => s.code === "call_ended")?.created_at ?? null;
  const recordingUrl =
    bot.recordings?.[0]?.media_shortcuts?.video_mixed?.data?.download_url ??
    bot.recording?.recording_url ??
    null;
  const participants = (bot.participants ?? [])
    .map((p) => (p?.name ?? "").trim())
    .filter((s) => s.length > 0);
  return {
    externalId: bot.id ?? bot.bot_id ?? "",
    status: statusFromRecall(code),
    meetingUrl,
    topic: bot.meeting_metadata?.title ?? null,
    botJoinedAt: joinedAt,
    callEndedAt: endedAt,
    durationSec: typeof bot.duration === "number" ? bot.duration : null,
    participants,
    recordingUrl,
    transcript: null,
    errorMessage: latestStatus?.message ?? null,
  };
}

async function fetchTranscriptForBot(
  bot: RecallBot,
  externalId: string,
): Promise<TranscriptSegment[]> {
  // Preferred: modern Recall ships a signed S3 URL on the recording's
  // transcript media shortcut. The file is a diarized JSON list.
  const url = bot.recordings?.[0]?.media_shortcuts?.transcript?.data?.download_url;
  if (url) {
    try {
      const res = await fetch(url, {
        // S3 signed URL — no auth header. Apply a generous timeout in case
        // the transcript is large (long meetings).
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        throw new Error(`transcript download ${res.status}`);
      }
      const body = (await res.json()) as RecallTranscriptDownloadEntry[];
      return transcriptFromDiarizedDownload(body);
    } catch {
      // Fall through to the legacy endpoint.
    }
  }

  // Legacy /api/v1/bot/{id}/transcript/ endpoint — still returns useful
  // data on some accounts; returns a deprecation message on newer ones.
  try {
    const body = await recallFetch<RecallTranscriptResponse>(
      `/api/v1/bot/${externalId}/transcript/`,
    );
    return transcriptFromResponse(body);
  } catch {
    return [];
  }
}

function transcriptFromDiarizedDownload(
  entries: RecallTranscriptDownloadEntry[],
): TranscriptSegment[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      const text = (entry.words ?? [])
        .map((w) => w.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return null;
      const startSec = entry.words?.[0]?.start_timestamp?.relative ?? 0;
      const endSec =
        entry.words?.[entry.words.length - 1]?.end_timestamp?.relative ??
        startSec;
      const speakerName = entry.participant?.name?.trim();
      const speaker = speakerName && speakerName.length > 0
        ? speakerName
        : typeof entry.participant?.id === "number"
          ? `Speaker ${entry.participant.id}`
          : "Unknown";
      return { speaker, text, startSec, endSec } satisfies TranscriptSegment;
    })
    .filter((seg): seg is TranscriptSegment => seg !== null);
}

function transcriptFromResponse(body: RecallTranscriptResponse): TranscriptSegment[] {
  if (Array.isArray(body.monologues) && body.monologues.length > 0) {
    return body.monologues
      .map((m) => {
        const speaker = m.speaker?.name?.trim() ||
          (typeof m.speaker?.id === "number" ? `Speaker ${m.speaker.id}` : "Unknown");
        const text = m.words.map((w) => w.text).join(" ").trim();
        const startSec = m.words[0]?.start_timestamp?.relative ?? 0;
        const endSec = m.words[m.words.length - 1]?.end_timestamp?.relative ?? startSec;
        return { speaker, text, startSec, endSec };
      })
      .filter((s) => s.text.length > 0);
  }
  if (Array.isArray(body.data) && body.data.length > 0) {
    return body.data
      .map((d) => {
        const text = d.words.map((w) => w.text).join(" ").trim();
        const startSec = d.words[0]?.start_time ?? 0;
        const endSec = d.words[d.words.length - 1]?.end_time ?? startSec;
        return { speaker: d.speaker, text, startSec, endSec };
      })
      .filter((s) => s.text.length > 0);
  }
  return [];
}

export const recallProvider: MeetingBotProvider = {
  id: "recall",

  async scheduleBot(input: ScheduleBotInput): Promise<ScheduleBotResult> {
    // Recall's transcript provider is configurable via RECALL_TRANSCRIPT_PROVIDER.
    // Default `recallai_streaming` uses Recall's own engine — no BYOK, works on
    // Meet / Zoom / Teams / Webex, doesn't depend on platform captions being
    // enabled. Override with `meeting_captions` (free but fragile),
    // `deepgram_streaming`, `assembly_ai_streaming`, etc. Full list per the
    // Recall API: assembly_ai_async_chunked, assembly_ai_streaming,
    // assembly_ai_v3_streaming, aws_transcribe_streaming, deepgram_streaming,
    // elevenlabs_streaming, gladia_v1_streaming, gladia_v2_streaming,
    // meeting_captions, recallai_streaming, rev_streaming, speechmatics_streaming,
    // symbl_streaming, zoom_rtms.
    const providerName = process.env.RECALL_TRANSCRIPT_PROVIDER ?? "recallai_streaming";
    const payload: Record<string, unknown> = {
      meeting_url: input.meetingUrl,
      bot_name: input.botName ?? DEFAULT_BOT_NAME,
      recording_config: {
        transcript: {
          provider: { [providerName]: {} },
        },
      },
      // Tag with workspaceId so the webhook can pivot back without us
      // looking up the row by external_id alone.
      metadata: { workspace_id: input.workspaceId },
    };
    if (input.joinAt) payload.join_at = input.joinAt;
    const res = await recallFetch<RecallBot>("/api/v1/bot/", {
      method: "POST",
      json: payload,
    });
    return {
      externalId: res.id ?? res.bot_id ?? "",
      status: statusFromRecall(res.status?.code),
      scheduledJoinAt: res.join_at ?? null,
    };
  },

  async getMeeting(externalId: string): Promise<MeetingState> {
    const bot = await recallFetch<RecallBot>(`/api/v1/bot/${externalId}/`);
    const state = toState(bot);
    if (state.status === "done") {
      state.transcript = await fetchTranscriptForBot(bot, externalId);
    }
    return state;
  },

  async cancelBot(externalId: string): Promise<void> {
    await recallFetch<unknown>(`/api/v1/bot/${externalId}/leave_call/`, {
      method: "POST",
      json: {},
    });
  },

  async verifyWebhook(envelope: WebhookEnvelope): Promise<MeetingBotEvent> {
    const secret = webhookSecret();
    const ok = await verifyRecallSignature(secret, envelope);
    if (!ok) throw new ConnectorSignatureError();

    const parsed = JSON.parse(envelope.rawBody) as {
      event?: string;
      type?: string;
      data?: {
        bot_id?: string;
        bot?: { id?: string };
        id?: string;
        status?: { code?: string };
        sub_code?: string;
      };
    };
    // Recall via Svix uses `type`; legacy payloads used `event`. Accept both.
    const event = (parsed.type ?? parsed.event ?? "").toLowerCase();
    // bot_id can be flat (legacy), nested under `bot`, or just `id` depending
    // on the Recall event variant. Pick the first non-empty.
    const externalId =
      parsed.data?.bot_id ?? parsed.data?.bot?.id ?? parsed.data?.id ?? "";

    // Recall ships two envelope shapes:
    //   • Legacy: `bot.status_change` with `data.status.code` carrying the
    //     transition (one event type, many codes).
    //   • Current: per-status events — `bot.in_call_recording`,
    //     `bot.call_ended`, `bot.done`, `bot.fatal`, … The status code is
    //     encoded in the event name itself, no `data.status.code` field.
    // Handle both so we don't break when accounts get upgraded.
    if (event === "bot.status_change") {
      return {
        kind: "status_change",
        externalId,
        status: statusFromRecall(parsed.data?.status?.code),
        raw: parsed as Record<string, unknown>,
      };
    }
    if (event.startsWith("bot.")) {
      const code = event.slice("bot.".length);
      const status = statusFromRecall(code);
      // Bail on unrelated bot.* events (breakout-room, permission_allowed
      // which is a sub-event of in_call_recording) by checking if the
      // mapper returned the catch-all `scheduled`.
      if (!KNOWN_BOT_EVENTS.has(code)) {
        return { kind: "ignored", externalId, raw: parsed as Record<string, unknown> };
      }
      return {
        kind: "status_change",
        externalId,
        status,
        raw: parsed as Record<string, unknown>,
      };
    }
    if (event === "transcript.done" || event === "transcript.ready") {
      return {
        kind: "transcript_ready",
        externalId,
        status: "done",
        raw: parsed as Record<string, unknown>,
      };
    }
    return { kind: "ignored", externalId, raw: parsed as Record<string, unknown> };
  },
};

// -- Signature verification (Svix scheme — used by Recall.ai) --------------
//
// Recall delivers webhooks via Svix. Headers + payload follow the Svix
// spec (https://docs.svix.com/receiving/verifying-payloads/how-manual):
//
//   svix-id:         unique message id (used in signed content)
//   svix-timestamp:  seconds since epoch
//   svix-signature:  space-separated list of `v1,<base64>` entries
//                     (multiple entries during key rotation; any match wins)
//
// Signed content: `<svix-id>.<svix-timestamp>.<raw-body>`
// HMAC-SHA256 key: the `whsec_<base64>` secret, base64-decoded after
// stripping the `whsec_` prefix. Output compared as base64.
//
// Legacy `recall-signature` header (old custom format) is still accepted
// when present as a fallback; new Recall accounts only ship the svix-*
// headers.

const REPLAY_WINDOW_SEC = 60 * 5;

export async function verifyRecallSignature(
  secret: string,
  envelope: WebhookEnvelope,
): Promise<boolean> {
  if (await verifySvixSignature(secret, envelope)) return true;
  return verifyLegacyRecallSignature(secret, envelope);
}

async function verifySvixSignature(
  secret: string,
  envelope: WebhookEnvelope,
): Promise<boolean> {
  // Svix supports two header schemes:
  //   • Legacy:  svix-id        / svix-timestamp        / svix-signature
  //   • Standard Webhooks (new): webhook-id / webhook-timestamp / webhook-signature
  //     https://www.standardwebhooks.com/ — modern Recall accounts use these.
  // We accept either prefix and prefer whichever set is present.
  const svixId = envelope.headers["svix-id"] ?? envelope.headers["webhook-id"];
  const svixTs =
    envelope.headers["svix-timestamp"] ?? envelope.headers["webhook-timestamp"];
  const svixSig =
    envelope.headers["svix-signature"] ?? envelope.headers["webhook-signature"];
  if (!svixId || !svixTs || !svixSig) return false;

  const tsNum = Number(svixTs);
  if (!Number.isFinite(tsNum)) return false;
  const age = Math.abs(Date.now() / 1000 - tsNum);
  if (age > REPLAY_WINDOW_SEC) return false;

  // `whsec_<base64>` → raw key bytes.
  const rawSecret = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(rawSecret);
  } catch {
    return false;
  }

  const signedContent = `${svixId}.${svixTs}.${envelope.rawBody}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const out = await crypto.subtle.sign("HMAC", key, enc.encode(signedContent));
  const expectedB64 = bytesToBase64(new Uint8Array(out));

  // Header format: "v1,<base64> v1,<base64> v2,…"
  const candidates = svixSig
    .split(" ")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const idx = p.indexOf(",");
      if (idx === -1) return null;
      return { version: p.slice(0, idx), sig: p.slice(idx + 1) };
    })
    .filter((p): p is { version: string; sig: string } => p !== null);

  return candidates.some(
    (c) => c.version === "v1" && timingSafeEqual(c.sig, expectedB64),
  );
}

async function verifyLegacyRecallSignature(
  secret: string,
  envelope: WebhookEnvelope,
): Promise<boolean> {
  const header = envelope.headers["recall-signature"] ?? envelope.headers["x-recall-signature"];
  if (!header) return false;

  // Legacy header form: `t=<ts>,v1=<hex>[,v1=<hex>...]`.
  const parts = header.split(",").map((p) => p.trim());
  const tsEntry = parts.find((p) => p.startsWith("t="))?.slice(2);
  const sigs = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!tsEntry || sigs.length === 0) return false;

  const tsNum = Number(tsEntry);
  if (!Number.isFinite(tsNum)) return false;
  const age = Math.abs(Date.now() / 1000 - tsNum);
  if (age > REPLAY_WINDOW_SEC) return false;

  const base = `${tsEntry}.${envelope.rawBody}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const out = await crypto.subtle.sign("HMAC", key, enc.encode(base));
  const hex = Array.from(new Uint8Array(out))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return sigs.some((s) => timingSafeEqual(hex, s));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function base64ToBytes(b64: string): Uint8Array {
  // Browser-safe path so we keep one code path on Node + Edge runtimes.
  const binary = typeof atob !== "undefined" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === undefined) continue;
    s += String.fromCharCode(b);
  }
  return typeof btoa !== "undefined" ? btoa(s) : Buffer.from(s, "binary").toString("base64");
}

/**
 * Nexos — the team of assistants inside a workspace.
 *
 * Every workspace has one general Nexo (always present, never deleted, owns
 * whatever no specialist owns) and any number of specialists created from a
 * short questionnaire. This module is the shared vocabulary: the shapes the
 * REST API returns (`/api/nexos…`, `/api/org/ai-keys`), the zod schemas it
 * validates bodies with, the template presets the creation wizard offers, and
 * the pure helpers both sides need to agree on (`nexoSlug`, the deterministic
 * prompt the wizard previews and the API falls back to).
 *
 * Copy is Spanish first — Nexos are configured by the people who run support
 * or marketing, and the prompt section headings are fixed in Spanish because
 * the runtime reads them back. Template presets also carry English copy under
 * `en` for the English UI.
 *
 * Must not break: the enum values are CHECK constraints in
 * `supabase/migrations/0096_nexos.sql`; widening one is a migration.
 */
import { z } from "zod";

/* -------------------------------------------------------------------------- */
/*  Vocabularies                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What a Nexo may do outbound on its own. `observe` reads, feeds the brain and
 * escalates; `draft` (default) proposes replies to the inbox for a human to
 * approve; `act` replies directly in the channel.
 */
export const NEXO_AUTONOMY = ["observe", "draft", "act"] as const;
export type NexoAutonomy = (typeof NEXO_AUTONOMY)[number];
export const NEXO_AUTONOMY_LABEL: Record<NexoAutonomy, { es: string; en: string }> = {
  observe: { es: "Solo observa", en: "Observe only" },
  draft: { es: "Propone borradores", en: "Drafts replies" },
  act: { es: "Responde solo", en: "Acts on its own" },
};

export const NEXO_STATUSES = ["active", "paused"] as const;
export type NexoStatus = (typeof NEXO_STATUSES)[number];

export const NEXO_BINDING_MODES = ["listen", "listen_reply"] as const;
export type NexoBindingMode = (typeof NEXO_BINDING_MODES)[number];

export const NEXO_RUN_TRIGGERS = ["chat", "heartbeat", "event", "batch", "manual"] as const;
export type NexoRunTrigger = (typeof NEXO_RUN_TRIGGERS)[number];

export const NEXO_RUN_STATUSES = ["running", "succeeded", "failed", "skipped"] as const;
export type NexoRunStatus = (typeof NEXO_RUN_STATUSES)[number];

export const NEXO_INBOX_KINDS = ["escalation", "draft_reply", "approval"] as const;
export type NexoInboxKind = (typeof NEXO_INBOX_KINDS)[number];

export const NEXO_INBOX_STATUSES = ["open", "approved", "edited", "rejected", "done"] as const;
export type NexoInboxStatus = (typeof NEXO_INBOX_STATUSES)[number];

/** What a person does with an inbox item (`POST /api/nexos/inbox/:itemId`). */
export const NEXO_INBOX_ACTIONS = ["approve", "edit", "reject", "done"] as const;
export type NexoInboxAction = (typeof NEXO_INBOX_ACTIONS)[number];

export const NEXO_TONES = ["formal", "cercano", "técnico"] as const;
export type NexoTone = (typeof NEXO_TONES)[number];
export const NEXO_TONE_LABEL: Record<NexoTone, { es: string; en: string }> = {
  formal: { es: "Formal", en: "Formal" },
  cercano: { es: "Cercano", en: "Friendly" },
  "técnico": { es: "Técnico", en: "Technical" },
};

/** The "¿Qué puede hacer sin preguntar?" multi-select. */
export const NEXO_CAN_DO = ["read", "summarize", "update_brain", "draft_replies", "reply"] as const;
export type NexoCanDo = (typeof NEXO_CAN_DO)[number];
export const NEXO_CAN_DO_LABEL: Record<NexoCanDo, { es: string; en: string }> = {
  read: { es: "Leer lo que llega", en: "Read what comes in" },
  summarize: { es: "Resumir", en: "Summarize" },
  update_brain: { es: "Actualizar el cerebro", en: "Update the brain" },
  draft_replies: { es: "Preparar borradores de respuesta", en: "Draft replies" },
  reply: { es: "Responder directamente", en: "Reply directly" },
};

export const ORG_AI_KEY_PROVIDERS = ["anthropic", "openai", "gateway"] as const;
export type OrgAiKeyProvider = (typeof ORG_AI_KEY_PROVIDERS)[number];

/** Template keys. `custom` is "start from nothing"; `general` is reserved for the built-in Nexo. */
export const NEXO_TEMPLATE_KEYS = [
  "support",
  "marketing",
  "engineering",
  "sales",
  "people",
  "research",
  "custom",
] as const;
export type NexoTemplateKey = (typeof NEXO_TEMPLATE_KEYS)[number];
export const GENERAL_NEXO_TEMPLATE = "general";

/** Fixed `prompt_md` headings, in order. The runtime and the editor both rely on them. */
export const NEXO_PROMPT_SECTIONS = [
  "Identidad",
  "De qué se encarga",
  "Qué puede hacer sin preguntar",
  "Cuándo avisar",
  "Tono",
  "Rutina",
] as const;

export const NEXO_LIMITS = {
  name: 80,
  description: 500,
  prompt: 20_000,
  questionnaireText: 2_000,
  checklist: 4_000,
  /** Heartbeat cadence bounds, minutes. */
  minEveryMinutes: 15,
  maxEveryMinutes: 24 * 60,
  slug: 48,
} as const;

/* -------------------------------------------------------------------------- */
/*  Embedded settings (jsonb columns)                                         */
/* -------------------------------------------------------------------------- */

/** Brain tool allowlist. Maps onto the Nexo's grant verbs: read → read, write → write. */
export const NexoBrainToolsSchema = z.object({
  read: z.boolean(),
  write: z.boolean(),
}).strict();
export type NexoBrainTools = z.infer<typeof NexoBrainToolsSchema>;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** True when `tz` is an IANA timezone this runtime knows (`Intl` throws on anything else). */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** IANA timezone, e.g. "Europe/Madrid"; refused when `Intl` does not know it. */
const timeZone = z.string().trim().min(1).max(64).refine(isValidTimeZone, { message: "unknown IANA timezone" });

export const NexoHeartbeatSchema = z.object({
  enabled: z.boolean(),
  every_minutes: z.number().int().min(NEXO_LIMITS.minEveryMinutes).max(NEXO_LIMITS.maxEveryMinutes),
  active_hours: z.object({
    start: z.string().regex(HHMM),
    end: z.string().regex(HHMM),
    tz: timeZone,
  }).strict(),
  checklist_md: z.string().max(NEXO_LIMITS.checklist),
}).strict();
export type NexoHeartbeat = z.infer<typeof NexoHeartbeatSchema>;

/**
 * Heartbeat overrides on create. Every field optional: what is missing comes
 * from the defaults (on when the questionnaire has a routine, hourly,
 * 09:00–19:00, tz UTC). The web sends the browser's timezone in
 * `active_hours.tz` so the default window is the creator's working day.
 */
export const NexoHeartbeatOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  every_minutes: z.number().int().min(NEXO_LIMITS.minEveryMinutes).max(NEXO_LIMITS.maxEveryMinutes).optional(),
  active_hours: z.object({
    start: z.string().regex(HHMM).optional(),
    end: z.string().regex(HHMM).optional(),
    tz: timeZone.optional(),
  }).strict().optional(),
}).strict();
export type NexoHeartbeatOverride = z.infer<typeof NexoHeartbeatOverrideSchema>;

export const NexoEscalationSchema = z.object({
  notify_user_ids: z.array(z.string().uuid()).max(20),
  via: z.array(z.enum(["inbox", "email"])).max(2),
}).strict();
export type NexoEscalation = z.infer<typeof NexoEscalationSchema>;

export const DEFAULT_NEXO_BRAIN_TOOLS: NexoBrainTools = { read: true, write: true };
export const DEFAULT_NEXO_HEARTBEAT: NexoHeartbeat = {
  enabled: false,
  every_minutes: 60,
  active_hours: { start: "09:00", end: "19:00", tz: "UTC" },
  checklist_md: "",
};
export const DEFAULT_NEXO_ESCALATION: NexoEscalation = { notify_user_ids: [], via: ["inbox"] };

/* -------------------------------------------------------------------------- */
/*  Questionnaire                                                             */
/* -------------------------------------------------------------------------- */

const shortText = z.string().trim().max(NEXO_LIMITS.questionnaireText);

/**
 * The creation questionnaire. Short on purpose: every field is a string or a
 * list, and only `name` and `mission` are required.
 */
export const NexoQuestionnaireSchema = z.object({
  name: z.string().trim().min(1).max(NEXO_LIMITS.name),
  /** «¿De qué se encarga?» */
  mission: z.string().trim().min(1).max(NEXO_LIMITS.questionnaireText),
  /** Integration ids (catalog `connector_id`s) it should watch. */
  sources: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  can_do_alone: z.array(z.enum(NEXO_CAN_DO)).max(NEXO_CAN_DO.length).default(["read", "summarize"]),
  /** «Cuándo avisar», e.g. "un cliente se queja de facturación". */
  escalate_when: shortText.default(""),
  tone: z.enum(NEXO_TONES).default("cercano"),
  /** Language it answers in, a code or a name ("es", "en", "español"); prompts use `nexoLanguageName`. */
  language: z.string().trim().max(32).default("es"),
  /** What to check on each heartbeat. */
  routine: shortText.default(""),
}).strict();
export type NexoQuestionnaire = z.infer<typeof NexoQuestionnaireSchema>;
export type NexoQuestionnaireInput = z.input<typeof NexoQuestionnaireSchema>;

/* -------------------------------------------------------------------------- */
/*  Templates                                                                 */
/* -------------------------------------------------------------------------- */

export interface NexoTemplate {
  key: NexoTemplateKey;
  /** Spanish copy (default UI). */
  name: string;
  description: string;
  en: { name: string; description: string };
  /** Questionnaire prefill; `name` is the suggested Nexo name. */
  questionnaire: NexoQuestionnaire;
  /** Catalog `connector_id`s worth connecting to this kind of Nexo. */
  suggested_integrations: string[];
  autonomy: NexoAutonomy;
  /** Checklist suggested for the heartbeat; empty = no heartbeat by default. */
  heartbeat_checklist_md: string;
}

function preset(
  key: NexoTemplateKey,
  copy: { name: string; description: string; en: { name: string; description: string } },
  q: Omit<NexoQuestionnaire, "language"> & { language?: string },
  extras: { suggested_integrations: string[]; autonomy?: NexoAutonomy; heartbeat_checklist_md?: string },
): NexoTemplate {
  return {
    key,
    ...copy,
    questionnaire: { ...q, language: q.language ?? "es" },
    suggested_integrations: extras.suggested_integrations,
    autonomy: extras.autonomy ?? "draft",
    heartbeat_checklist_md: extras.heartbeat_checklist_md ?? "",
  };
}

export const NEXO_TEMPLATES: readonly NexoTemplate[] = [
  preset(
    "support",
    {
      name: "Soporte",
      description: "Atiende las preguntas de clientes, propone respuestas y avisa cuando algo se complica.",
      en: { name: "Support", description: "Handles customer questions, drafts replies and escalates when something gets tricky." },
    },
    {
      name: "Soporte",
      mission: "Atender las preguntas de clientes que llegan por los canales de soporte, responder con lo que sabe el equipo y detectar problemas recurrentes.",
      sources: ["slack"],
      can_do_alone: ["read", "summarize", "update_brain", "draft_replies"],
      escalate_when: "Un cliente se queja de facturación, pide una devolución o el problema no está documentado.",
      tone: "cercano",
      routine: "Revisar los hilos sin respuesta y resumir los temas que más se repiten.",
    },
    { suggested_integrations: ["slack"], heartbeat_checklist_md: "- Hilos de clientes sin respuesta\n- Temas que se repiten esta semana" },
  ),
  preset(
    "marketing",
    {
      name: "Marketing",
      description: "Sigue campañas, contenido y lanzamientos y mantiene el cerebro al día.",
      en: { name: "Marketing", description: "Follows campaigns, content and launches and keeps the brain up to date." },
    },
    {
      name: "Marketing",
      mission: "Seguir campañas, calendario de contenido y lanzamientos, y registrar decisiones y resultados.",
      sources: ["slack", "notion"],
      can_do_alone: ["read", "summarize", "update_brain"],
      escalate_when: "Una campaña se retrasa o hay una decisión de marca pendiente.",
      tone: "cercano",
      routine: "Revisar qué contenido sale esta semana y qué quedó pendiente.",
    },
    { suggested_integrations: ["slack", "notion"], autonomy: "observe" },
  ),
  preset(
    "engineering",
    {
      name: "Ingeniería",
      description: "Vigila issues, PRs y decisiones técnicas y las conecta con el resto del cerebro.",
      en: { name: "Engineering", description: "Watches issues, PRs and technical decisions and links them to the rest of the brain." },
    },
    {
      name: "Ingeniería",
      mission: "Seguir issues, pull requests y decisiones técnicas, y mantener el estado de las tareas al día.",
      sources: ["github", "linear"],
      can_do_alone: ["read", "summarize", "update_brain"],
      escalate_when: "Un incidente en producción o una tarea bloqueada más de dos días.",
      tone: "técnico",
      routine: "Revisar tareas bloqueadas e issues nuevos sin responsable.",
    },
    { suggested_integrations: ["github", "linear"], autonomy: "observe", heartbeat_checklist_md: "- Tareas bloqueadas\n- Issues nuevos sin responsable" },
  ),
  preset(
    "sales",
    {
      name: "Ventas",
      description: "Sigue oportunidades y conversaciones con clientes potenciales.",
      en: { name: "Sales", description: "Tracks deals and conversations with prospects." },
    },
    {
      name: "Ventas",
      mission: "Seguir las conversaciones con clientes potenciales, registrar compromisos y preparar seguimientos.",
      sources: ["slack"],
      can_do_alone: ["read", "summarize", "update_brain", "draft_replies"],
      escalate_when: "Un cliente pide precio especial o condiciones fuera de lo habitual.",
      tone: "cercano",
      routine: "Revisar oportunidades sin seguimiento en la última semana.",
    },
    { suggested_integrations: ["slack"] },
  ),
  preset(
    "people",
    {
      name: "Personas",
      description: "Responde dudas internas de RRHH: vacaciones, procesos, incorporaciones.",
      en: { name: "People", description: "Answers internal HR questions: time off, processes, onboarding." },
    },
    {
      name: "Personas",
      mission: "Responder dudas internas sobre vacaciones, procesos y políticas, y acompañar las incorporaciones.",
      sources: ["slack"],
      can_do_alone: ["read", "summarize", "draft_replies"],
      escalate_when: "Un tema personal o sensible, o una consulta sobre salarios.",
      tone: "cercano",
      routine: "Revisar incorporaciones de la semana y dudas sin resolver.",
    },
    { suggested_integrations: ["slack"] },
  ),
  preset(
    "research",
    {
      name: "Investigación",
      description: "Reúne y resume información sobre un tema y la deja ordenada en el cerebro.",
      en: { name: "Research", description: "Gathers and summarizes information on a topic and files it in the brain." },
    },
    {
      name: "Investigación",
      mission: "Reunir y resumir información sobre los temas que le encargue el equipo, citando siempre las fuentes.",
      sources: [],
      can_do_alone: ["read", "summarize", "update_brain"],
      escalate_when: "Las fuentes se contradicen o falta información clave.",
      tone: "formal",
      routine: "",
    },
    { suggested_integrations: [], autonomy: "observe" },
  ),
  preset(
    "custom",
    {
      name: "Personalizado",
      description: "Empieza de cero y define tú qué hace.",
      en: { name: "Custom", description: "Start from scratch and define what it does." },
    },
    {
      name: "",
      mission: "",
      sources: [],
      can_do_alone: ["read", "summarize"],
      escalate_when: "",
      tone: "cercano",
      routine: "",
    },
    { suggested_integrations: [] },
  ),
];

export function nexoTemplate(key: string): NexoTemplate | undefined {
  return NEXO_TEMPLATES.find((t) => t.key === key);
}

/* -------------------------------------------------------------------------- */
/*  Pure helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The slug a Nexo name mints. Lowercase ASCII, dashes, at most 48 chars,
 * never empty. The API appends `-2`, `-3`… when the workspace already has it.
 */
export function nexoSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, NEXO_LIMITS.slug)
    .replace(/-+$/g, "");
  return base || "nexo";
}

/** Brain tools implied by the questionnaire's «puede hacer sin preguntar». */
export function brainToolsFromCanDo(canDo: readonly NexoCanDo[]): NexoBrainTools {
  return { read: true, write: canDo.includes("update_brain") };
}

/** Autonomy implied by the questionnaire: reply → act, draft_replies → draft, else observe. */
export function autonomyFromCanDo(canDo: readonly NexoCanDo[]): NexoAutonomy {
  if (canDo.includes("reply")) return "act";
  if (canDo.includes("draft_replies")) return "draft";
  return "observe";
}

/** Language codes the questionnaire may carry, named in their own language. */
const NEXO_LANGUAGE_NAMES: Record<string, string> = {
  es: "español",
  en: "English",
  pt: "português",
  fr: "français",
  de: "Deutsch",
  it: "italiano",
  ca: "català",
  eu: "euskara",
  gl: "galego",
  nl: "Nederlands",
  pl: "polski",
  sv: "svenska",
  da: "dansk",
  no: "norsk",
  nb: "norsk",
  fi: "suomi",
  ro: "română",
  ja: "日本語",
  zh: "中文",
  ko: "한국어",
};

/**
 * The language name to put in a prompt. Accepts a code ("es", "pt-BR") or a
 * name ("español", "English"): known codes map to their name, anything else
 * is returned as written. Empty means the default, Spanish.
 */
export function nexoLanguageName(language: string): string {
  const raw = language.trim();
  if (!raw) return NEXO_LANGUAGE_NAMES.es!;
  const base = raw.toLowerCase().split(/[-_]/)[0]!;
  return /^[a-z]{2,3}([-_][a-z0-9]+)?$/i.test(raw) ? NEXO_LANGUAGE_NAMES[base] ?? raw : raw;
}

function bullet(lines: readonly string[]): string {
  return lines.map((l) => `- ${l}`).join("\n");
}

/**
 * The deterministic prompt: what the wizard previews and what the API stores
 * when no model is available. Same six sections, in order, as the model is
 * asked to produce (`NEXO_PROMPT_SECTIONS`).
 */
export function renderNexoPrompt(input: NexoQuestionnaireInput): string {
  const q = NexoQuestionnaireSchema.parse(input);
  const canDo = q.can_do_alone.length > 0
    ? bullet(q.can_do_alone.map((c) => NEXO_CAN_DO_LABEL[c].es))
    : "- Nada sin preguntar: propone y espera confirmación.";
  const sources = q.sources.length > 0 ? ` Escucha: ${q.sources.join(", ")}.` : "";
  return [
    "## Identidad",
    "",
    `Eres ${q.name}, un Nexo del equipo. Trabajas con el cerebro de la empresa (Bcontext) y respondes en ${nexoLanguageName(q.language)}.${sources}`,
    "",
    "## De qué se encarga",
    "",
    q.mission,
    "",
    "## Qué puede hacer sin preguntar",
    "",
    canDo,
    "",
    "## Cuándo avisar",
    "",
    q.escalate_when
      ? `Escala a una persona cuando: ${q.escalate_when}`
      : "Escala a una persona cuando no tengas la información o la decisión no te corresponda.",
    "Ante la duda, avisa en lugar de inventar.",
    "",
    "## Tono",
    "",
    `${NEXO_TONE_LABEL[q.tone].es}. Claro y breve; cita las fuentes del cerebro cuando las uses.`,
    "",
    "## Rutina",
    "",
    q.routine || "Sin rutina fija: actúa cuando te escriban o llegue algo nuevo.",
    "",
  ].join("\n");
}

/** True when `md` carries every fixed section heading, in order. */
export function hasNexoPromptSections(md: string): boolean {
  let at = 0;
  for (const section of NEXO_PROMPT_SECTIONS) {
    const idx = md.indexOf(`## ${section}`, at);
    if (idx < 0) return false;
    at = idx + section.length;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Records as the API returns them                                           */
/* -------------------------------------------------------------------------- */

export interface Nexo {
  id: string;
  workspace_id: string;
  /** The backing `agents` row: its grant, capability principal and activity name. */
  agent_id: string;
  slug: string;
  name: string;
  description: string;
  is_general: boolean;
  template: string;
  questionnaire: Partial<NexoQuestionnaire>;
  prompt_md: string;
  model: string | null;
  autonomy: NexoAutonomy;
  brain_tools: NexoBrainTools;
  heartbeat: NexoHeartbeat;
  escalation: NexoEscalation;
  monthly_budget_credits: number | null;
  status: NexoStatus;
  last_run_at: string | null;
  next_heartbeat_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** What a list card needs of a binding: which install and scope it owns. */
export interface NexoBindingRef {
  install_id: string;
  connector_id: string;
  scope_key: string;
}

/** A card on the Nexos page. */
export interface NexoListItem extends Nexo {
  /** `connector_id`s bound to it, deduplicated (for the integration icons). */
  integrations: string[];
  /** Its bindings, so the web can name who owns an install without a call per Nexo. */
  bindings: NexoBindingRef[];
  open_inbox_count: number;
}

/** A Slack channel an install can see (`GET /api/nexos/channels`). */
export interface NexoSlackChannel {
  id: string;
  name: string;
  is_private: boolean;
  /** The bot is in it already; others need an invite before messages arrive. */
  is_member: boolean;
}

export interface NexoBinding {
  id: string;
  nexo_id: string;
  workspace_id: string;
  install_id: string;
  connector_id: string;
  /** `*` = the whole install; `channel:<id>` = one Slack channel. One owner per (install, scope_key). */
  scope_key: string;
  scope: Record<string, unknown>;
  mode: NexoBindingMode;
  created_by: string | null;
  created_at: string;
}

export interface NexoRunStep {
  tool: string;
  ok: boolean;
  note?: string;
}

export interface NexoRun {
  id: string;
  nexo_id: string;
  workspace_id: string;
  trigger: NexoRunTrigger;
  status: NexoRunStatus;
  input: Record<string, unknown>;
  output_md: string | null;
  steps: NexoRunStep[];
  usage: Record<string, unknown>;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface NexoInboxItem {
  id: string;
  workspace_id: string;
  nexo_id: string;
  run_id: string | null;
  kind: NexoInboxKind;
  title: string;
  body_md: string;
  /** e.g. slack `{ install_id, channel, thread_ts, draft_text }`. */
  payload: Record<string, unknown>;
  status: NexoInboxStatus;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One capability or bundle granted to a Nexo's principal. */
export interface NexoToolGrant {
  id: string;
  capability_id: string | null;
  bundle_id: string | null;
  /** Capability or bundle title, when it still exists. */
  title: string | null;
  actions: string[];
  expires_at: string | null;
  created_at: string;
}

export interface NexoTools {
  brain_tools: NexoBrainTools;
  /** Null when the workspace has no capability gateway (demo backend). */
  principal_id: string | null;
  grants: NexoToolGrant[];
}

export interface NexoSession {
  id: string;
  title: string | null;
  user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrgAiKey {
  provider: OrgAiKeyProvider;
  last4: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/* -------------------------------------------------------------------------- */
/*  Request bodies                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/nexos`. `prompt_md` lets the wizard send the (possibly edited)
 * preview so the stored prompt is what the person saw; without it the API
 * generates one. `heartbeat` overrides the routine defaults (see
 * `NexoHeartbeatOverrideSchema`). Escalations notify the creator by default.
 * `preview: true` returns `{ prompt_md, source }` and creates nothing.
 */
export const CreateNexoBodySchema = z.object({
  /** Workspace slug; `?workspace=` on the URL works too and wins. */
  workspace: z.string().trim().min(1).optional(),
  template: z.enum(NEXO_TEMPLATE_KEYS).default("custom"),
  questionnaire: NexoQuestionnaireSchema,
  description: z.string().trim().max(NEXO_LIMITS.description).optional(),
  prompt_md: z.string().trim().min(1).max(NEXO_LIMITS.prompt).optional(),
  autonomy: z.enum(NEXO_AUTONOMY).optional(),
  heartbeat: NexoHeartbeatOverrideSchema.optional(),
  preview: z.boolean().optional(),
}).strict();
export type CreateNexoBody = z.input<typeof CreateNexoBodySchema>;

/** `PATCH /api/nexos/:id?workspace=`. Every field optional; `null` clears the nullable ones. */
export const UpdateNexoBodySchema = z.object({
  name: z.string().trim().min(1).max(NEXO_LIMITS.name).optional(),
  description: z.string().trim().max(NEXO_LIMITS.description).optional(),
  prompt_md: z.string().max(NEXO_LIMITS.prompt).optional(),
  questionnaire: NexoQuestionnaireSchema.optional(),
  autonomy: z.enum(NEXO_AUTONOMY).optional(),
  brain_tools: NexoBrainToolsSchema.optional(),
  heartbeat: NexoHeartbeatSchema.optional(),
  escalation: NexoEscalationSchema.optional(),
  monthly_budget_credits: z.number().min(0).max(1_000_000).nullable().optional(),
  status: z.enum(NEXO_STATUSES).optional(),
  model: z.string().trim().min(1).max(120).nullable().optional(),
}).strict();
export type UpdateNexoBody = z.infer<typeof UpdateNexoBodySchema>;

/**
 * `POST /api/nexos/:id/bindings?workspace=`. One row per channel in
 * `channels` (scope_key `channel:<id>`), or one row for the whole install
 * (`*`) when `channels` is empty. 409 when another Nexo already owns one.
 */
export const CreateNexoBindingBodySchema = z.object({
  install_id: z.string().uuid(),
  channels: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
  /** Extra descriptive scope (e.g. channel names), stored alongside. */
  scope: z.record(z.unknown()).default({}),
  mode: z.enum(NEXO_BINDING_MODES).default("listen"),
}).strict();
export type CreateNexoBindingBody = z.input<typeof CreateNexoBindingBodySchema>;

/** `PUT /api/nexos/:id/tools?workspace=`: the full desired set; omitted grants are revoked. */
export const PutNexoToolsBodySchema = z.object({
  brain_tools: NexoBrainToolsSchema.optional(),
  capability_ids: z.array(z.string().uuid()).max(100).default([]),
  bundle_ids: z.array(z.string().uuid()).max(100).default([]),
}).strict();
export type PutNexoToolsBody = z.input<typeof PutNexoToolsBodySchema>;

/** `POST /api/nexos/:id/run?workspace=`: a manual run with an optional instruction. */
export const NexoRunBodySchema = z.object({
  instruction: z.string().trim().max(NEXO_LIMITS.questionnaireText).optional(),
}).strict();
export type NexoRunBody = z.infer<typeof NexoRunBodySchema>;

/** `POST /api/nexos/inbox/:itemId?workspace=`. `text` replaces the draft on `edit`. */
export const NexoInboxActionBodySchema = z.object({
  action: z.enum(NEXO_INBOX_ACTIONS),
  text: z.string().trim().min(1).max(NEXO_LIMITS.prompt).optional(),
}).strict().refine((b) => b.action !== "edit" || Boolean(b.text), {
  message: "text is required to edit",
  path: ["text"],
});
export type NexoInboxActionBody = z.infer<typeof NexoInboxActionBodySchema>;

/** `PUT /api/org/ai-keys?org=`. The key is write-only: responses carry provider + last4. */
export const PutOrgAiKeyBodySchema = z.object({
  provider: z.enum(ORG_AI_KEY_PROVIDERS),
  api_key: z.string().trim().min(8).max(500),
}).strict();
export type PutOrgAiKeyBody = z.infer<typeof PutOrgAiKeyBodySchema>;

/* -------------------------------------------------------------------------- */
/*  Responses                                                                 */
/* -------------------------------------------------------------------------- */

export interface ListNexosResponse {
  nexos: NexoListItem[];
}

export interface NexoResponse {
  nexo: Nexo;
}

export interface NexoPromptPreviewResponse {
  prompt_md: string;
  /** `model` when generated, `template` when the deterministic fallback was used. */
  source: "model" | "template";
}

export interface NexoDetailResponse {
  nexo: Nexo;
  bindings: NexoBinding[];
  tools: NexoTools;
  recent_runs: NexoRun[];
  open_inbox_count: number;
}

export interface NexoChannelsResponse {
  channels: NexoSlackChannel[];
  /** True when the listing stopped at the cap (1000). */
  truncated: boolean;
}

export interface NexoBindingsResponse {
  bindings: NexoBinding[];
}

export interface NexoRunsResponse {
  runs: NexoRun[];
}

export interface NexoSessionsResponse {
  sessions: NexoSession[];
}

export interface NexoInboxResponse {
  items: NexoInboxItem[];
}

export interface OrgAiKeysResponse {
  keys: OrgAiKey[];
}

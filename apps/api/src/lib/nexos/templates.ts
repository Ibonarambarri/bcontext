/**
 * Server-side view of the Nexo presets: what a template implies for the
 * settings the questionnaire does not ask about (autonomy, brain tools,
 * heartbeat checklist), and the general Nexo's own definition.
 *
 * The presets themselves live in the contract (`NEXO_TEMPLATES`) because the
 * creation wizard renders them; this module only derives row defaults from
 * them. Callers: `./lifecycle`, `./general`.
 */
import {
  DEFAULT_NEXO_ESCALATION,
  DEFAULT_NEXO_HEARTBEAT,
  GENERAL_NEXO_TEMPLATE,
  autonomyFromCanDo,
  brainToolsFromCanDo,
  nexoTemplate,
  type NexoAutonomy,
  type NexoBrainTools,
  type NexoEscalation,
  type NexoHeartbeat,
  type NexoHeartbeatOverride,
  type NexoQuestionnaire,
} from "@bcontext-dev/contract/nexos";

export { NEXO_TEMPLATES, nexoTemplate } from "@bcontext-dev/contract/nexos";

export interface NexoSettingsDefaults {
  autonomy: NexoAutonomy;
  brain_tools: NexoBrainTools;
  heartbeat: NexoHeartbeat;
  escalation: NexoEscalation;
}

/** What the creation request adds on top of the template and questionnaire. */
export interface NexoCreationOptions {
  /** Partial heartbeat from the request; any field it leaves out is a default. */
  heartbeat?: NexoHeartbeatOverride;
  /** The person creating it, notified of its escalations; null when no human is behind the request. */
  notifyUserId?: string | null;
}

/**
 * Settings for a new specialist. The questionnaire's «puede hacer sin
 * preguntar» wins over the template (it is what the person just said). The
 * heartbeat is on only when the questionnaire has a routine — the person
 * asked for something to be checked on a clock; a template checklist alone
 * stays off, because a Nexo that starts spending on a clock nobody asked for
 * is a surprise on the bill. Escalations go to the creator's inbox, so they
 * reach someone from the first run.
 */
export function defaultsFor(
  templateKey: string,
  questionnaire: NexoQuestionnaire,
  options: NexoCreationOptions = {},
): NexoSettingsDefaults {
  const template = nexoTemplate(templateKey);
  const routine = questionnaire.routine.trim();
  const override = options.heartbeat ?? {};
  const hours = DEFAULT_NEXO_HEARTBEAT.active_hours;
  return {
    autonomy: autonomyFromCanDo(questionnaire.can_do_alone),
    brain_tools: brainToolsFromCanDo(questionnaire.can_do_alone),
    heartbeat: {
      enabled: override.enabled ?? routine.length > 0,
      every_minutes: override.every_minutes ?? DEFAULT_NEXO_HEARTBEAT.every_minutes,
      active_hours: {
        start: override.active_hours?.start ?? hours.start,
        end: override.active_hours?.end ?? hours.end,
        tz: override.active_hours?.tz ?? hours.tz,
      },
      checklist_md: routine || (template?.heartbeat_checklist_md ?? ""),
    },
    escalation: options.notifyUserId
      ? { ...DEFAULT_NEXO_ESCALATION, notify_user_ids: [options.notifyUserId] }
      : DEFAULT_NEXO_ESCALATION,
  };
}

/** The general Nexo: the assistant every workspace already had, now first among the team. */
export const GENERAL_NEXO = {
  name: "Nexo",
  template: GENERAL_NEXO_TEMPLATE,
  description: "El Nexo general: atiende todo lo que no tiene un especialista y conoce todo el cerebro.",
  questionnaire: {
    name: "Nexo",
    mission:
      "Ayudar a cualquier persona del equipo con el cerebro de la empresa: responder preguntas, ordenar información y recoger lo que llega por integraciones que no tienen un Nexo especialista.",
    sources: [],
    can_do_alone: ["read", "summarize", "update_brain", "draft_replies"],
    escalate_when: "La información no está en el cerebro o la decisión corresponde a una persona.",
    tone: "cercano",
    language: "es",
    routine: "",
  } satisfies NexoQuestionnaire,
  autonomy: "draft" as NexoAutonomy,
  brain_tools: { read: true, write: true } as NexoBrainTools,
};

/**
 * `POST /api/nexos/:id/chat`: for the general Nexo it is `POST /api/nexo`
 * (same stream, same prompt, same tools); a specialist adds its prompt and
 * narrows the tools to its switches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText,
}));
vi.mock("@/lib/rag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rag")>()),
  retrieveScoped: vi.fn(async () => null),
}));

import { createWorkspace } from "@/lib/demo-store";
import { ensureGeneralNexo } from "@/lib/nexos/general";
import { createNexo } from "@/lib/nexos/lifecycle";
import { resetNexoStoreForTests } from "@/lib/nexos/store";
import { POST as LEGACY } from "@/app/api/nexo/route";
import { POST as CHAT } from "./route";

const headers = { "content-type": "application/json", origin: "http://localhost", host: "localhost" };
const params = (id: string) => ({ params: Promise.resolve({ id }) });

let slug: string;
let workspaceId: string;
beforeEach(() => {
  resetNexoStoreForTests();
  streamText.mockReset().mockImplementation(() => ({ fullStream: (async function* () {})() }));
  const ws = createWorkspace({ name: "Chat", slug: `chat-${Date.now()}-${Math.random().toString(36).slice(2)}` });
  slug = ws.slug;
  workspaceId = ws.id;
  extra = {};
});
afterEach(() => vi.unstubAllEnvs());

/** The general path reads the env key at boot; a per-request key is how a test gives it a model. */
let extra: Record<string, string> = {};
function body() {
  return JSON.stringify({ workspace: slug, messages: [{ role: "user", content: "¿Qué hay pendiente?" }] });
}
const legacy = () =>
  LEGACY(new Request("http://localhost/api/nexo", { method: "POST", headers: { ...headers, ...extra }, body: body() }));
const chat = (id: string) =>
  CHAT(
    new Request(`http://localhost/api/nexos/${id}/chat?workspace=${slug}`, { method: "POST", headers: { ...headers, ...extra }, body: body() }),
    params(id),
  );

describe("POST /api/nexos/:id/chat", () => {
  it("answers exactly like /api/nexo for the general Nexo without a model", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    const general = await ensureGeneralNexo({ workspaceId, backend: "demo" });
    const [a, b] = [await legacy(), await chat(general.id)];
    expect(b.status).toBe(a.status);
    expect(b.headers.get("content-type")).toBe(a.headers.get("content-type"));
    expect(await b.text()).toBe(await a.text());
  });

  it("calls the model with the same prompt and tools as /api/nexo for the general Nexo", async () => {
    extra = { "x-ai-gateway-key": "test-key" };
    const general = await ensureGeneralNexo({ workspaceId, backend: "demo" });
    await (await legacy()).text();
    await (await chat(general.id)).text();
    expect(streamText).toHaveBeenCalledTimes(2);
    const [a, b] = streamText.mock.calls.map((c) => c[0] as { model: unknown; messages: unknown; tools: object; temperature: number }) as [
      { model: unknown; messages: unknown; tools: object; temperature: number },
      { model: unknown; messages: unknown; tools: object; temperature: number },
    ];
    expect(b.messages).toEqual(a.messages);
    expect(Object.keys(b.tools).sort()).toEqual(Object.keys(a.tools).sort());
    const id = (m: unknown) => (m as { modelId?: string }).modelId ?? m;
    expect(id(b.model)).toEqual(id(a.model));
    expect(b.temperature).toBe(a.temperature);
  });

  it("gives a specialist its prompt and only the tools its switches allow", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "test-key");
    const n = await createNexo({ workspaceId, backend: "demo" }, {
      name: "Lector",
      template: "custom",
      questionnaire: {
        name: "Lector",
        mission: "Leer.",
        sources: [],
        can_do_alone: ["read"],
        escalate_when: "",
        tone: "formal",
        language: "es",
        routine: "",
      },
      prompt_md: "## Identidad\nSolo leo.",
      brain_tools: { read: true, write: false },
      createdBy: null,
    });
    const res = await chat(n.id);
    expect(res.status).toBe(200);
    await res.text();
    const call = streamText.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }>; tools: object };
    expect(call.messages[1]!.content).toContain("## You are Lector");
    expect(call.messages[1]!.content).toContain("Solo leo.");
    const tools = Object.keys(call.tools);
    expect(tools).toContain("search_nodes");
    expect(tools).toContain("open_node");
    expect(tools).not.toContain("edit_node");
    expect(tools).not.toContain("create_node");
  });

  it("404s an unknown Nexo", async () => {
    const res = await chat("00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
  });
});

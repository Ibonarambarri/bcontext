/**
 * POST /api/nexos/:id/run?workspace= — run a Nexo now, with an optional
 * instruction (`{ instruction? }`). Answers 202 `{ run_id, status: "running" }`
 * and the run continues in the background; its outcome lands in
 * `GET /api/nexos/:id/runs`. `?wait=1` holds the response until the run ends
 * and answers 200 `{ run_id, status, output_md }` (scripts and tests).
 *
 * Access: verb `write`, scope `chat:run`. The run acts as the Nexo, with the
 * Nexo's grant, and may write; starting one is therefore for people who may
 * write in the workspace themselves, not for viewers.
 */
import { NexoRunBodySchema } from "@bcontext-dev/contract/nexos";
import { log } from "@bcontext-dev/contract/log";
import { openWorkspace } from "@/lib/auth/workspace";
import { actingUserId } from "@/lib/auth/require";
import { withRoute } from "@/lib/route";
import { auditNexo, loadNexo, parseBody, workspaceParam } from "@/lib/nexos/http";
import { createRun, nexoTarget } from "@/lib/nexos/store";
import { describeInput, runNexo } from "@/lib/nexos/runtime/runner";

type Params = { params: Promise<{ id: string }> };

export const POST = withRoute(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const opened = await openWorkspace(req, workspaceParam(req), "write", { scope: "chat:run" });
  if (opened instanceof Response) return opened;
  const ctx = { ...opened, target: nexoTarget(opened.storage), userId: actingUserId(opened.actor) };
  const nexo = await loadNexo(ctx, id);
  if (nexo instanceof Response) return nexo;
  const body = await parseBody(req, NexoRunBodySchema);
  if (body instanceof Response) return body;

  const input = body.instruction ? { instruction: body.instruction } : {};
  const run = await createRun(ctx.target, {
    nexoId: nexo.id,
    trigger: "manual",
    input: { ...describeInput(input), requested_by: ctx.userId },
  });
  auditNexo(ctx, "nexo.run", { type: "nexo", id: nexo.id }, { run_id: run.id });

  const running = runNexo({ nexo, trigger: "manual", input, target: ctx.target, runId: run.id });
  if (new URL(req.url).searchParams.get("wait") === "1") {
    const out = await running;
    return Response.json({ run_id: out.runId, status: out.status, output_md: out.output_md });
  }
  running.catch((err) =>
    log.error("nexos.manual_run.failed", { nexo_id: nexo.id, run_id: run.id, error: err instanceof Error ? err.message : String(err) }),
  );
  return Response.json({ run_id: run.id, status: "running" }, { status: 202 });
});

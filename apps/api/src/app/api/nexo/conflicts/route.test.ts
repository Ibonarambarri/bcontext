import { describe, expect, it } from "vitest";
import { createWorkspace } from "@/lib/demo-store";
import { GET as LIST } from "./route";
import { GET as ACTIVITY } from "@/app/api/integrations/activity/route";

function workspace() {
  const slug = `conflicts-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return createWorkspace({ name: "Conflicts", slug });
}

describe("NEXO conflicts + activity on the demo store", () => {
  it("lists nothing without a persisted workspace instead of failing", async () => {
    const ws = workspace();
    const res = await LIST(new Request(`http://localhost/api/nexo/conflicts?workspace_id=${ws.id}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conflicts: [] });
    const activity = await ACTIVITY(new Request(`http://localhost/api/integrations/activity?workspace_id=${ws.id}`));
    expect(await activity.json()).toEqual({ activity: [] });
  });

  it("validates the query", async () => {
    const res = await LIST(new Request("http://localhost/api/nexo/conflicts?workspace_id=nope"));
    expect(res.status).toBe(400);
    const status = await LIST(new Request(`http://localhost/api/nexo/conflicts?workspace_id=${workspace().id}&status=weird`));
    expect(status.status).toBe(400);
  });
});

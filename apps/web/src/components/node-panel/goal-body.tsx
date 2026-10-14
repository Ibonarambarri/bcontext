"use client";

/**
 * The body of a goal in the panel: scope, horizon, progress and key
 * results (`GoalOverview`, editable — the current value of each key result
 * in place, add and remove), then the prose where the argument for the
 * goal lives. Health is not repeated here: the identity strip above
 * already owns it, so the overview hides its own health control.
 */

import { GoalOverview } from "@/components/goal-node-view";
import { PanelProse } from "./prose-body";
import type { PanelBodyProps } from "./panel-body";

export function GoalBody(props: PanelBodyProps) {
  const { payload, canWrite, onWritten } = props;
  return (
    <div className="flex flex-col gap-4">
      <GoalOverview node={payload.node} editable={canWrite} showHealth={false} onWritten={onWritten} />
      <PanelProse {...props} />
    </div>
  );
}

"use client";

/**
 * The company's projects, as one table an administrator reads downward.
 *
 * The old tab was a stack of expandable rows, each carrying the workspace's
 * address, its creation date and a per-person access matrix. Two of those
 * were wrong here. The address is not a fact about a project, it is a way of
 * reaching one, and reaching one is what the hub behind this dialog is for;
 * the access matrix was the Users section transposed, and two editable views
 * of one membership are two views that can disagree. So this section is a
 * read: who reaches each project, how much context it holds, and what it
 * consumed. Access is still written — from Users, through the same member
 * endpoint — which is why this section takes no `onChanged` and performs no
 * write of its own. The one thing it starts is a new project: the button
 * hands over to the hub's create dialog with this organization already
 * chosen, because everyone who can open this panel may create one, and "go
 * back to the hub and find the button" was a loop people fell into.
 *
 * Rows are ordered by the context they hold, largest first. An administrator
 * opening this is asking where the company's knowledge actually is, not
 * looking up a name they already know — a company has few enough projects
 * that finding one by eye is not the constraint. Node counts come with the
 * organization rather than with the counters, so the order does not reshuffle
 * under the reader when usage arrives a moment later.
 */

import { useMemo } from "react";
import { Plus } from "lucide-react";
import { Button, Table } from "@heroui/react";
import type {
  OrgAdminDetail,
  OrgAdminWorkspace,
  OrgUsage,
  OrgUsageWorkspace,
} from "@bcontext-dev/contract/organizations";
import { NoRows } from "@/components/admin/list-ui";
import {
  Block,
  SectionHead,
  formatInt,
  monthLabel,
  relAgo,
} from "./panel-ui";

export function WorkspacesSection({
  detail,
  usage,
  onCreate,
}: {
  detail: OrgAdminDetail;
  usage: OrgUsage | null;
  /** Open the hub's create dialog for this organization. */
  onCreate: () => void;
}): React.JSX.Element {
  const rows = useMemo(
    () =>
      detail.workspaces.toSorted(
        (a, b) => b.node_count - a.node_count || a.name.localeCompare(b.name),
      ),
    [detail.workspaces],
  );

  const measured = useMemo(
    () => new Map((usage?.workspaces ?? []).map((w) => [w.id, w])),
    [usage],
  );

  return (
    <>
      <SectionHead
        title="Workspaces"
        hint={`The projects ${detail.name} holds, largest first. One workspace per product, team or client, with its own members and agents.`}
        action={
          <Button size="sm" onPress={onCreate}>
            <Plus size={14} /> New workspace
          </Button>
        }
      />

      {rows.length === 0 ? (
        <NoRows
          title="No workspaces yet"
          description="The first one appears here as soon as it exists."
        />
      ) : (
        <Block
          title={
            usage
              ? `${rows.length} ${rows.length === 1 ? "project" : "projects"}, measured in ${monthLabel(usage.period)}`
              : `${rows.length} ${rows.length === 1 ? "project" : "projects"}`
          }
          hint={
            usage
              ? "People counts everyone who can reach a project: the members granted it plus the organization's owners and admins, whose role lets them in without a grant."
              : "People counts everyone who can reach a project: the members granted it plus the organization's owners and admins, whose role lets them in without a grant. The monthly figures arrive with the counters, which are not available for this organization yet."
          }
        >
          <Table>
            <Table.ScrollContainer>
              <Table.Content
                aria-label="Workspaces"
                className="min-w-[680px] whitespace-nowrap"
              >
                <Table.Header>
                  <Table.Column isRowHeader>Workspace</Table.Column>
                  <Table.Column>People</Table.Column>
                  <Table.Column>Nodes</Table.Column>
                  <Table.Column>Created</Table.Column>
                  <Table.Column>Edited</Table.Column>
                  <Table.Column>Agent reads</Table.Column>
                </Table.Header>
                <Table.Body>
                  {rows.map((workspace) => (
                    <WorkspaceRow
                      key={workspace.id}
                      workspace={workspace}
                      measured={measured.get(workspace.id)}
                    />
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </Block>
      )}
    </>
  );
}

function WorkspaceRow({
  workspace,
  measured,
}: {
  workspace: OrgAdminWorkspace;
  /** The counters for this project, when the counters loaded at all. */
  measured: OrgUsageWorkspace | undefined;
}) {
  return (
    <Table.Row id={workspace.id}>
      <Table.Cell>
        <div className="max-w-[260px]">
          <div className="truncate text-[13px] text-foreground">
            {workspace.name}
          </div>
          <div className="truncate text-[12px] text-muted">
            created {relAgo(workspace.created_at)}
          </div>
        </div>
      </Table.Cell>

      <Table.Cell className="tabular-nums">
        {formatInt(workspace.member_count)}
      </Table.Cell>

      <Table.Cell>
        <div className="tabular-nums text-foreground">
          {formatInt(workspace.node_count)}
        </div>
      </Table.Cell>

      <MonthCell value={measured?.nodes_created} />
      <MonthCell value={measured?.nodes_edited} />
      <MonthCell value={measured?.mcp_calls} />
    </Table.Row>
  );
}

/**
 * One month's figure, or the em dash that says it was never counted — which
 * is a different fact from zero, and the one the counters being absent
 * actually supports.
 */
function MonthCell({ value }: { value: number | undefined }) {
  return (
    <Table.Cell className="tabular-nums">
      {value === undefined ? (
        <span className="text-muted">—</span>
      ) : (
        formatInt(value)
      )}
    </Table.Cell>
  );
}

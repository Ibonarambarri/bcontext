import { describe, expect, it } from "vitest";
import { ORG_LAYER_THRESHOLD, showOrgLayer } from "./org-layer";

const org = (
  id: string,
  workspace_count: number,
  member_count: number,
) => ({ id, workspace_count, member_count });

const ws = (id: string) => ({ organization: { id } });

describe("showOrgLayer", () => {
  it("hides the level for one person with one workspace", () => {
    expect(
      showOrgLayer({ organizations: [org("acme", 1, 1)], workspaces: [ws("acme")] }),
    ).toBe(false);
  });

  it("shows it as soon as a second workspace exists", () => {
    expect(
      showOrgLayer({
        organizations: [org("acme", 2, 1)],
        workspaces: [ws("acme"), ws("acme")],
      }),
    ).toBe(true);
  });

  it("shows it as soon as a second person joins", () => {
    expect(
      showOrgLayer({ organizations: [org("acme", 1, 2)], workspaces: [ws("acme")] }),
    ).toBe(true);
  });

  it("shows it when the person reaches two organizations", () => {
    expect(
      showOrgLayer({
        organizations: [org("acme", 1, 1), org("bolt", 1, 1)],
        workspaces: [ws("acme"), ws("bolt")],
      }),
    ).toBe(true);
  });

  it("counts workspaces the caller can see when the card does not say", () => {
    expect(showOrgLayer({ workspaces: [ws("acme"), ws("acme")] })).toBe(true);
    expect(showOrgLayer({ workspaces: [ws("acme")] })).toBe(false);
  });

  it("trusts the organization card over what the caller may reach", () => {
    // Two workspaces exist; this person is only in one of them. The company
    // is real either way, so the level shows.
    expect(
      showOrgLayer({ organizations: [org("acme", 2, 1)], workspaces: [ws("acme")] }),
    ).toBe(true);
  });

  it("hides it when there is nothing at all", () => {
    expect(showOrgLayer({})).toBe(false);
    expect(showOrgLayer({ organizations: [], workspaces: [] })).toBe(false);
  });

  it("names the threshold it applies", () => {
    expect(ORG_LAYER_THRESHOLD).toBe(2);
  });
});

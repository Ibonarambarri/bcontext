/**
 * Typed accessors over localStorage for client-only, dev-convenience settings.
 *
 * These are explicitly NOT a source of truth: env always wins on the server.
 * The UI reads these for purely presentational concerns (density, text size,
 * panel size, the last view opened per workspace). Anything about WHO the
 * person is belongs to the account, not to this browser.
 */

import {
  DEFAULT_WORKSPACE_NAVIGATION,
  type WorkspaceNavigationPreference,
} from "./view-shell";
import { isNodePanelSize, type NodePanelSize } from "./node-selection";

export type Density = "compact" | "cozy" | "comfortable";

export type TextScale = "default" | "large" | "xlarge";

const KEY_PROFILE = "bctx:user-profile";
const KEY_DENSITY = "bctx:density";
const KEY_TEXT_SCALE = "bctx:text-scale";
/**
 * Legacy keys (pre-rebrand). Reads fall back to these so existing users
 * don't lose their settings on the rename day. Writes go to the new
 * keys only.
 */
const LEGACY_KEY_PROFILE = "bcontext:user-profile";
const LEGACY_KEY_DENSITY = "bcontext:density";
const KEY_ACTIVITY_KINDS = "ctx:activity:kinds";
const KEY_WORKSPACE_NAV_PREFIX = "ctx:workspace-navigation:v1:";
const KEY_NODE_PANEL_PREFIX = "ctx:node-panel:v1:";

function safeRead(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // quota / disabled storage — silently ignore
  }
}

function safeRemove(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/*
 * No `profile` store here on purpose. A display name only this browser knew
 * meant a colleague opening the same workspace saw the email address, and
 * clearing site data erased the person. The name is part of the account
 * (`first_name` / `last_name`, `GET /api/me`); the legacy key is only kept so
 * sign-out can remove it.
 */

const DENSITIES: Density[] = ["compact", "cozy", "comfortable"];

export const density = {
  get(): Density {
    const raw = safeRead(KEY_DENSITY) ?? safeRead(LEGACY_KEY_DENSITY);
    if (raw && (DENSITIES as string[]).includes(raw)) return raw as Density;
    return "cozy";
  },
  set(d: Density): void {
    safeWrite(KEY_DENSITY, d);
  },
};

const TEXT_SCALES: TextScale[] = ["default", "large", "xlarge"];

export const textScale = {
  get(): TextScale {
    const raw = safeRead(KEY_TEXT_SCALE);
    if (raw && (TEXT_SCALES as string[]).includes(raw)) return raw as TextScale;
    return "default";
  },
  set(t: TextScale): void {
    safeWrite(KEY_TEXT_SCALE, t);
  },
};

/** Default size of the floating node panel, isolated by user id. */
export const nodePanelSizePreference = {
  get(userId: string): NodePanelSize {
    const raw = safeRead(KEY_NODE_PANEL_PREFIX + userId);
    return isNodePanelSize(raw) ? raw : "half";
  },
  set(userId: string, size: NodePanelSize): void {
    safeWrite(KEY_NODE_PANEL_PREFIX + userId, size);
  },
};

/** The last view opened, per workspace ref; malformed storage falls back to defaults. */
export const workspaceNavigation = {
  get(workspaceRef: string): WorkspaceNavigationPreference {
    const raw = safeRead(KEY_WORKSPACE_NAV_PREFIX + workspaceRef);
    if (!raw) return { ...DEFAULT_WORKSPACE_NAVIGATION };
    try {
      const parsed = JSON.parse(raw) as Partial<WorkspaceNavigationPreference>;
      return {
        last_view_slug:
          typeof parsed.last_view_slug === "string" && parsed.last_view_slug.length > 0
            ? parsed.last_view_slug
            : "overview",
      };
    } catch {
      return { ...DEFAULT_WORKSPACE_NAVIGATION };
    }
  },
  set(workspaceRef: string, value: WorkspaceNavigationPreference): void {
    safeWrite(KEY_WORKSPACE_NAV_PREFIX + workspaceRef, JSON.stringify(value));
  },
};

/** Clear all bcontext local settings. Used by the "Sign out" stub. */
export function clearAllLocalSettings(): void {
  safeRemove(KEY_PROFILE);
  safeRemove(LEGACY_KEY_PROFILE);
  safeRemove(KEY_DENSITY);
  safeRemove(KEY_ACTIVITY_KINDS);
}

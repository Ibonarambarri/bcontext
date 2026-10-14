"use client";

/**
 * The TipTap side of live collaboration: the extension the node editor adds
 * when a `CollabProvider` is attached, binding ProseMirror to the shared Yjs
 * document and painting remote carets from the awareness protocol.
 */

import { Extension } from "@tiptap/core";
import * as Y from "yjs";
import {
  ySyncPlugin,
  yCursorPlugin,
  yUndoPlugin,
  undo as yUndo,
  redo as yRedo,
} from "y-prosemirror";
import type { Awareness } from "y-protocols/awareness";

/** The awareness `user` field peers publish; what a remote caret is painted from. */
export interface CollabPeerInfo {
  name: string;
  color: string;
}

/**
 * Build the cursor caret + name-tag overlay for a remote peer. The caret is
 * a 2px coloured rail; the label sits above it and fades in. Both are
 * `pointer-events: none` so they never steal clicks from the editor.
 */
function cursorBuilder(user: CollabPeerInfo | undefined) {
  const cursor = document.createElement("span");
  cursor.classList.add("y-cursor");
  const safe = user ?? { name: "Guest", color: "#888" };
  cursor.setAttribute("style", `border-color: ${safe.color};`);
  const label = document.createElement("div");
  label.classList.add("y-cursor-label");
  label.setAttribute(
    "style",
    `background-color: ${safe.color}; color: ${pickLabelInk(safe.color)};`,
  );
  label.textContent = safe.name;
  cursor.appendChild(label);
  return cursor;
}

function pickLabelInk(bg: string): string {
  // Pull RGB out of "#rrggbb" and use perceived luminance to pick black/white.
  if (!/^#[0-9a-f]{6}$/i.test(bg)) return "#fff";
  const r = parseInt(bg.slice(1, 3), 16);
  const g = parseInt(bg.slice(3, 5), 16);
  const b = parseInt(bg.slice(5, 7), 16);
  const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return l > 0.6 ? "#111" : "#fff";
}

/** `field` names the Y.XmlFragment in `doc` the editor binds to. */
export interface CollabOptions {
  doc: Y.Doc;
  field: string;
  awareness: Awareness;
}

/**
 * TipTap extension that mounts Yjs's three ProseMirror plugins:
 *  - ySyncPlugin: keeps the editor doc in sync with the Y.XmlFragment
 *  - yCursorPlugin: paints remote selections via the awareness protocol
 *  - yUndoPlugin: per-client undo stack that ignores remote ops
 *
 * Pair with StarterKit configured to disable `history` — Yjs has its own
 * undo manager and two undo histories make typing feel weird.
 */
export const Collab = Extension.create<CollabOptions>({
  name: "collab",

  addOptions() {
    return {
      doc: null as unknown as Y.Doc,
      field: "prosemirror",
      awareness: null as unknown as Awareness,
    };
  },

  addProseMirrorPlugins() {
    const { doc, field, awareness } = this.options;
    const fragment = doc.getXmlFragment(field);
    return [
      ySyncPlugin(fragment),
      yCursorPlugin(awareness, {
        cursorBuilder: (user: unknown) =>
          cursorBuilder(user as CollabPeerInfo | undefined),
      }),
      yUndoPlugin(),
    ];
  },

  addKeyboardShortcuts() {
    return {
      "Mod-z": () => yUndo(this.editor.state),
      "Mod-y": () => yRedo(this.editor.state),
      "Mod-Shift-z": () => yRedo(this.editor.state),
    };
  },
});

import { describe, expect, it } from "vitest";
import {
  canGoBack,
  canGoForward,
  currentNodeSelection,
  EMPTY_NODE_HISTORY,
  NODE_HISTORY_LIMIT,
  panelSizeFromLegacy,
  pushNodeHistory,
  stepNodeHistory,
} from "./node-selection";

describe("node history", () => {
  it("opens, stacks and walks back and forward", () => {
    let history = pushNodeHistory(EMPTY_NODE_HISTORY, { id: "a", blockId: null });
    history = pushNodeHistory(history, { id: "b", blockId: null });
    history = pushNodeHistory(history, { id: "c", blockId: "intro" });
    expect(currentNodeSelection(history)).toEqual({ id: "c", blockId: "intro" });
    expect(canGoBack(history)).toBe(true);
    expect(canGoForward(history)).toBe(false);

    history = stepNodeHistory(history, -1);
    expect(currentNodeSelection(history)?.id).toBe("b");
    expect(canGoForward(history)).toBe(true);
    history = stepNodeHistory(history, -1);
    expect(currentNodeSelection(history)?.id).toBe("a");
    expect(canGoBack(history)).toBe(false);
    expect(stepNodeHistory(history, -1)).toBe(history);
    history = stepNodeHistory(history, 1);
    expect(currentNodeSelection(history)?.id).toBe("b");
  });

  it("drops forward entries when a new node opens from the middle", () => {
    let history = pushNodeHistory(EMPTY_NODE_HISTORY, { id: "a", blockId: null });
    history = pushNodeHistory(history, { id: "b", blockId: null });
    history = stepNodeHistory(history, -1);
    history = pushNodeHistory(history, { id: "c", blockId: null });
    expect(history.entries.map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(canGoForward(history)).toBe(false);
  });

  it("updates the current entry in place when only the block changes", () => {
    let history = pushNodeHistory(EMPTY_NODE_HISTORY, { id: "a", blockId: null });
    const same = pushNodeHistory(history, { id: "a", blockId: null });
    expect(same).toBe(history);
    history = pushNodeHistory(history, { id: "a", blockId: "summary" });
    expect(history.entries).toHaveLength(1);
    expect(currentNodeSelection(history)?.blockId).toBe("summary");
  });

  it("caps the trail", () => {
    let history = EMPTY_NODE_HISTORY;
    for (let index = 0; index < NODE_HISTORY_LIMIT + 10; index++) {
      history = pushNodeHistory(history, { id: `n${index}`, blockId: null });
    }
    expect(history.entries).toHaveLength(NODE_HISTORY_LIMIT);
    expect(currentNodeSelection(history)?.id).toBe(`n${NODE_HISTORY_LIMIT + 9}`);
  });
});

describe("panelSizeFromLegacy", () => {
  it("maps the retired open modes and passes sizes through", () => {
    expect(panelSizeFromLegacy("half")).toBe("half");
    expect(panelSizeFromLegacy("full")).toBe("full");
    expect(panelSizeFromLegacy("preview_popup")).toBe("half");
    expect(panelSizeFromLegacy("side_panel_directly")).toBe("half");
    expect(panelSizeFromLegacy("full_node_directly")).toBe("full");
    expect(panelSizeFromLegacy("preview_then_full_node")).toBe("full");
    expect(panelSizeFromLegacy("nonsense")).toBeNull();
    expect(panelSizeFromLegacy(undefined)).toBeNull();
  });
});

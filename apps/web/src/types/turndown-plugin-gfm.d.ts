/**
 * Ambient types for `turndown-plugin-gfm`, which ships none. Only the plugins
 * the HTML→markdown path (`@/lib/markdown`) actually registers are declared.
 */
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export const gfm: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
}

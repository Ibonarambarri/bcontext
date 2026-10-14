/**
 * A link that names a node — `/n/<id>`, with or without the workspace prefix,
 * `#block` allowed — as written by people in node bodies and by Nexo in its
 * answers. Both renderers open these in the panel instead of navigating, so
 * the parser lives here rather than in either of them.
 */
const NODE_LINK = /(?:^|\/)n\/([A-Za-z0-9-]+)(?:[?#]([^?#]*))?$/;

/** The node id (and block, if any) an href names; null for anything that is not a node link. */
export function parseNodeLink(
  href: string | undefined,
): { id: string; blockId: string | null } | null {
  if (!href || (/^(https?:)?\/\//i.test(href) && !href.includes("/n/"))) return null;
  let path = href;
  try {
    if (/^https?:\/\//i.test(href)) {
      const url = new URL(href);
      if (typeof window !== "undefined" && url.origin !== window.location.origin) return null;
      path = `${url.pathname}${url.hash}`;
    }
  } catch {
    return null;
  }
  const match = NODE_LINK.exec(path.replace(/\?[^#]*/, ""));
  if (!match) return null;
  return { id: match[1]!, blockId: match[2] ? decodeURIComponent(match[2]) : null };
}

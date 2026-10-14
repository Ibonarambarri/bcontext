/**
 * `/sitemap.xml` — the public docs pages, nothing behind a session, on this
 * instance's own origin (`appOrigin`).
 */
import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { appOrigin } from "@/web/public-origin";

const STATIC_PAGES = [
  "/docs",
  "/docs/quickstart",
  "/docs/api",
  "/docs/skills",
  "/docs/connectors",
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = appOrigin(await headers());
  const now = new Date();
  return STATIC_PAGES.map((path) => ({
    url: `${base}${path}`,
    lastModified: now,
    changeFrequency: "weekly" as const,
    priority: 0.7,
  }));
}

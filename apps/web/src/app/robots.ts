/**
 * `/robots.txt`. Only the public docs are worth crawling; the product itself
 * (`/w/`, `/admin`) and the proxied API are kept out. The sitemap URL is this
 * instance's own origin (`appOrigin`), never a hard-coded domain.
 */
import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { appOrigin } from "@/web/public-origin";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const base = appOrigin(await headers());
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/w/", "/admin"],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}

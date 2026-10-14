import type { MetadataRoute } from "next";

// Web app manifest — drives "Add to Home Screen" on mobile (icon, name,
// standalone chrome, splash colours). Next serves this at /manifest.webmanifest
// and auto-links it from <head>.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Bcontext",
    short_name: "Bcontext",
    description:
      "AI-native operating system for project context. Markdown + JSON + RAG, for humans and agents.",
    id: "/",
    start_url: "/workspaces",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0f0f0f",
    theme_color: "#0f0f0f",
    categories: ["productivity", "business", "developer"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

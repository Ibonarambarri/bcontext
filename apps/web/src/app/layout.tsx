/**
 * Root layout of the web app: global CSS, the font variables on `<html>`,
 * the theme script that runs before paint (no flash of the wrong theme), the
 * browser-side error reporter and the UI locale for React Aria (`AppLocale`). Everything below it — auth pages, the
 * hub, `/w/<org>/<ws>` — brings its own shell.
 */
import type { Metadata, Viewport } from "next";
import "./globals.css";
import Script from "next/script";
import { ThemeScript } from "@/components/theme-script";
import { ClientErrorReporter } from "@/components/client-error-reporter";
import { AppLocale } from "@/components/app-locale";
import { authFontVars, fieldFontVars } from "@/lib/fonts";


export const metadata: Metadata = {
  applicationName: "Bcontext",
  title: {
    default: "Bcontext",
    template: "%s · Bcontext",
  },
  description:
    "AI-native operating system for project context. Markdown + JSON + RAG, for humans and agents.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Bcontext",
    statusBarStyle: "default",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Allow zoom for accessibility but keep the app from rubber-banding on iOS.
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: "#0f0f0f",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${fieldFontVars} ${authFontVars}`}
    >
      <head>
        <ThemeScript />
        {/* Runtime instance settings (@/lib/public-env), before any client code runs. */}
        <Script src="/env.js" strategy="beforeInteractive" />
      </head>
      <body className="antialiased">
        <ClientErrorReporter />
        <AppLocale>{children}</AppLocale>
      </body>
    </html>
  );
}

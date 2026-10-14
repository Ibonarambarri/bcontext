"use client";

/**
 * Pins React Aria's locale to the UI's language. The UI is English, but React
 * Aria otherwise takes the browser's locale for the strings it renders itself
 * — the screen-reader "Dismiss" button every modal carries came out as
 * "Descartar" for a Spanish browser. Mounted once by the root layout; dates
 * and numbers follow the same locale, which is what an English UI wants.
 */
import type { ReactNode } from "react";
import { I18nProvider } from "react-aria/I18nProvider";

export function AppLocale({ children }: { children: ReactNode }) {
  return <I18nProvider locale="en-US">{children}</I18nProvider>;
}

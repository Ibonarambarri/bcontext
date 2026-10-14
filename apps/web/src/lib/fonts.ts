/**
 * The two Google-font sets the app loads through `next/font`, exposed as CSS
 * variable class strings the root layout puts on `<html>`. Which family a
 * surface uses is decided in CSS (`globals.css`), not here.
 */
import {
  Bricolage_Grotesque,
  Figtree,
  IBM_Plex_Sans,
  IBM_Plex_Serif,
  Martian_Mono,
} from "next/font/google";

/**
 * The field type system, shared with the landing:
 *   display  Bricolage Grotesque (--f-bricolage)
 *   body     Figtree             (--f-figtree)
 *   micro    Martian Mono        (--f-martian-mono)
 * Loaded once in the root layout; surfaces adopt them progressively.
 */

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--f-bricolage",
  display: "swap",
});

const figtree = Figtree({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--f-figtree",
  display: "swap",
});

const martianMono = Martian_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--f-martian-mono",
  display: "swap",
});

export const fieldFontVars = `${bricolage.variable} ${figtree.variable} ${martianMono.variable}`;

/**
 * The auth type system, shared with the landing's home page: one
 * superfamily, IBM Plex Sans for everything and the serif italic for the
 * highlighted word in a title.
 */

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--f-plex-sans",
  display: "swap",
});

const plexSerif = IBM_Plex_Serif({
  subsets: ["latin"],
  weight: ["400"],
  style: ["italic"],
  variable: "--f-plex-serif",
  display: "swap",
});

export const authFontVars = `${plexSans.variable} ${plexSerif.variable}`;

---
name: Bcontext
description: AI-native context layer for teams and agents.
colors:
  steady-moss:       "oklch(60% 0.13 145)"
  steady-moss-dim:   "oklch(60% 0.13 145 / 0.12)"
  reference-blue:    "oklch(60% 0.13 250)"
  signal-orange:     "oklch(62% 0.13 30)"
  paper:             "oklch(98% 0.005 80)"
  paper-2:           "oklch(96.5% 0.006 80)"
  paper-3:           "oklch(94% 0.007 80)"
  line:              "oklch(88% 0.008 80)"
  line-strong:       "oklch(78% 0.01 80)"
  ink:               "oklch(15% 0.01 80)"
  ink-2:             "oklch(32% 0.01 80)"
  ink-3:             "oklch(50% 0.01 80)"
  ink-mute:          "oklch(62% 0.012 80)"
typography:
  display:
    fontFamily:    "Instrument Serif, Georgia, serif"
    fontSize:      "clamp(48px, 7vw, 88px)"
    fontWeight:    400
    lineHeight:    1.02
    letterSpacing: "-0.025em"
  headline:
    fontFamily:    "Instrument Serif, Georgia, serif"
    fontSize:      "clamp(36px, 4.5vw, 56px)"
    fontWeight:    400
    lineHeight:    1.05
    letterSpacing: "-0.02em"
  title:
    fontFamily:    "Geist, ui-sans-serif, sans-serif"
    fontSize:      "21px"
    fontWeight:    600
    lineHeight:    1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily:    "Geist, ui-sans-serif, sans-serif"
    fontSize:      "15px"
    fontWeight:    400
    lineHeight:    1.65
    letterSpacing: "normal"
  label:
    fontFamily:    "Geist Mono, ui-monospace, monospace"
    fontSize:      "11px"
    fontWeight:    500
    lineHeight:    1.5
    letterSpacing: "0.06em"
rounded:
  sm:   "4px"
  md:   "6px"
  lg:   "10px"
  xl:   "14px"
  pill: "999px"
spacing:
  "1": "6px"
  "2": "10px"
  "3": "16px"
  "4": "24px"
  "5": "36px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor:       "{colors.paper}"
    rounded:         "{rounded.md}"
    padding:         "0 14px"
    height:          "36px"
  button-primary-hover:
    backgroundColor: "oklch(22% 0.01 80)"
    textColor:       "{colors.paper}"
    rounded:         "{rounded.md}"
    padding:         "0 14px"
    height:          "36px"
  button-accent:
    backgroundColor: "{colors.steady-moss}"
    textColor:       "oklch(98% 0 0)"
    rounded:         "{rounded.md}"
    padding:         "0 14px"
    height:          "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor:       "{colors.ink}"
    rounded:         "{rounded.md}"
    padding:         "0 14px"
    height:          "36px"
  button-ghost-hover:
    backgroundColor: "{colors.paper-2}"
    textColor:       "{colors.ink}"
    rounded:         "{rounded.md}"
    padding:         "0 14px"
    height:          "36px"
  input-field:
    backgroundColor: "{colors.paper}"
    textColor:       "{colors.ink}"
    rounded:         "{rounded.md}"
    padding:         "0 12px"
    height:          "36px"
---

# Design System: Bcontext

## 1. Overview

**Creative North Star: "The Operations Room"**

Bcontext's design language is built around calm authority. This is not a product that performs for its users — it is infrastructure that recedes into the background so the work can happen. Every surface, token, and component is calibrated to reduce friction rather than create impression. The palette is warm-neutral with a single structured accent. The typography pairs a precise geometric sans (Geist) for UI with an editorial serif (Instrument Serif) for moments of meaning — headings that deserve weight, numbers that deserve presence.

The system explicitly rejects: all-dark terminal aesthetics that confuse density with credibility; enterprise-blue bulk; AI-gradient chaos (purple-to-blue gradients, glassmorphism, "powered by AI" badge culture). These are styles that signal category membership instead of product quality. Bcontext's signal is clarity — the feeling that information is genuinely under control.

Density is contextual. The workspace app runs at three density settings (compact/cozy/comfortable); the marketing surface breathes more. Both modes share the same token vocabulary; the difference is scale, not identity.

**Key Characteristics:**
- Warm-neutral base with a single functional accent (Steady Moss)
- Editorial serif headings; precise mono labels; sans body
- Flat by default; shadows only for structural emphasis or hover state
- Ink/paper ramp carries all hierarchy — color is never the only differentiator
- EU-native trustworthiness: data flows are visible, not hidden behind polish

## 2. Colors: The Warm Ink Palette

A warm-neutral ink-to-paper ramp anchors every surface. One structured accent — Steady Moss — carries primary actions, live indicators, and citations. Two semantic colors (Reference Blue, Signal Orange) handle system states. No other colors.

### Primary
- **Steady Moss** (`oklch(60% 0.13 145)`): The single accent. Used for primary CTAs, active states, live-status indicators, citation highlights, and the focus ring on interactive elements. Its rarity is the point — when it appears, it means something.
- **Steady Moss Dim** (`oklch(60% 0.13 145 / 0.12)`): Translucent Steady Moss. Used as background tints on accent-highlighted states, selected rows, and citation backgrounds. Never used for text.

### Secondary
- **Reference Blue** (`oklch(60% 0.13 250)`): Semantic only — write/mutation operations in the agent surface, info states, code syntax keywords. Never decorative.

### Tertiary
- **Signal Orange** (`oklch(62% 0.13 30)`): Warning and error states. Pricing sensitivity indicators. Not used as a brand color.

### Neutral
- **Paper** (`oklch(98% 0.005 80)`): Page background, primary surface. The warm hue (hue 80) is intentional — not cream, not pure white; the warmth of a working document.
- **Paper 2** (`oklch(96.5% 0.006 80)`): Slightly recessed surface. Sidebars, sub-panels, input backgrounds in context.
- **Paper 3** (`oklch(94% 0.007 80)`): Muted background. Code blocks, inactive states, dense table rows.
- **Line** (`oklch(88% 0.008 80)`): Default border and divider.
- **Line Strong** (`oklch(78% 0.01 80)`): Emphasized border for focused or hovered controls; blockquote rules.
- **Ink** (`oklch(15% 0.01 80)`): Primary text. Headings, labels, data.
- **Ink 2** (`oklch(32% 0.01 80)`): Secondary text. Body copy, descriptions, subtitles.
- **Ink 3** (`oklch(50% 0.01 80)`): Tertiary text. Hints, disabled labels, supporting metadata.
- **Ink Mute** (`oklch(62% 0.012 80)`): Placeholder text, timestamp tails, de-emphasized mono labels.

**The Rarity Rule.** Steady Moss appears on ≤10% of any given screen. Its value comes from scarcity — overuse collapses the signal. If a third element on a page is reaching for the accent, one of them is wrong.

**The Mono Rule.** Warm paper (hue 80) and warm ink (hue 80) stay in the same hue family. Don't introduce cool-tinted neutrals (hue 200–260) except for Reference Blue's semantic role. Cross-hue neutral mixing reads as incoherence, not richness.

## 3. Typography: The Precision-Serif Pairing

**Display / Headline Font:** Instrument Serif (400 regular + italic), with Georgia, serif fallback.
**Body / UI Font:** Geist Sans (300–700), with ui-sans-serif, system-ui fallback.
**Label / Code Font:** Geist Mono (400–600), with ui-monospace, Menlo, Consolas fallback.

**Character:** Instrument Serif carries editorial soul — it appears at heading scale where weight and personality belong, and retreats when precision is needed. Geist Sans runs the UI: tight, legible, neutral without being cold. Geist Mono anchors the technical layer — file paths, API names, metrics, keyboard shortcuts — creating a clear three-register vocabulary. The three families never compete because they occupy distinct semantic roles.

### Hierarchy

- **Display** (Instrument Serif 400, `clamp(48px, 7vw, 88px)`, line-height 1.02, tracking −0.025em): Hero section headings only. Never inside the workspace app. Italic variants carry emotional emphasis (`em` inside headings).
- **Headline** (Instrument Serif 400, `clamp(36px, 4.5vw, 56px)`, line-height 1.05, tracking −0.02em): Section headings on marketing pages, feature zone titles, pillar titles. `font-style: italic` for the serif variant of `.serif-titles` mode.
- **Title** (Geist Sans 600, 21px, line-height 1.3, tracking −0.01em): Page section headers within the app, modal titles, content node titles (sans variant). Geist Mono at 14px for API/function names.
- **Body** (Geist Sans 400, 15px app / 15.5–18px marketing, line-height 1.65): All prose. Max line length 65–75ch; wider only for data tables. Secondary body (Ink 2) for supporting copy; primary body (Ink) for content nodes.
- **Label** (Geist Mono 400–500, 10.5–13px, tracking 0.04–0.12em): Navigation items, tab labels, metadata rows, metric keys, badge text, keyboard shortcut notation. Uppercase only for short identifiers (≤4 words) in high-information-density contexts (e.g. `PILLAR 01`, `READ`, `WRITE`). Never uppercase for body or sentence-length copy.

**The Three-Register Rule.** Serif = meaning. Sans = function. Mono = machine. Never use Instrument Serif in dense UI (sidebar tree, data tables, settings forms). Never use mono for running prose. Mixing registers within a single UI control (a button with a serif label, a metric with sans) is prohibited.

**The Restraint Rule.** Display headings are capped at 88px (`clamp` maximum). Letter-spacing floors at −0.025em — below that, letterforms collide. Use `text-wrap: balance` on h1–h3.

## 4. Elevation

The system is flat by default. Depth is expressed through tonal layering (paper → paper-2 → paper-3) and through borders (line, line-strong), not through ambient shadows. Shadows appear only as a structural signal: to lift a floating card above a base surface, to ground a dropdown above a form, or to indicate hover-lift on interactive cards.

**The Flat-By-Default Rule.** Surfaces at rest have no shadow. A shadow that appears at rest reads as permanent elevation and pulls visual weight from the places where emphasis belongs. Shadows are state.

### Shadow Vocabulary

- **Card lift** (`0 28px 80px -32px rgba(0,0,0,0.22)`): Landing page hero cards and demo frames. Large spread, negative spread-radius to keep the glow diffuse. Light mode only; reduced or removed in dark mode.
- **Floating panel** (`0 14px 40px rgba(0,0,0,0.18)`): Command palette, slash-menu popovers, dropdowns. Tighter spread than card lift.
- **Hover lift** (`translateY(-2px)` + border-color transition, no shadow): Interactive cards in the workspace. Motion, not shadow, conveys liftability.
- **MCP card shimmer** (top-edge linear gradient, animated): Accent-colored shimmer on the hero MCP terminal card. Reserved for this specific element; do not apply elsewhere.

## 5. Components

### Buttons

The button vocabulary is confident and editorial. Primary actions use the full ink weight — no gradients, no rounded-everything softness. Sizes carry meaning: `lg` (44px) for primary CTAs above the fold; default (36px) for modal and panel actions; `sm` (28px) for inline secondary actions.

- **Shape:** Gently rounded (6px, `{rounded.md}`). Not pill-shaped; not square. The 6px radius says "considered, not casual."
- **Primary** (`button-primary`): Ink background (`oklch(15% 0.01 80)`), Paper text. `0 14px` padding. `brightness(1.08)` on hover — the background lightens slightly, not a different color.
- **Accent** (`button-accent`): Steady Moss background, white text. Used for the highest-priority CTA per surface (sign-up, primary onboarding action). Maximum one accent button per screen.
- **Ghost** (`button-ghost`): Transparent background, 1px line border. Ink text. Fills to Paper 2 on hover. Used for secondary CTAs alongside a primary.
- **Link** (`button-link`): No background, no border. Ink 2 text, underline with Line Strong color. Accent-colored underline on hover. Used for tertiary navigation and in-copy actions.
- **Transitions:** `background 0.12s, color 0.12s, border-color 0.12s` — fast enough to feel responsive, slow enough to be visible.

### Cards / Containers

- **Corner Style:** `{rounded.xl}` (14px) for full cards; `{rounded.lg}` (10px) for inline embedded surfaces; `{rounded.md}` (6px) for row items and compact containers.
- **Background:** Paper 2 for sidebar/secondary surfaces; Paper for content cards. Never Paper 3 as a card background (too dark; use for code blocks and inactive states instead).
- **Borders:** 1px, color `{colors.line}`. Elevated/focused cards shift to `{colors.line-strong}`.
- **Shadow Strategy:** Card lift only on featured content (hero cards, modal dialogs). Flat for structural cards.
- **Internal Padding:** 18–28px for standard cards; 12–14px for compact inline panels.
- **Nesting Rule:** No card inside a card. Nested surfaces use background-tint only (Paper 3 inside a Paper 2 card), never a bordered container inside a bordered container.

### Inputs / Fields

- **Style:** 1px `{colors.line}` border; Paper background; `{rounded.md}` radius. Height 36px default.
- **Focus:** Border shifts to `{colors.line-strong}`. No glow ring on text inputs (the ring is reserved for keyboard-navigating interactive elements at the document level). The border shift is the signal.
- **Error:** Border `{colors.signal-orange}`. No background shift.
- **Disabled:** Ink Mute text; Paper 2 background; no border color change.
- **Placeholder text:** Ink 3 (`oklch(50% 0.01 80)`) — meets 4.5:1 contrast against Paper background. Do not use Ink Mute for placeholders in full-width inputs; contrast fails.

### Navigation (Landing)

- **Style:** Sticky top bar; Paper background; 1px bottom border (`{colors.line}`); 60px height.
- **Nav links:** Geist Sans 13.5px, Ink 2; fills to Paper 2 on hover; Ink on active/current.
- **Brand mark:** Geist Sans 600, 16px, tracking −0.015em, Ink.
- **Mobile:** Links collapse at 720px; only brand mark + CTA persist.

### Keyboard Shortcut Badge

- **Style:** Geist Mono 10.5px; Paper 3 background; 1px border (Line, Line Strong for bottom — the "keycap" treatment); 18px height; 4px radius.
- **Text color:** Ink 2. Never Ink Mute — the badge must be readable at a glance.

### Pill / Tag

- **Style:** Geist Mono 10.5px; Paper 2 background; 1px Line border; 999px (pill) radius; 18px height.
- **Accent variant:** Steady Moss Dim background, Steady Moss text, no border. Used for "live", "active", "new" status only.
- **Info variant:** Reference Blue at 10% opacity background, Reference Blue text. Used for write/mutation operation labels.

### Signature Component: MCP Terminal Card

The hero interactive card on the product/landing page. A borderless inner terminal surface (Paper background, 1px Line border, 12px radius) inside a Paper 2 card (18px radius, card-lift shadow). A shimmer animation (Steady Moss → transparent linear gradient) runs along the top edge at 3.5s intervals, simulating a live data stream. Mono type throughout. This is the single component permitted to use the shimmer pattern; no other surface uses it.

## 6. Do's and Don'ts

### Do:
- **Do** use Steady Moss for primary actions and live-status indicators only. One accent button per screen, maximum.
- **Do** use Instrument Serif for landing/marketing headings. Keep it off UI controls, form labels, table headers, and the workspace sidebar tree.
- **Do** use Geist Mono for all technical identifiers: file paths, API names, metric keys, keyboard shortcuts, status labels, version numbers.
- **Do** maintain the warm-neutral hue family (hue ~80) across the entire ink-paper ramp. Tinted neutrals should tint toward hue 80, not toward cool or pure gray.
- **Do** express hierarchy through ink-scale alone in the workspace app. Ink / Ink 2 / Ink 3 / Ink Mute is the full vocabulary; color additions require explicit justification.
- **Do** keep body text contrast at ≥4.5:1 against its background. Placeholder text included — use Ink 3, not Ink Mute, for full-width input placeholders.
- **Do** include `@media (prefers-reduced-motion: reduce)` alternatives for every animation — crossfade or instant-switch, never removed content.
- **Do** use `text-wrap: balance` on h1–h3 headings and `text-wrap: pretty` on long prose.

### Don't:
- **Don't** use all-dark backgrounds as a brand statement (the Vercel/Planetscale hacker-dark aesthetic). Dark mode is a user preference, not a personality. The dark theme uses the same warm-neutral hue family, not a cold near-black or pure #000000.
- **Don't** use gradients on text (`background-clip: text`). Prohibited across all surfaces.
- **Don't** use glassmorphism (backdrop-filter blurs on decorative containers). Reserved strictly for functional overlays where it serves the interface, not as a general visual effect.
- **Don't** use purple-to-blue gradients, neon accents, or "powered by AI" badge patterns. These are the visual language of the 2023–2025 GPT-wrapper wave. Bcontext is infrastructure; it predates trends.
- **Don't** use navy blues, corporate density-as-trust visual language, or SAP/Salesforce-era enterprise chrome. The target is a 20-person ops team, not a procurement committee.
- **Don't** use side-stripe borders (`border-left` > 1px as a colored accent). Use a background tint or a full border instead.
- **Don't** use numbered section markers (01, 02, 03) as default scaffolding on every section. Numbers earn their place only when the sequence carries information.
- **Don't** put eyebrow text (`text-transform: uppercase`, wide tracking) above every section heading. One deliberate instance per page is a system; one on every section is AI grammar.
- **Don't** use `z-index: 999` or similar arbitrary values. Maintain a semantic z-index scale: dropdown (10) → sticky (20) → modal-backdrop (30) → modal (40) → toast (50) → tooltip (60).
- **Don't** use Instrument Serif at body/label size. Below 20px, the weight and tracking are wrong for the UI register. The serif is a display and headline instrument only.

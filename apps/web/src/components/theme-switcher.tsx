"use client";

/**
 * Light / Dark / System segmented control in the user menu's footer. The
 * preference lives in `localStorage` under `bctx:theme` — the same key the
 * pre-paint `theme-script.tsx` reads — so it survives reloads without FOUC
 * and is not part of the account.
 */

import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { Monitor, Moon, Sun } from "lucide-react";

type ThemePref = "light" | "dark" | "system";

const KEY = "bctx:theme";

function readPref(): ThemePref {
  try {
    const stored = window.localStorage.getItem(KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/** Apply the resolved theme as both the `dark` class and `data-theme`. */
function applyPref(pref: ThemePref) {
  const dark =
    pref === "dark" ||
    (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

const OPTIONS: { value: ThemePref; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light theme", Icon: Sun },
  { value: "dark", label: "Dark theme", Icon: Moon },
  { value: "system", label: "Follow system theme", Icon: Monitor },
];

/** While "system" is active the OS-level change is tracked live. */
export function ThemeSwitcher() {
  // Null until mounted: the stored preference is only knowable on the
  // client, and rendering a guess would mismatch the server markup.
  const [pref, setPref] = useState<ThemePref | null>(null);

  useEffect(() => {
    setPref(readPref());
  }, []);

  useEffect(() => {
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyPref("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  function choose(next: ThemePref) {
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // localStorage blocked — apply for this session only.
    }
    setPref(next);
    applyPref(next);
  }

  return (
    <div role="group" aria-label="Theme" className="flex items-center gap-1">
      {OPTIONS.map(({ value, label, Icon }) => (
        <Button
          key={value}
          isIconOnly
          size="sm"
          variant={pref === value ? "secondary" : "ghost"}
          aria-label={label}
          aria-pressed={pref === value}
          onPress={() => choose(value)}
        >
          <Icon size={13} />
        </Button>
      ))}
    </div>
  );
}

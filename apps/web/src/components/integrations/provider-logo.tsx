"use client";

import { useState } from "react";
import { Mic, Plug } from "lucide-react";
import { cn } from "@bcontext-dev/contract/utils";

/**
 * Provider tile for the Integrations hub and marketplace: the catalog logo
 * when it loads, a monogram or the connector's own icon otherwise (a failed
 * image never leaves a broken-image glyph). Same 40px tile the Agents/Tools
 * cards use. Not the `ProviderLogo` of `@/lib/agent-providers`, which is the
 * agent-runtime (Claude, Cursor…) mark.
 */
export function ProviderLogo({
  name,
  logoUrl,
  connectorId,
  size = 40,
  className,
}: {
  name: string;
  logoUrl: string | null | undefined;
  connectorId?: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const iconSize = Math.round(size * 0.45);
  const showImage = Boolean(logoUrl) && !failed;
  return (
    <div
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-[var(--line)] bg-[var(--paper-2)]",
        className,
      )}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- third-party logos, no optimizer
        <img
          src={logoUrl!}
          alt=""
          width={iconSize + 4}
          height={iconSize + 4}
          onError={() => setFailed(true)}
          className="h-[55%] w-[55%] object-contain"
        />
      ) : connectorId === "meeting-bot" ? (
        <Mic size={iconSize} className="text-[var(--ink-2)]" />
      ) : /^[a-z0-9]/i.test(name) ? (
        <span className="text-[13px] font-semibold uppercase leading-none text-[var(--ink-2)]">
          {name.slice(0, 1)}
        </span>
      ) : (
        <Plug size={iconSize} className="text-[var(--ink-2)]" />
      )}
    </div>
  );
}

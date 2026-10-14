#!/usr/bin/env node
/**
 * install-mcp.mjs — one-command Bcontext MCP installer.
 *
 * Writes the Bcontext MCP server entry into Claude Desktop / Cursor / Cline /
 * Claude Code config files so the user doesn't have to hand-edit JSON.
 *
 * Pure Node ESM. No external deps. Streamable-HTTP form only — the
 * Bcontext server is HTTP, not stdio. Served verbatim by `GET /install/mcp`
 * (the Dockerfile copies this file into the runner image for that), so it
 * must stay self-contained and importable by nothing.
 *
 * Usage:
 *   node install-mcp.mjs [--token bctx_live_xxx]
 *                       [--workspace <org>/<workspace>]
 *                       [--url https://host/mcp]
 *                       [--name bcontext]
 *                       [--client claude-desktop|cursor|cline|claude-code|all]
 *                       [--force]
 *                       [--help]
 *
 *   curl -sSL https://<your-instance>/install/mcp | node - --token bctx_live_xxx
 *
 * The endpoint defaults to the server that served the script: `GET
 * /install/mcp` replaces the `SERVED_URL` placeholder below with its own
 * `/mcp`. Run from a checkout, the placeholder stays and the endpoint comes
 * from `--url` or `BCONTEXT_MCP_URL`.
 *
 * `--workspace` points the entry at that workspace's own endpoint
 * (`/mcp/<org>/<workspace>`) and names it `bcontext-<org>-<workspace>`, so a
 * host that serves several projects keeps one entry per workspace; `--url`
 * and `--name` still override either.
 *
 * Manual smoke check (happy path):
 *   HOME=/tmp/bctx-test node scripts/install-mcp.mjs \
 *     --token bctx_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
 *     --client claude-desktop --url http://localhost:3000/mcp --force
 *   cat "/tmp/bctx-test/Library/Application Support/Claude/claude_desktop_config.json"
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import process from "node:process";

// Replaced by `GET /install/mcp` with the serving instance's endpoint.
const SERVED_URL = "__BCONTEXT_MCP_URL__";
const DEFAULT_URL = process.env.BCONTEXT_MCP_URL || (SERVED_URL.includes("://") ? SERVED_URL : null);
const DEFAULT_NAME = "bcontext";
const TOKEN_RE = /^bctx_live_[A-Za-z0-9_-]{20,}$/;
// `<org>/<workspace>`: two slugs, the same shape the API accepts.
const WORKSPACE_RE = /^([a-z0-9][a-z0-9-]{0,79})\/([a-z0-9][a-z0-9-]{0,79})$/;

const HELP = `Bcontext MCP installer

Usage:
  node install-mcp.mjs [options]

Options:
  --token <bctx_live_...>        Bearer token (or set BCTX_TOKEN env var, or be prompted)
  --workspace <org>/<workspace>  Use that workspace's endpoint (${DEFAULT_URL ?? "<url>"}/<org>/<workspace>)
                                 and name the entry bcontext-<org>-<workspace>
  --url <https://host/mcp>       MCP endpoint URL (default: ${DEFAULT_URL ?? "BCONTEXT_MCP_URL, or the server that served this script"}; overrides --workspace)
  --name <serverKey>             Key under mcpServers (default: ${DEFAULT_NAME}; overrides --workspace)
  --client <name>                One of: claude-desktop, cursor, cline, claude-code, all
                                 (interactive prompt if omitted)
  --force                        Overwrite existing entry without confirmation
  --help, -h                     Show this help

Mint tokens in the app: Account, or Connect tools → Agent token.
Restart your MCP client after install to pick up the change.`;

/** ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const args = {
    token: null,
    workspace: null,
    url: null,
    name: null,
    client: null,
    force: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--force") {
      args.force = true;
    } else if (a === "--token") {
      args.token = argv[++i] ?? null;
    } else if (a === "--workspace") {
      args.workspace = argv[++i] ?? null;
    } else if (a === "--url") {
      args.url = argv[++i] ?? null;
    } else if (a === "--name") {
      args.name = argv[++i] ?? null;
    } else if (a === "--client") {
      args.client = argv[++i] ?? null;
    } else if (a.startsWith("--token=")) {
      args.token = a.slice("--token=".length);
    } else if (a.startsWith("--workspace=")) {
      args.workspace = a.slice("--workspace=".length);
    } else if (a.startsWith("--url=")) {
      args.url = a.slice("--url=".length);
    } else if (a.startsWith("--name=")) {
      args.name = a.slice("--name=".length);
    } else if (a.startsWith("--client=")) {
      args.client = a.slice("--client=".length);
    } else {
      die(`unknown argument: ${a}\nrun with --help for usage`);
    }
  }
  // The workspace decides the defaults; an explicit --url or --name wins.
  if (args.workspace !== null) {
    const m = WORKSPACE_RE.exec(args.workspace.trim().toLowerCase());
    if (!m) die(`--workspace must be <org>/<workspace> (two slugs), got: ${args.workspace}`);
    const [, org, workspace] = m;
    if (DEFAULT_URL) args.url ??= `${DEFAULT_URL}/${org}/${workspace}`;
    args.name ??= `${DEFAULT_NAME}-${org}-${workspace}`;
  }
  args.url ??= DEFAULT_URL;
  args.name ??= DEFAULT_NAME;
  return args;
}

/** --------------------------------------------------------------- clients */

const CLIENTS = {
  "claude-desktop": {
    label: "Claude Desktop",
    file() {
      const home = os.homedir();
      if (process.platform === "darwin") {
        return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      }
      if (process.platform === "win32") {
        const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
        return path.join(appdata, "Claude", "claude_desktop_config.json");
      }
      return path.join(home, ".config", "Claude", "claude_desktop_config.json");
    },
  },
  cursor: {
    label: "Cursor",
    file() {
      return path.join(os.homedir(), ".cursor", "mcp.json");
    },
  },
  cline: {
    label: "Cline (VS Code)",
    file() {
      const home = os.homedir();
      if (process.platform === "darwin") {
        return path.join(home, "Library", "Application Support", "cline", "cline_mcp_settings.json");
      }
      if (process.platform === "win32") {
        const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
        return path.join(appdata, "cline", "cline_mcp_settings.json");
      }
      return path.join(home, ".config", "cline", "cline_mcp_settings.json");
    },
  },
  "claude-code": {
    label: "Claude Code",
    file() {
      return path.join(os.homedir(), ".claude", "mcp.json");
    },
  },
};

const ALL_CLIENT_KEYS = Object.keys(CLIENTS);

/** ----------------------------------------------------------------- utils */

function die(msg) {
  process.stderr.write(`install-mcp: ${msg}\n`);
  process.exit(1);
}

function ok(msg) {
  process.stdout.write(`${msg}\n`);
}

function isUnderHome(p) {
  const home = path.resolve(os.homedir());
  const target = path.resolve(p);
  // ensure target equals home or is a descendant; trailing sep guard
  return target === home || target.startsWith(home + path.sep);
}

function validToken(t) {
  return typeof t === "string" && TOKEN_RE.test(t.trim());
}

function validUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** -------------------------------------------------------- stdin prompting */

function ttyAvailable() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Prompt for a secret, masking stdin echo if available. Falls back to
 * plain readline when not a TTY.
 */
async function promptSecret(label) {
  if (!ttyAvailable()) {
    return promptPlain(label);
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(`${label}: `);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw ?? false;
    try {
      stdin.setRawMode(true);
    } catch {
      // can't mask — fall back
      promptPlain(label).then(resolve, reject);
      return;
    }
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const restore = () => {
      stdin.removeListener("data", onData);
      stdin.pause();
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        // ignore
      }
    };
    const onData = (chunk) => {
      const s = String(chunk);
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          restore();
          process.stdout.write("\n");
          resolve(buf);
          return;
        }
        if (ch === "") {
          // ctrl-c
          restore();
          process.stdout.write("\n");
          reject(new Error("interrupted"));
          return;
        }
        if (ch === "" || ch === "\b") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        buf += ch;
        process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

async function promptPlain(label) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => {
      rl.question(`${label}: `, (answer) => resolve(answer));
    });
  } finally {
    rl.close();
  }
}

async function promptChoice(label, choices) {
  if (!ttyAvailable()) {
    die(`--client must be provided in non-interactive mode (one of: ${choices.join(", ")})`);
  }
  process.stdout.write(`${label}\n`);
  choices.forEach((c, i) => process.stdout.write(`  [${i + 1}] ${c}\n`));
  const ans = (await promptPlain("Pick one (number or name)")).trim();
  if (!ans) die("no client selected");
  const asNum = Number(ans);
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= choices.length) {
    return choices[asNum - 1];
  }
  if (choices.includes(ans)) return ans;
  die(`unknown choice: ${ans}`);
}

async function confirm(label) {
  if (!ttyAvailable()) return false;
  const ans = (await promptPlain(`${label} [y/N]`)).trim().toLowerCase();
  return ans === "y" || ans === "yes";
}

/** --------------------------------------------------------------- file io */

async function readJsonIfExists(file) {
  if (!existsSync(file)) return { exists: false, value: {} };
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
  const trimmed = raw.trim();
  if (!trimmed) return { exists: true, value: {} };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { exists: true, value: parsed };
    }
    throw new Error("top-level JSON is not an object");
  } catch (e) {
    throw new Error(`existing config at ${file} is not valid JSON: ${e.message}`);
  }
}

async function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}

/** ----------------------------------------------------------- install one */

async function installForClient(clientKey, { token, url, name, force }) {
  const def = CLIENTS[clientKey];
  if (!def) throw new Error(`unknown client: ${clientKey}`);
  const file = def.file();

  if (!isUnderHome(file)) {
    throw new Error(`refusing to write outside home dir: ${file}`);
  }

  const { exists, value } = await readJsonIfExists(file);
  const config = value;
  const servers =
    config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
      ? config.mcpServers
      : {};

  const already = servers[name];
  if (already && !force) {
    const sameUrl =
      already && typeof already === "object" && "url" in already && already.url === url;
    const noun = sameUrl ? `update token for "${name}"` : `replace existing "${name}" entry`;
    const proceed = await confirm(`${def.label}: ${noun}?`);
    if (!proceed) {
      ok(`  ~ ${def.label}: skipped (${file})`);
      return { skipped: true, file };
    }
  }

  servers[name] = {
    url,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };
  config.mcpServers = servers;

  await writeJsonAtomic(file, config);
  ok(`  ${exists ? "~" : "+"} ${def.label}: wrote ${name} → ${file}`);
  return { skipped: false, file };
}

/** -------------------------------------------------------------- entry */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP + "\n");
    return;
  }

  // token: arg → env → prompt
  let token = args.token || process.env.BCTX_TOKEN || "";
  token = (token || "").trim();
  if (!token) {
    try {
      token = (await promptSecret("Bcontext token (bctx_live_…)")).trim();
    } catch (e) {
      die(e instanceof Error ? e.message : String(e));
    }
  }
  if (!validToken(token)) {
    die(
      "token does not look like a valid bctx_live_ token. " +
        "Mint one in the app: Account, or Connect tools → Agent token.",
    );
  }

  if (!args.url) {
    die("no MCP endpoint: pass --url https://<your-instance>/mcp or set BCONTEXT_MCP_URL");
  }
  if (!validUrl(args.url)) {
    die(`--url must be a http(s) URL, got: ${args.url}`);
  }
  if (!args.name || typeof args.name !== "string") {
    die("--name must be a non-empty string");
  }

  // client selection
  let clients;
  if (args.client) {
    if (args.client === "all") {
      clients = ALL_CLIENT_KEYS.slice();
    } else if (CLIENTS[args.client]) {
      clients = [args.client];
    } else {
      die(`unknown --client "${args.client}". one of: ${ALL_CLIENT_KEYS.join(", ")}, all`);
    }
  } else {
    const pick = await promptChoice(
      "Which MCP client should I configure?",
      [...ALL_CLIENT_KEYS, "all"],
    );
    clients = pick === "all" ? ALL_CLIENT_KEYS.slice() : [pick];
  }

  ok("");
  ok(`Installing Bcontext MCP server "${args.name}" → ${args.url}`);
  ok("");

  let wrote = 0;
  let skipped = 0;
  const failures = [];
  for (const c of clients) {
    try {
      const res = await installForClient(c, {
        token,
        url: args.url,
        name: args.name,
        force: args.force,
      });
      if (res.skipped) skipped++;
      else wrote++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ client: c, msg });
      ok(`  ! ${CLIENTS[c]?.label ?? c}: ${msg}`);
    }
  }

  ok("");
  ok(`Done. ${wrote} written, ${skipped} skipped, ${failures.length} failed.`);
  if (wrote > 0) {
    ok("Restart your MCP client to pick up the change.");
  }
  if (failures.length > 0) {
    process.exit(2);
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  die(msg);
});

/**
 * A minimal MCP client for a terminal, so an agent (or a person) can use
 * Bcontext's tools without an MCP-capable host:
 *
 *   BCONTEXT_MCP_URL=http://localhost:4000/mcp BCONTEXT_MCP_TOKEN=bctx_live_… \
 *     node scripts/mcp-client.mjs tools/list
 *   node scripts/mcp-client.mjs tools/call nodes '{"op":"list","kind":"task"}'
 *   node scripts/mcp-client.mjs tools/call nodes_write '{"op":"create","title":"…","kind":"decision"}'
 *
 * Prints the tool's result text (JSON) to stdout; errors to stderr with a
 * non-zero exit. The server is stateless JSON over Streamable HTTP, so every
 * call is one POST; `initialize` is sent first so server instructions are
 * available with `node scripts/mcp-client.mjs initialize`.
 *
 * Node built-ins only; works against the local API (default) or any
 * instance (`BCONTEXT_MCP_URL=https://<your-instance>/mcp`) with an agent token.
 * `BCONTEXT_WORKSPACE` selects the workspace when the token spans several.
 */
const url = process.env.BCONTEXT_MCP_URL ?? "http://localhost:4000/mcp";
const token = process.env.BCONTEXT_MCP_TOKEN;
if (!token) { console.error("BCONTEXT_MCP_TOKEN is required"); process.exit(2); }
const [method, name, params] = process.argv.slice(2);
if (!method) { console.error("usage: mcp-client.mjs <initialize|tools/list|tools/call> [tool] [json-args]"); process.exit(2); }

let rpc;
if (method === "initialize") rpc = { method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "mcp-client.mjs", version: "1" } } };
else if (method === "tools/list") rpc = { method: "tools/list", params: {} };
else if (method === "tools/call") { if (!name) { console.error("tools/call needs a tool name"); process.exit(2); } rpc = { method: "tools/call", params: { name, arguments: params ? JSON.parse(params) : {} } }; }
else { console.error(`unknown method ${method}`); process.exit(2); }

const res = await fetch(url, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...(process.env.BCONTEXT_WORKSPACE ? { "x-bcontext-workspace": process.env.BCONTEXT_WORKSPACE } : {}) },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...rpc }),
});
const text = await res.text();
if (!res.ok) { console.error(`HTTP ${res.status}: ${text.slice(0, 500)}`); process.exit(1); }
const msg = JSON.parse(text);
if (msg.error) { console.error(`RPC error ${msg.error.code}: ${msg.error.message}`); process.exit(1); }
const r = msg.result;
if (method === "tools/list") { for (const t of r.tools) console.log(`${t.name}\n  ${t.description}\n`); }
else if (method === "tools/call") { for (const c of r.content ?? []) console.log(c.type === "text" ? c.text : JSON.stringify(c)); if (r.isError) process.exit(1); }
else console.log(JSON.stringify(r, null, 2));

// Shared by the test scripts: connect to the deployed Worker (or a local bundle) through the real MCP protocol.
// Reads .mcp-local.json in the repo root (gitignored; copy .mcp-local.example.json). MCP_BASE overrides the base URL.
// The Worker only lets these scripts in while MCP_ALLOW_ANY_IP is "1" — see the README, step "Test from your machine".
import { readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export function loadConfig() {
  const path = new URL("../.mcp-local.json", import.meta.url);
  let cfg;
  try { cfg = JSON.parse(readFileSync(path, "utf8")); } catch {
    throw new Error("Missing .mcp-local.json in the repo root. Copy .mcp-local.example.json and fill in your Worker URL and keys.");
  }
  for (const k of ["MCP_BASE", "MCP_PATH_SECRET", "MCP_ADMIN_KEY"]) if (!cfg[k] && !(k === "MCP_BASE" && process.env.MCP_BASE)) throw new Error(`.mcp-local.json is missing ${k}.`);
  return { ...cfg, MCP_BASE: process.env.MCP_BASE ?? cfg.MCP_BASE };
}

export async function connect(name) {
  const cfg = loadConfig();
  const client = new Client({ name, version: "0.0.1" });
  const url = new URL(`/mcp/${cfg.MCP_PATH_SECRET}`, cfg.MCP_BASE);
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { "x-mcp-key": cfg.MCP_ADMIN_KEY } } }));
  return client;
}

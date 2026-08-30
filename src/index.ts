import { createHmac, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const app = new Hono();

const ON_SHAPE_BASE_URL = (process.env.ONSHAPE_BASE_URL || "https://cad.onshape.com").replace(/\/$/, "");
const ON_SHAPE_ACCESS_KEY = process.env.ONSHAPE_ACCESS_KEY;
const ON_SHAPE_SECRET_KEY = process.env.ONSHAPE_SECRET_KEY;

function requireCredentials() {
  if (!ON_SHAPE_ACCESS_KEY || !ON_SHAPE_SECRET_KEY) {
    throw new Error("Onshape credentials are not configured.");
  }
}

function createOnshapeSignature(method: string, url: URL, nonce: string, authDate: string, contentType: string) {
  requireCredentials();
  const canonical = (method.toUpperCase() + "\n" + nonce + "\n" + authDate + "\n" + contentType + "\n" + url.pathname + "\n" + url.search.slice(1) + "\n").toLowerCase();
  const signature = createHmac("sha256", ON_SHAPE_SECRET_KEY!).update(canonical).digest("base64");
  return `On ${ON_SHAPE_ACCESS_KEY}:HmacSHA256:${signature}`;
}

async function onshapeRequest(method: "GET" | "POST" | "DELETE", path: string, query?: Record<string, string | number | boolean | undefined>, body?: unknown) {
  requireCredentials();
  if (!path.startsWith("/api/")) throw new Error("Onshape path must start with /api/.");
  const url = new URL(path, ON_SHAPE_BASE_URL);
  if (query) for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));

  const contentType = "application/json";
  const authDate = new Date().toUTCString();
  const nonce = randomBytes(18).toString("base64url");
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": contentType,
    Date: authDate,
    "On-Nonce": nonce,
    Authorization: createOnshapeSignature(method, url, nonce, authDate, contentType),
  };

  const response = await fetch(url, {
    method,
    headers,
    body: method === "GET" ? undefined : body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  return parseOnshapeResponse(response);
}

async function parseOnshapeResponse(response: Response) {
  const text = await response.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!response.ok) throw new Error(`Onshape API HTTP ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

async function toolCall(fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    return { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}

const mcpHandler = createMcpHandler((server) => {
  server.registerTool("test_connection", {
    title: "Test Onshape Connection",
    description: "Checks that the MCP server can authenticate to the configured Onshape account.",
    inputSchema: z.object({}),
  }, async () => toolCall(() => onshapeRequest("GET", "/api/v10/documents", { limit: 1 })));

  server.registerTool("list_onshape_documents", {
    title: "List Onshape Documents",
    description: "List documents visible to the configured Onshape account, optionally filtered by search text.",
    inputSchema: z.object({ q: z.string().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }),
  }, async ({ q, offset, limit }) => toolCall(() => onshapeRequest("GET", "/api/v10/documents", { q, offset: offset ?? 0, limit: limit ?? 20 })));

  server.registerTool("get_onshape_document", {
    title: "Get Onshape Document",
    description: "Get metadata for a specific Onshape document.",
    inputSchema: z.object({ documentId: z.string().min(1) }),
  }, async ({ documentId }) => toolCall(() => onshapeRequest("GET", `/api/v10/documents/${encodeURIComponent(documentId)}`)));

  server.registerTool("get_onshape_workspaces", {
    title: "Get Onshape Workspaces",
    description: "List the workspaces/branches available in an Onshape document.",
    inputSchema: z.object({ documentId: z.string().min(1) }),
  }, async ({ documentId }) => toolCall(() => onshapeRequest("GET", `/api/v10/documents/d/${encodeURIComponent(documentId)}/workspaces`)));

  server.registerTool("get_onshape_versions", {
    title: "Get Onshape Versions",
    description: "List versions in an Onshape document.",
    inputSchema: z.object({ documentId: z.string().min(1), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }),
  }, async ({ documentId, offset, limit }) => toolCall(() => onshapeRequest("GET", `/api/v10/documents/d/${encodeURIComponent(documentId)}/versions`, { offset: offset ?? 0, limit: limit ?? 20 })));

  server.registerTool("get_onshape_elements", {
    title: "Get Onshape Document Elements",
    description: "List Part Studios, Assemblies, Drawings and other elements in a workspace, version, or microversion.",
    inputSchema: z.object({ documentId: z.string().min(1), wvm: z.enum(["w", "v", "m"]).default("w"), wvmId: z.string().min(1) }),
  }, async ({ documentId, wvm, wvmId }) => toolCall(() => onshapeRequest("GET", `/api/v10/documents/d/${encodeURIComponent(documentId)}/${wvm}/${encodeURIComponent(wvmId)}/elements`)));

  server.registerTool("onshape_api", {
    title: "Onshape API",
    description: "Authenticated Onshape REST API access for advanced operations. GET, POST and DELETE are supported.",
    inputSchema: z.object({ method: z.enum(["GET", "POST", "DELETE"]), path: z.string().startsWith("/api/"), query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(), body: z.unknown().optional() }),
  }, async ({ method, path, query, body }) => toolCall(() => onshapeRequest(method, path, query, body)));
}, { serverInfo: { name: "Onshape Claude MCP", version: "2.1.0" } });

app.get("/", (c) => c.json({ name: "Onshape Claude MCP", status: "online", version: "2.1.0", onshapeConfigured: Boolean(ON_SHAPE_ACCESS_KEY && ON_SHAPE_SECRET_KEY) }));
app.all("/mcp", async (c) => mcpHandler(c.req.raw));
app.all("/mcp/*", async (c) => mcpHandler(c.req.raw));
export default app;

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
    throw new Error(
      "Onshape credentials are not configured. Set ONSHAPE_ACCESS_KEY and ONSHAPE_SECRET_KEY in Vercel Environment Variables.",
    );
  }
}

function createOnshapeSignature(
  method: string,
  url: URL,
  nonce: string,
  authDate: string,
  contentType: string,
) {
  requireCredentials();

  const canonical = (
    method.toUpperCase() +
    "\n" +
    nonce +
    "\n" +
    authDate +
    "\n" +
    contentType +
    "\n" +
    url.pathname +
    "\n" +
    url.search.slice(1) +
    "\n"
  ).toLowerCase();

  const signature = createHmac("sha256", ON_SHAPE_SECRET_KEY!)
    .update(canonical)
    .digest("base64");

  return `On ${ON_SHAPE_ACCESS_KEY}:HmacSHA256:${signature}`;
}

async function onshapeRequest(
  method: "GET" | "POST" | "DELETE",
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
  body?: unknown,
) {
  requireCredentials();

  if (!path.startsWith("/api/")) {
    throw new Error("Onshape path must start with /api/.");
  }

  const url = new URL(path, ON_SHAPE_BASE_URL);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }

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

  // Onshape can return redirects for some API operations. Re-sign the redirected URL
  // instead of forwarding the original Authorization header.
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    if (!location) throw new Error(`Onshape returned HTTP ${response.status} without a Location header.`);

    const redirectedUrl = new URL(location, ON_SHAPE_BASE_URL);
    const redirectedDate = new Date().toUTCString();
    const redirectedNonce = randomBytes(18).toString("base64url");
    const redirectedHeaders: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": contentType,
      Date: redirectedDate,
      "On-Nonce": redirectedNonce,
      Authorization: createOnshapeSignature(
        method,
        redirectedUrl,
        redirectedNonce,
        redirectedDate,
        contentType,
      ),
    };

    const redirected = await fetch(redirectedUrl, {
      method,
      headers: redirectedHeaders,
      body: method === "GET" ? undefined : body === undefined ? undefined : JSON.stringify(body),
    });

    return parseOnshapeResponse(redirected);
  }

  return parseOnshapeResponse(response);
}

async function parseOnshapeResponse(response: Response) {
  const text = await response.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Keep non-JSON responses as text.
  }

  if (!response.ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`Onshape API HTTP ${response.status}: ${detail}`);
  }

  return data;
}

const apiToolSchema = {
  method: z.enum(["GET", "POST", "DELETE"]),
  path: z.string().describe("Onshape API path beginning with /api/, for example /api/v10/documents"),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  body: z.unknown().optional(),
};

const mcpHandler = createMcpHandler(
  (server) => {
    server.registerTool(
      "test_connection",
      {
        title: "Test Onshape Connection",
        description: "Checks that the MCP server can authenticate to the configured Onshape account.",
        inputSchema: z.object({}),
      },
      async () => {
        try {
          const documents = await onshapeRequest("GET", "/api/v10/documents", { limit: 1 });
          return {
            content: [
              {
                type: "text",
                text: `Onshape authentication is working. Sample document response:\n${JSON.stringify(documents, null, 2)}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Onshape connection failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    );

    server.registerTool(
      "onshape_api",
      {
        title: "Onshape API",
        description:
          "Full authenticated access to the Onshape REST API available to the configured account. Use GET to inspect data, POST to create/update data, and DELETE to remove data. The path must begin with /api/.",
        inputSchema: z.object(apiToolSchema),
      },
      async ({ method, path, query, body }) => {
        try {
          const result = await onshapeRequest(method, path, query, body);
          return {
            content: [
              {
                type: "text",
                text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            isError: true,
          };
        }
      },
    );

    server.registerTool(
      "list_onshape_documents",
      {
        title: "List Onshape Documents",
        description: "Search and list documents visible to the configured Onshape account.",
        inputSchema: z.object({
          q: z.string().optional(),
          offset: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        }),
      },
      async ({ q, offset, limit }) => {
        try {
          const result = await onshapeRequest("GET", "/api/v10/documents", {
            q,
            offset: offset ?? 0,
            limit: limit ?? 20,
          });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return {
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          };
        }
      },
    );

    server.registerTool(
      "get_onshape_document",
      {
        title: "Get Onshape Document",
        description: "Get metadata and permissions for an Onshape document.",
        inputSchema: z.object({ documentId: z.string().min(1) }),
      },
      async ({ documentId }) => {
        try {
          const result = await onshapeRequest("GET", `/api/v10/documents/${encodeURIComponent(documentId)}`);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return {
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          };
        }
      },
    );

    server.registerTool(
      "get_onshape_elements",
      {
        title: "Get Onshape Document Elements",
        description: "List Part Studios, Assemblies, Drawings and other elements in a document workspace/version.",
        inputSchema: z.object({
          documentId: z.string().min(1),
          wvm: z.enum(["w", "v", "m"]).default("w"),
          wvmId: z.string().min(1),
        }),
      },
      async ({ documentId, wvm, wvmId }) => {
        try {
          const result = await onshapeRequest(
            "GET",
            `/api/v10/documents/d/${encodeURIComponent(documentId)}/${wvm}/${encodeURIComponent(wvmId)}/elements`,
          );
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return {
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          };
        }
      },
    );
  },
  {
    serverInfo: {
      name: "Onshape Claude MCP",
      version: "2.0.0",
    },
  },
);

app.get("/", (c) => {
  return c.json({
    name: "Onshape Claude MCP",
    status: "online",
    version: "2.0.0",
    onshapeConfigured: Boolean(ON_SHAPE_ACCESS_KEY && ON_SHAPE_SECRET_KEY),
  });
});

app.all("/mcp", async (c) => {
  return mcpHandler(c.req.raw);
});

app.all("/mcp/*", async (c) => {
  return mcpHandler(c.req.raw);
});

export default app;

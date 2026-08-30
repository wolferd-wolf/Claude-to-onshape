import { createHmac, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const app = new Hono();
const BASE = (process.env.ONSHAPE_BASE_URL || "https://cad.onshape.com").replace(/\/$/, "");
const ACCESS = process.env.ONSHAPE_ACCESS_KEY;
const SECRET = process.env.ONSHAPE_SECRET_KEY;
type Method = "GET" | "POST" | "DELETE";
const id = z.string().min(1);

function auth() {
  if (!ACCESS || !SECRET) throw new Error("Onshape credentials are not configured.");
}
function sign(method: string, url: URL, nonce: string, date: string, contentType: string) {
  auth();
  const canonical = (method.toUpperCase() + "\n" + nonce + "\n" + date + "\n" + contentType + "\n" + url.pathname + "\n" + url.search.slice(1) + "\n").toLowerCase();
  return `On ${ACCESS}:HmacSHA256:${createHmac("sha256", SECRET!).update(canonical).digest("base64")}`;
}
async function api(method: Method, path: string, query?: Record<string, unknown>, body?: unknown) {
  auth();
  if (!path.startsWith("/api/")) throw new Error("Onshape path must start with /api/.");
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const contentType = "application/json";
  const date = new Date().toUTCString();
  const nonce = randomBytes(18).toString("base64url");
  const response = await fetch(url, {
    method,
    headers: { Accept: "application/json", "Content-Type": contentType, Date: date, "On-Nonce": nonce, Authorization: sign(method, url, nonce, date, contentType) },
    body: method === "GET" ? undefined : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw new Error(`Onshape API HTTP ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}
async function call(fn: () => Promise<unknown>) {
  try {
    const value = await fn();
    return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}

const capabilityText = `Comprehensive Onshape CAD access. Supported API families include Documents, Workspaces, Versions, Microversions, Elements, Part Studios, Features, FeatureScript evaluation, sketches, parts, mass properties, bounding boxes, tessellation, Assemblies, instances, occurrences, mates, mate connectors, assembly transforms and patterns, BOM/product structure, Drawings, drawing views/annotations/tables/JSON, Configurations, Materials, Metadata/custom properties, Import/Export and translations (STEP, STL, Parasolid, glTF/GLB, OBJ and other supported translators), Blobs/files, Release Management/revisions/release candidates, Associativity, users/teams and other documented Onshape REST endpoints. The raw path mode exists so newly added Onshape endpoints can be used without changing this server.`;

const mcp = createMcpHandler(server => {
  server.registerTool("onshape_cad", {
    title: "Onshape CAD",
    description: capabilityText + " Use operation for common CAD actions or method/path for any documented endpoint. Inspect before writing; verify feature status after writes.",
    inputSchema: z.object({
      operation: z.enum([
        "list_documents","get_document","create_document","update_document","list_workspaces","list_versions","create_version","list_elements",
        "get_partstudio_features","create_partstudio","create_feature","update_feature","delete_feature","evaluate_featurescript","get_parts","get_part_metadata","get_bounding_box",
        "create_assembly","get_assembly","assembly_operation","get_configuration","update_configuration",
        "get_metadata","update_metadata","get_materials","translation_formats","create_translation","get_translation","export_partstudio","export_part","export_assembly",
        "drawing_operation","release_operation","blob_operation","associativity_operation","user_team_operation","raw"
      ]).default("raw"),
      method: z.enum(["GET","POST","DELETE"]).optional(),
      path: z.string().startsWith("/api/").optional(),
      documentId: id.optional(), workspaceId: id.optional(), elementId: id.optional(), wvmId: id.optional(), featureId: id.optional(), partId: id.optional(),
      q: z.string().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional(),
      query: z.record(z.string(), z.unknown()).optional(), body: z.unknown().optional(), feature: z.record(z.string(), z.unknown()).optional(),
      configuration: z.string().optional(), script: z.string().optional(), rollbackBarIndex: z.number().int().optional()
    })
  }, async args => {
    const a = args as Record<string, unknown>;
    const documentId = String(a.documentId || "");
    const workspaceId = String(a.workspaceId || "");
    const elementId = String(a.elementId || "");
    const wvmId = String(a.wvmId || workspaceId);
    const featureId = String(a.featureId || "");
    const partId = String(a.partId || "");
    const q = (a.query || {}) as Record<string, unknown>;
    const body = a.body;
    const operation = String(a.operation || "raw");
    const path = (a.path as string | undefined);
    const method = (a.method as Method | undefined);
    const need = (name: string, value: string) => { if (!value) throw new Error(`${name} is required for operation ${operation}.`); };

    return call(async () => {
      switch (operation) {
        case "list_documents": return api("GET", "/api/v10/documents", { q: a.q, offset: a.offset ?? 0, limit: a.limit ?? 20 });
        case "get_document": need("documentId", documentId); return api("GET", `/api/v10/documents/${encodeURIComponent(documentId)}`);
        case "create_document": return api("POST", "/api/v10/documents", undefined, body ?? { name: "Untitled" });
        case "update_document": need("documentId", documentId); return api("POST", `/api/v10/documents/${encodeURIComponent(documentId)}`, undefined, body);
        case "list_workspaces": need("documentId", documentId); return api("GET", `/api/v10/documents/d/${encodeURIComponent(documentId)}/workspaces`);
        case "list_versions": need("documentId", documentId); return api("GET", `/api/v10/documents/d/${encodeURIComponent(documentId)}/versions`, { offset: a.offset ?? 0, limit: a.limit ?? 20 });
        case "create_version": need("documentId", documentId); need("workspaceId", workspaceId); return api("POST", `/api/v10/documents/d/${encodeURIComponent(documentId)}/versions`, undefined, body);
        case "list_elements": need("documentId", documentId); need("wvmId", wvmId); return api("GET", `/api/v10/documents/d/${encodeURIComponent(documentId)}/w/${encodeURIComponent(wvmId)}/elements`);
        case "get_partstudio_features": need("documentId", documentId); need("wvmId", wvmId); need("elementId", elementId); return api("GET", `/api/v9/partstudios/d/${documentId}/w/${wvmId}/e/${elementId}/features`, { rollbackBarIndex: a.rollbackBarIndex ?? -1, includeGeometryIds: true, noSketchGeometry: false });
        case "create_partstudio": need("documentId", documentId); need("workspaceId", workspaceId); return api("POST", `/api/v9/partstudios/d/${documentId}/w/${workspaceId}`, undefined, body ?? { name: "Part Studio" });
        case "create_feature": need("documentId", documentId); need("workspaceId", workspaceId); need("elementId", elementId); return api("POST", `/api/v9/partstudios/d/${documentId}/w/${workspaceId}/e/${elementId}/features`, undefined, a.feature ?? body);
        case "update_feature": need("documentId", documentId); need("workspaceId", workspaceId); need("elementId", elementId); need("featureId", featureId); return api("POST", `/api/v9/partstudios/d/${documentId}/w/${workspaceId}/e/${elementId}/features/featureid/${featureId}`, undefined, a.feature ?? body);
        case "delete_feature": need("documentId", documentId); need("workspaceId", workspaceId); need("elementId", elementId); need("featureId", featureId); return api("DELETE", `/api/v9/partstudios/d/${documentId}/w/${workspaceId}/e/${elementId}/features/featureid/${featureId}`);
        case "evaluate_featurescript": need("documentId", documentId); need("workspaceId", workspaceId); need("elementId", elementId); need("script", String(a.script || "")); return api("POST", `/api/v6/partstudios/d/${documentId}/w/${workspaceId}/e/${elementId}/featurescript`, { rollbackBarIndex: a.rollbackBarIndex ?? -1 }, { libraryVersion: 2144, script: a.script });
        case "get_parts": need("documentId", documentId); need("wvmId", wvmId); need("elementId", elementId); return api("GET", `/api/v9/parts/d/${documentId}/w/${wvmId}/e/${elementId}/partid`, q);
        case "get_part_metadata": need("documentId", documentId); need("wvmId", wvmId); need("elementId", elementId); need("partId", partId); return api("GET", `/api/v9/parts/d/${documentId}/w/${wvmId}/e/${elementId}/partid/${partId}/metadata`);
        case "get_bounding_box": need("documentId", documentId); need("wvmId", wvmId); need("elementId", elementId); return api("GET", `/api/v9/partstudios/d/${documentId}/w/${wvmId}/e/${elementId}/boundingboxes`, q);
        case "create_assembly": need("documentId", documentId); need("workspaceId", workspaceId); return api("POST", `/api/v9/assemblies/d/${documentId}/w/${workspaceId}`, undefined, body ?? { name: "Assembly" });
        case "get_assembly": need("documentId", documentId); need("wvmId", wvmId); need("elementId", elementId); return api("GET", `/api/v9/assemblies/d/${documentId}/w/${wvmId}/e/${elementId}`, q);
        case "assembly_operation": need("path", path || ""); need("method", method || ""); return api(method!, path!, q, body);
        case "get_configuration": need("documentId", documentId); need("wvmId", wvmId); need("elementId", elementId); return api("GET", `/api/v10/elements/d/${documentId}/w/${wvmId}/e/${elementId}/configuration`);
        case "update_configuration": need("documentId", documentId); need("workspaceId", workspaceId); need("elementId", elementId); return api("POST", `/api/v10/elements/d/${documentId}/w/${workspaceId}/e/${elementId}/configuration`, q, body);
        case "get_metadata": need("documentId", documentId); need("wvmId", wvmId); need("elementId", elementId); return api("GET", `/api/v9/metadata/d/${documentId}/w/${wvmId}/e/${elementId}`, { partId: a.partId, ...q });
        case "update_metadata": need("documentId", documentId); need("workspaceId", workspaceId); need("elementId", elementId); return api("POST", `/api/v9/metadata/d/${documentId}/w/${workspaceId}/e/${elementId}`, q, body);
        case "get_materials": need("path", path || ""); return api(method || "GET", path!, q, body);
        case "translation_formats": return api("GET", "/api/v9/translations/translationformats");
        case "create_translation": need("documentId", documentId); need("workspaceId", workspaceId); return api("POST", `/api/v9/translations/d/${documentId}/w/${workspaceId}`, q, body);
        case "get_translation": need("path", path || ""); return api("GET", path!, q);
        case "export_partstudio": need("path", path || ""); return api(method || "GET", path!, q, body);
        case "export_part": need("path", path || ""); return api(method || "GET", path!, q, body);
        case "export_assembly": need("path", path || ""); return api(method || "POST", path!, q, body);
        case "drawing_operation":
        case "release_operation":
        case "blob_operation":
        case "associativity_operation":
        case "user_team_operation":
        case "raw": need("path", path || ""); need("method", method || ""); return api(method!, path!, q, body);
        default: throw new Error(`Unsupported operation: ${operation}`);
      }
    });
  });

  server.registerTool("test_connection", { title: "Test Connection", description: "Verify Onshape authentication without modifying anything.", inputSchema: z.object({}) }, async () => call(() => api("GET", "/api/v10/documents", { limit: 1 })));
  server.registerTool("list_onshape_documents", { title: "List Documents", description: "List documents visible to the Onshape account.", inputSchema: z.object({ q: z.string().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }) }, async ({ q, offset, limit }) => call(() => api("GET", "/api/v10/documents", { q, offset: offset ?? 0, limit: limit ?? 20 })));
  server.registerTool("get_onshape_document", { title: "Get Document", description: "Read document metadata.", inputSchema: z.object({ documentId: id }) }, async ({ documentId }) => call(() => api("GET", `/api/v10/documents/${encodeURIComponent(documentId)}`)));
  server.registerTool("get_onshape_workspaces", { title: "Get Workspaces", description: "List document workspaces/branches.", inputSchema: z.object({ documentId: id }) }, async ({ documentId }) => call(() => api("GET", `/api/v10/documents/d/${encodeURIComponent(documentId)}/workspaces`)));
  server.registerTool("get_onshape_versions", { title: "Get Versions", description: "List immutable document versions.", inputSchema: z.object({ documentId: id, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }) }, async ({ documentId, offset, limit }) => call(() => api("GET", `/api/v10/documents/d/${encodeURIComponent(documentId)}/versions`, { offset: offset ?? 0, limit: limit ?? 20 })));
  server.registerTool("get_onshape_elements", { title: "Get Elements", description: "List Part Studios, Assemblies, Drawings, BOMs and other document tabs.", inputSchema: z.object({ documentId: id, wvm: z.enum(["w","v","m"]).default("w"), wvmId: id }) }, async ({ documentId, wvm, wvmId }) => call(() => api("GET", `/api/v10/documents/d/${encodeURIComponent(documentId)}/${wvm}/${encodeURIComponent(wvmId)}/elements`)));
  server.registerTool("onshape_api", { title: "Raw Onshape REST API", description: "Direct authenticated access to any documented Onshape GET, POST or DELETE endpoint. Use when the named CAD operation does not cover a newly added or specialized endpoint.", inputSchema: z.object({ method: z.enum(["GET","POST","DELETE"]), path: z.string().startsWith("/api/"), query: z.record(z.string(), z.unknown()).optional(), body: z.unknown().optional() }) }, async ({ method, path, query, body }) => call(() => api(method, path, query, body)));
}, { serverInfo: { name: "Onshape Claude MCP", version: "5.0.0" } });

app.get("/", c => c.json({ name: "Onshape Claude MCP", status: "online", version: "5.0.0", onshapeConfigured: Boolean(ACCESS && SECRET), capabilities: capabilityText }));
app.all("/mcp", c => mcp(c.req.raw));
app.all("/api/mcp", c => mcp(c.req.raw));
export default app;

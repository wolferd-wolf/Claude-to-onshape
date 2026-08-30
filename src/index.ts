import { createHmac, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const app = new Hono();
const BASE = (process.env.ONSHAPE_BASE_URL || "https://cad.onshape.com").replace(/\/$/, "");
const ACCESS = process.env.ONSHAPE_ACCESS_KEY;
const SECRET = process.env.ONSHAPE_SECRET_KEY;

type Method = "GET" | "POST" | "DELETE";

function auth() {
  if (!ACCESS || !SECRET) throw new Error("Onshape credentials are not configured.");
}

function signature(method: string, url: URL, nonce: string, date: string, contentType: string) {
  auth();
  const canonical = (method.toUpperCase() + "\n" + nonce + "\n" + date + "\n" + contentType + "\n" + url.pathname + "\n" + url.search.slice(1) + "\n").toLowerCase();
  return `On ${ACCESS}:HmacSHA256:${createHmac("sha256", SECRET!).update(canonical).digest("base64")}`;
}

async function onshapeRequest(method: Method, path: string, query?: Record<string, string | number | boolean | undefined>, body?: unknown) {
  auth();
  if (!path.startsWith("/api/")) throw new Error("Onshape path must start with /api/.");
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const contentType = "application/json";
  const date = new Date().toUTCString();
  const nonce = randomBytes(18).toString("base64url");
  const response = await fetch(url, {
    method,
    headers: { Accept: "application/json", "Content-Type": contentType, Date: date, "On-Nonce": nonce, Authorization: signature(method, url, nonce, date, contentType) },
    body: method === "GET" ? undefined : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw new Error(`Onshape API HTTP ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

async function toolCall(fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    return { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
}

const id = z.string().min(1);
const context = z.object({ documentId: id, workspaceId: id, elementId: id });

const mcpHandler = createMcpHandler((server) => {
  server.registerTool("test_connection", { title: "Test Onshape Connection", description: "Verify Onshape authentication.", inputSchema: z.object({}) }, async () => toolCall(() => onshapeRequest("GET", "/api/v10/documents", { limit: 1 })));

  server.registerTool("list_onshape_documents", { title: "List Documents", description: "Search documents visible to the account.", inputSchema: z.object({ q: z.string().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }) }, async ({ q, offset, limit }) => toolCall(() => onshapeRequest("GET", "/api/v10/documents", { q, offset: offset ?? 0, limit: limit ?? 20 })));

  server.registerTool("get_onshape_document", { title: "Get Document", description: "Get document metadata.", inputSchema: z.object({ documentId: id }) }, async ({ documentId }) => toolCall(() => onshapeRequest("GET", `/api/v10/documents/${encodeURIComponent(documentId)}`)));

  server.registerTool("create_onshape_document", { title: "Create Document", description: "Create a new Onshape document.", inputSchema: z.object({ name: z.string().min(1) }) }, async ({ name }) => toolCall(() => onshapeRequest("POST", "/api/v10/documents", undefined, { name })));

  server.registerTool("update_onshape_document", { title: "Update Document", description: "Rename or update basic document attributes.", inputSchema: z.object({ documentId: id, name: z.string().optional(), description: z.string().optional() }) }, async ({ documentId, name, description }) => toolCall(() => onshapeRequest("POST", `/api/v10/documents/${encodeURIComponent(documentId)}`, undefined, { name, description })));

  server.registerTool("get_onshape_workspaces", { title: "Get Workspaces", description: "List document workspaces/branches.", inputSchema: z.object({ documentId: id }) }, async ({ documentId }) => toolCall(() => onshapeRequest("GET", `/api/v10/documents/d/${encodeURIComponent(documentId)}/workspaces`)));

  server.registerTool("get_onshape_versions", { title: "Get Versions", description: "List document versions.", inputSchema: z.object({ documentId: id, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }) }, async ({ documentId, offset, limit }) => toolCall(() => onshapeRequest("GET", `/api/v10/documents/d/${encodeURIComponent(documentId)}/versions`, { offset: offset ?? 0, limit: limit ?? 20 })));

  server.registerTool("create_onshape_version", { title: "Create Version", description: "Create a named immutable version from a workspace.", inputSchema: z.object({ documentId: id, workspaceId: id, name: z.string().min(1) }) }, async ({ documentId, workspaceId, name }) => toolCall(() => onshapeRequest("POST", `/api/v10/documents/d/${encodeURIComponent(documentId)}/versions`, undefined, { documentId, workspaceId, name })));

  server.registerTool("get_onshape_elements", { title: "Get Elements", description: "List Part Studios, Assemblies, Drawings, BOMs and other tabs in a workspace/version/microversion.", inputSchema: z.object({ documentId: id, wvm: z.enum(["w", "v", "m"]), wvmId: id }) }, async ({ documentId, wvm, wvmId }) => toolCall(() => onshapeRequest("GET", `/api/v10/documents/d/${encodeURIComponent(documentId)}/${wvm}/${encodeURIComponent(wvmId)}/elements`)));

  server.registerTool("get_partstudio_features", { title: "Get Part Studio Features", description: "Read the complete feature tree, feature states and geometry IDs for a Part Studio. This is the primary inspection tool before creating or editing features.", inputSchema: z.object({ documentId: id, wvm: z.enum(["w", "v", "m"]).default("w"), wvmId: id, elementId: id, rollbackBarIndex: z.number().int().optional(), includeGeometryIds: z.boolean().default(true), noSketchGeometry: z.boolean().default(false) }) }, async ({ documentId, wvm, wvmId, elementId, rollbackBarIndex, includeGeometryIds, noSketchGeometry }) => toolCall(() => onshapeRequest("GET", `/api/v9/partstudios/d/${encodeURIComponent(documentId)}/${wvm}/${encodeURIComponent(wvmId)}/e/${encodeURIComponent(elementId)}/features`, { rollbackBarIndex: rollbackBarIndex ?? -1, includeGeometryIds, noSketchGeometry })));

  server.registerTool("create_partstudio", { title: "Create Part Studio", description: "Create a new Part Studio tab in a workspace.", inputSchema: z.object({ documentId: id, workspaceId: id, name: z.string().min(1) }) }, async ({ documentId, workspaceId, name }) => toolCall(() => onshapeRequest("POST", `/api/v9/partstudios/d/${encodeURIComponent(documentId)}/w/${encodeURIComponent(workspaceId)}`, undefined, { name })));

  server.registerTool("create_sketch_rectangle", { title: "Create Rectangle Sketch", description: "Create a rectangular sketch on a Part Studio plane. Coordinates and dimensions are in millimeters. The server builds the Onshape sketch feature payload.", inputSchema: context.extend({ plane: z.enum(["Top", "Front", "Right"]).default("Top"), widthMm: z.number().positive(), heightMm: z.number().positive(), centerXmm: z.number().default(0), centerYmm: z.number().default(0), name: z.string().default("Rectangle Sketch") }) }, async ({ documentId, workspaceId, elementId, plane, widthMm, heightMm, centerXmm, centerYmm, name }) => {
    const x = centerXmm / 1000, y = centerYmm / 1000, w = widthMm / 1000, h = heightMm / 1000;
    const x0 = x - w / 2, y0 = y - h / 2;
    const lines = [
      ["L1", x0, y0, 1, 0, w], ["L2", x0 + w, y0, 0, 1, h], ["L3", x0 + w, y0 + h, -1, 0, w], ["L4", x0, y0 + h, 0, -1, h],
    ].map(([entityId, px, py, dx, dy, len]) => ({ btType: "BTMSketchCurveSegment-155", entityId, startPointId: `${entityId}.start`, endPointId: `${entityId}.end`, startParam: 0, endParam: len, geometry: { btType: "BTCurveGeometryLine-117", pntX: px, pntY: py, dirX: dx, dirY: dy } }));
    const body = { btType: "BTFeatureDefinitionCall-1406", feature: { btType: "BTMSketch-151", featureType: "newSketch", name, parameters: [{ btType: "BTMParameterQueryList-148", queries: [{ btType: "BTMIndividualQuery-138", queryString: `query=qCreatedBy(makeId(\"${plane}\"), EntityType.FACE);` }], parameterId: "sketchPlane" }], entities: lines, constraints: [] } };
    return toolCall(() => onshapeRequest("POST", `/api/v9/partstudios/d/${encodeURIComponent(documentId)}/w/${encodeURIComponent(workspaceId)}/e/${encodeURIComponent(elementId)}/features`, undefined, body));
  });

  server.registerTool("create_sketch_circle", { title: "Create Circle Sketch", description: "Create a circular sketch on a Part Studio plane. Dimensions are in millimeters.", inputSchema: context.extend({ plane: z.enum(["Top", "Front", "Right"]).default("Top"), radiusMm: z.number().positive(), centerXmm: z.number().default(0), centerYmm: z.number().default(0), name: z.string().default("Circle Sketch") }) }, async ({ documentId, workspaceId, elementId, plane, radiusMm, centerXmm, centerYmm, name }) => {
    const body = { btType: "BTFeatureDefinitionCall-1406", feature: { btType: "BTMSketch-151", featureType: "newSketch", name, parameters: [{ btType: "BTMParameterQueryList-148", queries: [{ btType: "BTMIndividualQuery-138", queryString: `query=qCreatedBy(makeId(\"${plane}\"), EntityType.FACE);` }], parameterId: "sketchPlane" }], entities: [{ btType: "BTMSketchCurve-4", centerId: "circle.center", entityId: "circle", geometry: { btType: "BTCurveGeometryCircle-115", radius: radiusMm / 1000, xCenter: centerXmm / 1000, yCenter: centerYmm / 1000, xDir: 1, yDir: 0, clockwise: false } }], constraints: [] } };
    return toolCall(() => onshapeRequest("POST", `/api/v9/partstudios/d/${encodeURIComponent(documentId)}/w/${encodeURIComponent(workspaceId)}/e/${encodeURIComponent(elementId)}/features`, undefined, body));
  });

  server.registerTool("create_extrude", { title: "Create Extrude", description: "Extrude all regions of an existing sketch. The sketch feature ID is resolved by Onshape using BTMIndividualSketchRegionQuery.", inputSchema: context.extend({ sketchFeatureId: id, depthMm: z.number().positive(), operation: z.enum(["NEW", "ADD", "REMOVE"]).default("NEW"), name: z.string().default("Extrude") }) }, async ({ documentId, workspaceId, elementId, sketchFeatureId, depthMm, operation, name }) => {
    const operationEnum = operation === "REMOVE" ? "REMOVE" : operation === "ADD" ? "ADD" : "NEW";
    const body = { btType: "BTFeatureDefinitionCall-1406", feature: { btType: "BTMFeature-134", featureType: "extrude", name, parameters: [
      { btType: "BTMParameterEnum-145", value: "SOLID", enumName: "ExtendedToolBodyType", parameterId: "bodyType" },
      { btType: "BTMParameterEnum-145", value: operationEnum, enumName: "NewBodyOperationType", parameterId: "operationType" },
      { btType: "BTMParameterQueryList-148", queries: [{ btType: "BTMIndividualSketchRegionQuery-140", featureId: sketchFeatureId }], parameterId: "entities" },
      { btType: "BTMParameterEnum-145", value: "BLIND", enumName: "BoundingType", parameterId: "endBound" },
      { btType: "BTMParameterQuantity-147", expression: `${depthMm} mm`, parameterId: "depth" },
    ] } };
    return toolCall(() => onshapeRequest("POST", `/api/v9/partstudios/d/${encodeURIComponent(documentId)}/w/${encodeURIComponent(workspaceId)}/e/${encodeURIComponent(elementId)}/features`, undefined, body));
  });

  server.registerTool("update_partstudio_feature", { title: "Update Part Studio Feature", description: "Update an existing feature. The feature body must use the exact structure returned by get_partstudio_features; this tool is intentionally low-level for advanced feature edits.", inputSchema: z.object({ documentId: id, workspaceId: id, elementId: id, featureId: id, feature: z.record(z.string(), z.unknown()) }) }, async ({ documentId, workspaceId, elementId, featureId, feature }) => toolCall(() => onshapeRequest("POST", `/api/v9/partstudios/d/${encodeURIComponent(documentId)}/w/${encodeURIComponent(workspaceId)}/e/${encodeURIComponent(elementId)}/features/featureid/${encodeURIComponent(featureId)}`, undefined, { btType: "BTFeatureDefinitionCall-1406", feature })));

  server.registerTool("delete_partstudio_feature", { title: "Delete Part Studio Feature", description: "Delete one Part Studio feature by feature ID. Use only when the intended feature is unambiguous.", inputSchema: z.object({ documentId: id, workspaceId: id, elementId: id, featureId: id }) }, async ({ documentId, workspaceId, elementId, featureId }) => toolCall(() => onshapeRequest("DELETE", `/api/v9/partstudios/d/${encodeURIComponent(documentId)}/w/${encodeURIComponent(workspaceId)}/e/${encodeURIComponent(elementId)}/features/featureid/${encodeURIComponent(featureId)}`)));

  server.registerTool("create_assembly", { title: "Create Assembly", description: "Create a new Assembly tab in a workspace.", inputSchema: z.object({ documentId: id, workspaceId: id, name: z.string().min(1) }) }, async ({ documentId, workspaceId, name }) => toolCall(() => onshapeRequest("POST", `/api/v9/assemblies/d/${encodeURIComponent(documentId)}/w/${encodeURIComponent(workspaceId)}`, undefined, { name })));

  server.registerTool("get_assembly_definition", { title: "Get Assembly Definition", description: "Inspect assembly instances, occurrences, mates and transforms.", inputSchema: z.object({ documentId: id, wvm: z.enum(["w", "v", "m"]).default("w"), wvmId: id, elementId: id, includeMateFeatures: z.boolean().default(true), includeNonSolids: z.boolean().default(false), includeMateConnectors: z.boolean().default(true), excludeSuppressed: z.boolean().default(false) }) }, async ({ documentId, wvm, wvmId, elementId, includeMateFeatures, includeNonSolids, includeMateConnectors, excludeSuppressed }) => toolCall(() => onshapeRequest("GET", `/api/v9/assemblies/d/${encodeURIComponent(documentId)}/${wvm}/${encodeURIComponent(wvmId)}/e/${encodeURIComponent(elementId)}`, { includeMateFeatures, includeNonSolids, includeMateConnectors, excludeSuppressed })));

  server.registerTool("insert_assembly_instance", { title: "Insert Assembly Instance", description: "Insert a part, Part Studio or assembly instance into an Assembly.", inputSchema: z.object({ targetDocumentId: id, targetWorkspaceId: id, targetAssemblyElementId: id, sourceDocumentId: id, sourceElementId: id, partId: z.string().optional(), versionId: z.string().optional(), configuration: z.string().optional(), isWholePartStudio: z.boolean().optional() }) }, async (a) => toolCall(() => onshapeRequest("POST", `/api/v9/assemblies/d/${a.targetDocumentId}/w/${a.targetWorkspaceId}/e/${a.targetAssemblyElementId}/instances`, undefined, { documentId: a.sourceDocumentId, elementId: a.sourceElementId, partId: a.partId, versionId: a.versionId, configuration: a.configuration, isWholePartStudio: a.isWholePartStudio, includePartTypes: ["PARTS"] })));

  server.registerTool("modify_assembly", { title: "Modify Assembly", description: "Apply supported assembly changes such as transforms, suppression states and instance deletion. Body follows Onshape Assembly modify schema.", inputSchema: z.object({ documentId: id, workspaceId: id, elementId: id, modifications: z.record(z.string(), z.unknown()) }) }, async ({ documentId, workspaceId, elementId, modifications }) => toolCall(() => onshapeRequest("POST", `/api/v9/assemblies/d/${encodeURIComponent(documentId)}/w/${encodeURIComponent(workspaceId)}/e/${encodeURIComponent(elementId)}/modify`, undefined, modifications)));

  server.registerTool("export_partstudio_step", { title: "Export Part Studio STEP", description: "Start an asynchronous STEP export of a Part Studio. The response contains the translation ID; use the Onshape API for status/download handling.", inputSchema: z.object({ documentId: id, workspaceId: id, elementId: id, stepUnit: z.enum(["MILLIMETER", "CENTIMETER", "METER", "INCH", "FOOT", "YARD", "UNKNOWN"]).default("MILLIMETER"), storeInDocument: z.boolean().default(false) }) }, async ({ documentId, workspaceId, elementId, stepUnit, storeInDocument }) => toolCall(() => onshapeRequest("POST", `/api/v11/partstudios/d/${encodeURIComponent(documentId)}/w/${encodeURIComponent(workspaceId)}/e/${encodeURIComponent(elementId)}/export/step`, undefined, { stepUnit, storeInDocument })));

  server.registerTool("export_assembly_step", { title: "Export Assembly STEP", description: "Start an asynchronous STEP export of an Assembly.", inputSchema: z.object({ documentId: id, workspaceId: id, elementId: id, storeInDocument: z.boolean().default(false) }) }, async ({ documentId, workspaceId, elementId, storeInDocument }) => toolCall(() => onshapeRequest("POST", `/api/v11/assemblies/d/${encodeURIComponent(documentId)}/w/${encodeURIComponent(workspaceId)}/e/${encodeURIComponent(elementId)}/export/step`, undefined, { storeInDocument })));

  server.registerTool("onshape_api", { title: "Onshape API", description: "Authenticated raw Onshape REST API access for advanced operations. GET, POST and DELETE are supported.", inputSchema: z.object({ method: z.enum(["GET", "POST", "DELETE"]), path: z.string().startsWith("/api/"), query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(), body: z.unknown().optional() }) }, async ({ method, path, query, body }) => toolCall(() => onshapeRequest(method, path, query, body)));
}, { serverInfo: { name: "Onshape Claude MCP", version: "3.0.0" } });

app.get("/", (c) => c.json({ name: "Onshape Claude MCP", status: "online", version: "3.0.0", onshapeConfigured: Boolean(ACCESS && SECRET) }));
app.all("/mcp", async (c) => mcpHandler(c.req.raw));
app.all("/mcp/*", async (c) => mcpHandler(c.req.raw));
export default app;

import { Hono } from "hono";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const app = new Hono();

app.get("/", (c) => {
  return c.json({
    name: "Onshape Claude MCP",
    status: "online",
    version: "1.0.0",
  });
});

const mcpHandler = createMcpHandler(
  (server) => {
    server.registerTool(
      "test_connection",
      {
        title: "Test Connection",
        description:
          "Tests the connection between Claude and the Onshape MCP server.",
        inputSchema: z.object({}),
      },
      async () => {
        return {
          content: [
            {
              type: "text",
              text: "Onshape Claude MCP is online.",
            },
          ],
        };
      },
    );
  },
  {
    serverInfo: {
      name: "Onshape Claude MCP",
      version: "1.0.0",
    },
  },
);

app.all("/mcp", async (c) => {
  return mcpHandler(c.req.raw);
});

app.all("/mcp/*", async (c) => {
  return mcpHandler(c.req.raw);
});

export default app;

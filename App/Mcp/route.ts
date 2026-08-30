import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "test_connection",
      {
        title: "Test Connection",
        description: "Tests whether the Claude CAD MCP server is working.",
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

export { handler as GET, handler as POST };

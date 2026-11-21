// Intentionally exercise the pinned real host's registration, schema serialization
// and invocation path. Only provider inference is scripted in these tests.
import { PluginAgentTools } from "../node_modules/@getpaseo/server/dist/server/server/plugins/agent-tools.js";
import { PluginHookHandlers } from "../node_modules/@getpaseo/server/dist/server/server/plugins/lifecycle/index.js";
import type { PluginHookAgent } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import type { CreateAgentOptions } from "../server/paseo-adapter";
import { ReviewTools } from "../server/review-tools";

export function reviewHost() {
  const agentTools = new PluginAgentTools();
  const hooks = new PluginHookHandlers(() => {}, agentTools);
  const reviews = new ReviewTools(hooks);
  let sequence = 0;
  const agent = (options: CreateAgentOptions): PluginHookAgent => ({ id: options.agentId, provider: options.config.provider.split("/")[0],
    cwd: options.cwd, parentAgentId: options.parent, workspaceId: null, background: true, metadata: {}, title: "Curator" });
  return {
    reviews, agentTools, hooks,
    open: async (options: CreateAgentOptions) => hooks.invoke(`open-${sequence++}`, "agent.open.before", {
      agentId: options.agentId, provider: options.config.provider.split("/")[0], cwd: options.cwd, workspaceId: null,
      reason: "create", purpose: "interactive", title: options.title, background: true, labels: options.labels,
      metadata: options.metadata, tools: [], env: {}, mcpServers: {},
    }, {} as PaseoApi),
    call: (options: CreateAgentOptions, input: unknown) => agentTools.call(`call-${sequence++}`, agent(options), "submit_review", input, {} as PaseoApi),
    close: async () => { await reviews.close(); hooks.close(); agentTools.close(); },
  };
}

import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerPluginTools } from "../node_modules/@getpaseo/server/dist/server/server/agent/tools/plugin-tools.js";
import type { AgentManager } from "../node_modules/@getpaseo/server/dist/server/server/agent/agent-manager.js";
import type { PaseoToolDefinition } from "../node_modules/@getpaseo/server/dist/server/server/agent/tools/types.js";

/** Real host JSON-Schema-to-Zod MCP registration, not just direct execute(). */
export async function reviewMcpBridge(host: ReturnType<typeof reviewHost>, options: CreateAgentOptions, opened: unknown) {
  const metadata = (opened as { tools: Array<object> }).tools;
  const tools = new Map<string, PaseoToolDefinition>();
  registerPluginTools({
    agentManager: {
      getPluginTools: () => metadata.map(tool => ({ ...tool, pluginId: "curator", pluginInstanceId: "test-instance" })),
      executePluginTool: (_tool: unknown, caller: string, input: unknown) => {
        if (caller !== options.agentId) throw new Error("caller identity mismatch");
        return host.call(options, input);
      },
    } as unknown as AgentManager,
    callerAgentId: options.agentId, scope: "agent", tools, builtinNames: new Set(),
  });
  const server = new McpServer({ name: "curator-host-integration", version: "1" });
  for (const tool of tools.values()) server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema },
    async (input: Record<string, unknown>, context: { signal: AbortSignal }) => CallToolResultSchema.parse(await tool.handler(input, { signal: context.signal })));
  const client = new Client({ name: "reviewer-test-transport", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    call: (argumentsValue: Record<string, unknown>) => client.callTool({ name: "submit_review", arguments: argumentsValue }),
    close: async () => { await client.close(); await server.close(); },
  };
}

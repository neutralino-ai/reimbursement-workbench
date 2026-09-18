#!/usr/bin/env node
import path from 'node:path';
import {realpathSync} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createAgentRuntime, parseRuntimeArgs } from './agent-runtime.mjs';

export function createReimbursementMcp(runtime) {
  const server = new Server({ name: 'reimbursement-workbench', version: '0.2.0' }, {
    capabilities: { tools: {} },
    instructions: 'Operate on the configured cloud or local reimbursement ledger. The default connection comes from client-connection.json, with environment and CLI overrides; --local explicitly selects an independent local copy and never synchronizes it with the cloud. Remote mode uses a private Agent token, separate from the user UI password. Use your own browser, image/PDF reading, and document skills to collect or prepare files. Import evidence before recording conclusions; localPath names a file on the Agent computer even in remote mode. Money uses decimal strings. Reuse operationId for uncertain retries; obtain current baseVersion before updating. Do not silently fall back to local data when a remote request fails. Agent findings do not constitute human verification. Website collection and ARP submission are outside these tools.',
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: runtime.catalog.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.name === 'allocation.remove', idempotentHint: true, openWorldHint: false },
  })) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const result = await runtime.execute(request.params.name, request.params.arguments ?? {});
      const output = result && typeof result === 'object' && !Array.isArray(result) ? result : { result };
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    } catch (error) {
      const output = { error: error.message, statusCode: error.statusCode || 500 };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    }
  });
  server.onclose = () => runtime.close();
  return server;
}

async function main() {
  const options = parseRuntimeArgs(process.argv.slice(2));
  if (options.help) {
    process.stderr.write('Usage: node server/mcp.mjs [--actor-id codex]\n       node server/mcp.mjs --api-url HTTPS_URL --token-file PRIVATE_PATH [--actor-id codex]\n       node server/mcp.mjs --local [--data-dir PATH] [--legacy-dir PATH] [--actor-id codex]\nConnection precedence: client-connection.json < REIMBURSE_API_URL / REIMBURSE_AGENT_TOKEN_FILE < CLI flags.\n--local explicitly selects independent local data or an old backup; it bypasses remote settings.\nThe MCP stdio transport owns stdout. Local mode does not need a UI server; remote mode calls the configured HTTPS API.\n');
    return;
  }
  const runtime = createAgentRuntime(options);
  const server = createReimbursementMcp(runtime);
  const stop = async () => { await server.close(); runtime.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { await server.connect(new StdioServerTransport()); }
  catch (error) { runtime.close(); throw error; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(path.resolve(process.argv[1]))) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createAgentRuntime, parseRuntimeArgs } from '../server/agent-runtime.mjs';

const HELP = `Usage: node scripts/agent-cli.mjs [--actor-id codex] --catalog
       node scripts/agent-cli.mjs [--actor-id codex] --file command.json
       node scripts/agent-cli.mjs [--api-url HTTPS_URL --token-file PRIVATE_PATH] --file command.json
       node scripts/agent-cli.mjs --local [--data-dir PATH] [--legacy-dir PATH] --file command.json
       node scripts/agent-cli.mjs [options] < command.json

Command JSON: {"type":"tasks.list","payload":{}}
Writes also require operationId and may require baseVersion. Use --catalog for exact schemas.
Connection precedence: client-connection.json < REIMBURSE_API_URL / REIMBURSE_AGENT_TOKEN_FILE < CLI flags.
--local bypasses remote configuration and selects an independent local ledger or old backup.
The token file contains the private Agent token, not the user's UI password. Never put tokens in URLs.
Remote mode uses HTTPS and does not open local SQLite. Without remote configuration, local mode needs no UI server.
MCP and CLI use the same dispatcher. All writes are attributed to an agent.
`;

let runtime;
try {
  const options = parseRuntimeArgs(process.argv.slice(2), { cli: true });
  if (options.help) process.stdout.write(HELP);
  else {
    runtime = createAgentRuntime(options);
    let result;
    if (options.catalog) result = { tools: runtime.catalog };
    else {
      let raw;
      if (options.file) raw = await readFile(options.file, 'utf8');
      else {
        if (process.stdin.isTTY) throw new Error('Supply --file command.json or pipe a JSON command on stdin.');
        const chunks = []; let size = 0;
        for await (const chunk of process.stdin) {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) throw new Error('Command JSON exceeds 2 MB; import files by path instead of embedding bytes.');
          chunks.push(chunk);
        }
        raw = Buffer.concat(chunks).toString('utf8');
      }
      const command = JSON.parse(raw.replace(/^\uFEFF/, ''));
      if (!command || typeof command !== 'object' || Array.isArray(command) || typeof command.type !== 'string') throw new Error('Command requires a string type.');
      const { type, ...args } = command;
      result = await runtime.execute(type, args);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message, statusCode: error.statusCode || 500 })}\n`);
  process.exitCode = 1;
} finally { runtime?.close(); }

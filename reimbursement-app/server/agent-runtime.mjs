import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from 'node:fs/promises';
import { existsSync, readFileSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import Ajv from 'ajv';
import { createStore } from './store.mjs';
import { executeAgentCommand, getAgentCatalog } from './agent.mjs';

export const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function savedConnection(filename) {
  if (!existsSync(filename)) return {};
  let config;
  try { config = JSON.parse(readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw failure('Cannot read client-connection.json; repair the connection configuration or use --local.'); }
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !['apiUrl', 'tokenFile'].includes(key)) || typeof config.apiUrl !== 'string' || !config.apiUrl.trim() || typeof config.tokenFile !== 'string' || !config.tokenFile.trim()) {
    throw failure('client-connection.json must contain apiUrl and tokenFile only; use --local to bypass it.');
  }
  return { apiUrl: config.apiUrl, tokenFile: path.resolve(path.dirname(filename), config.tokenFile) };
}

export function parseRuntimeArgs(argv, { cli = false, connectionFile = path.join(appDirectory, 'client-connection.json') } = {}) {
  const local = argv.includes('--local');
  const connection = local ? {} : savedConnection(connectionFile);
  const result = { dataDir: process.env.REIMBURSE_DATA_DIR || path.join(appDirectory, 'data'), actorId: process.env.REIMBURSE_AGENT_ID || 'codex' };
  if (local) result.local = true;
  else {
    result.apiUrl = process.env.REIMBURSE_API_URL ?? connection.apiUrl;
    result.tokenFile = process.env.REIMBURSE_AGENT_TOKEN_FILE ?? connection.tokenFile;
  }
  const named = new Map([['--data-dir', 'dataDir'], ['--legacy-dir', 'legacyDir'], ['--actor-id', 'actorId'], ['--api-url', 'apiUrl'], ['--token-file', 'tokenFile'], ...(cli ? [['--file', 'file']] : [])]);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') result.help = true;
    else if (argv[i] === '--local') continue;
    else if (cli && argv[i] === '--catalog') result.catalog = true;
    else if (named.has(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--')) result[named.get(argv[i])] = argv[++i];
    else throw failure('Unknown or incomplete runtime option.');
  }
  if (local && (argv.includes('--api-url') || argv.includes('--token-file'))) throw failure('--local cannot be combined with --api-url or --token-file.');
  if (!local && result.apiUrl && !argv.includes('--api-url') && (argv.includes('--data-dir') || argv.includes('--legacy-dir'))) throw failure('A remote connection is configured. Use --local with --data-dir/--legacy-dir to operate on local data, or explicitly supply --api-url.');
  if (!result.actorId.trim() || result.actorId.length > 120) throw new Error('actor-id must contain 1–120 characters.');
  return result;
}

function remoteEndpoint(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('?') || value.includes('#')) throw failure('Remote API URL must not include credentials, query parameters or a fragment.');
  let url;
  try { url = new URL(value); } catch { throw failure('Remote API URL is invalid.'); }
  if (url.username || url.password) throw failure('Remote API URL must not include credentials, query parameters or a fragment.');
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw failure('Remote API requires HTTPS; HTTP is permitted only for loopback connections.');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/agent/commands`;
  return url.href;
}

function readAgentToken(filename) {
  if (typeof filename !== 'string' || !filename.trim()) throw failure('Remote mode requires --token-file or REIMBURSE_AGENT_TOKEN_FILE.');
  let handle;
  try {
    handle = openSync(filename, 'r');
    const stat = fstatSync(handle);
    if (!stat.isFile() || stat.size < 1 || stat.size > 4096) throw failure('Remote agent token file must be a regular file of at most 4096 bytes.');
    const bytes = Buffer.alloc(4097);
    const length = readSync(handle, bytes, 0, bytes.length, 0);
    if (length > 4096) throw failure('Remote agent token file exceeds 4096 bytes.');
    const token = bytes.subarray(0, length).toString('utf8').trim();
    if (!/^[a-f0-9]{64}$/i.test(token)) throw failure('Remote agent token file must contain exactly 64 hexadecimal characters.');
    return token;
  } catch (error) {
    if (error.statusCode) throw error;
    throw failure('Cannot read the remote agent token file.');
  } finally { if (handle !== undefined) closeSync(handle); }
}

function createRemoteDispatcher(apiUrl, tokenFile) {
  const endpoint = remoteEndpoint(apiUrl);
  readAgentToken(tokenFile);
  return async command => {
    const token = readAgentToken(tokenFile);
    let response;
    try {
      response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(command), redirect: 'error', signal: AbortSignal.timeout(60000) });
    } catch (error) {
      throw failure(error.name === 'TimeoutError' ? 'Remote agent request timed out; retry with the same operationId.' : 'Remote agent request failed; redirects are not permitted. Retry uncertain writes with the same operationId.', error.name === 'TimeoutError' ? 504 : 502);
    }
    let result;
    try { result = await response.json(); }
    catch { throw failure(`Remote agent returned invalid JSON (HTTP ${response.status}).`, response.ok ? 502 : response.status); }
    if (!response.ok) {
      const detail = typeof result?.error === 'string' ? result.error.replace(new RegExp(token, 'gi'), '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 600) : 'Request rejected.';
      throw failure(`Remote agent request failed (HTTP ${response.status}): ${detail}`, response.status);
    }
    return result;
  };
}

/** MCP and CLI share validation and business commands; neither writes SQL directly. */
export function createAgentRuntime(options = {}) {
  const catalog = getAgentCatalog().filter(tool => tool.name !== 'verification.set');
  const materialTool = catalog.find(tool => tool.name === 'material.import');
  if (materialTool) {
    materialTool.description += ' For MCP/CLI use localPath (absolute path); the transport reads and encodes the original file, with a 20 MB limit, and sends it to the configured local or remote ledger.';
    const payload = materialTool.inputSchema.properties.payload;
    delete payload.properties.contentBase64;
    payload.properties.localPath = { type: 'string', minLength: 1, description: 'Absolute path to the local original. File is copied, never removed.' };
    payload.required = payload.required.filter(key => !['contentBase64', 'filename'].includes(key));
    payload.required.push('localPath');
  }
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validators = new Map(catalog.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
  const apiUrl = options.local ? undefined : options.apiUrl ?? process.env.REIMBURSE_API_URL;
  const tokenFile = options.local ? undefined : options.tokenFile ?? process.env.REIMBURSE_AGENT_TOKEN_FILE;
  if (!apiUrl && tokenFile) throw failure('A token file was configured without a remote API URL; supply --api-url or use --local.');
  const remote = apiUrl ? createRemoteDispatcher(apiUrl, tokenFile) : null;
  const store = remote ? null : createStore({ dataDir: path.resolve(options.dataDir || path.join(appDirectory, 'data')), legacyDir: options.legacyDir ? path.resolve(options.legacyDir) : undefined });
  let closed = false;
  return {
    catalog,
    async execute(type, args = {}) {
      if (closed) throw failure('Agent runtime is closed.', 409);
      const validator = validators.get(type);
      if (!validator) throw Object.assign(new Error(`Agent tool unavailable: ${type}`), { statusCode: 404 });
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.hasOwn(args, 'actor') || Object.hasOwn(args, 'type')) {
        throw Object.assign(new Error('Arguments must be an object; actor and type are set by the agent transport.'), { statusCode: 400 });
      }
      if (!validator(args)) throw Object.assign(new Error(`Invalid arguments: ${ajv.errorsText(validator.errors)}`), { statusCode: 400 });
      let commandArgs = args;
      if (type === 'material.import') {
        const { localPath, ...payload } = args.payload;
        if (!path.isAbsolute(localPath)) throw Object.assign(new Error('localPath must be an absolute path.'), { statusCode: 400 });
        const handle = await open(localPath, 'r');
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size < 1 || stat.size > 20 * 1024 * 1024) throw Object.assign(new Error('Original must be a regular file between 1 byte and 20 MB.'), { statusCode: 413 });
          const bytes = await handle.readFile();
          if (bytes.length > 20 * 1024 * 1024) throw Object.assign(new Error('Original exceeds 20 MB.'), { statusCode: 413 });
          commandArgs = { ...args, payload: { ...payload, filename: payload.filename || path.basename(localPath), contentBase64: bytes.toString('base64') } };
        } finally { await handle.close(); }
      }
      const command = { ...commandArgs, type, actor: { type: 'agent', id: options.actorId || 'codex' } };
      return remote ? remote(command) : executeAgentCommand(store, command);
    },
    close() { if (!closed) { closed = true; store?.close(); } },
  };
}

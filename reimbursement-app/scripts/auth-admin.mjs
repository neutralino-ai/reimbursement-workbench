import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, lstatSync, openSync, fstatSync, fchmodSync, ftruncateSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { issueSetup } from '../server/cloud-auth.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function parse(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  if (argv.shift() !== 'issue-setup') throw new Error('支持命令：issue-setup。使用 --help 查看参数。');
  const result = { dataDir: process.env.REIMBURSE_DATA_DIR || path.join(appDir, 'data'), publicOrigin: process.env.REIMBURSE_PUBLIC_ORIGIN, basePath: process.env.REIMBURSE_BASE_PATH || '/reimbursement', frontendUrl: process.env.REIMBURSE_FRONTEND_URL || undefined, printUrl: false };
  const fields = new Map([['--data-dir', 'dataDir'], ['--public-origin', 'publicOrigin'], ['--base-path', 'basePath'], ['--frontend-url', 'frontendUrl']]);
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--print-url') result.printUrl = true;
    else if (fields.has(argv[index]) && argv[index + 1] && !argv[index + 1].startsWith('--')) result[fields.get(argv[index])] = argv[++index];
    else throw new Error('参数无效。使用 --help 查看用法。');
  }
  return result;
}

try {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('用法：node scripts/auth-admin.mjs issue-setup --public-origin https://example.org [--data-dir /private/data] [--base-path /reimbursement] [--frontend-url http://127.0.0.1:4317/] [--print-url]\n默认将 24 小时一次性初始化链接保存到私有文件，仅打印文件路径。--frontend-url 可指定独立 HTTPS 或本机 HTTP 前端。--print-url 显式请求将链接输出到 stdout；请直接重定向到私有文件，勿发送到日志。\n');
  } else {
    const result = await issueSetup(options);
    const destination = path.join(path.resolve(options.dataDir), 'auth', 'auth-setup-link.json');
    try { if (lstatSync(destination).isSymbolicLink()) throw new Error('初始化链接文件不能使用符号链接。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('初始化链接须保存到独立普通文件。');
      fchmodSync(fd, 0o600);
      ftruncateSync(fd, 0);
      writeFileSync(fd, JSON.stringify({ url: result.url, expiresAt: result.expiresAt }, null, 2) + '\n');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    process.stdout.write(JSON.stringify(options.printUrl ? { url: result.url, expiresAt: result.expiresAt } : { setupFile: destination, expiresAt: result.expiresAt }) + '\n');
  }
} catch (error) {
  process.stderr.write((error.message || '初始化链接未创建。') + '\n');
  process.exitCode = 1;
}

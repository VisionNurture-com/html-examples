/**
 * measure-extension-modes.mjs — 拡張機能が「プロジェクトローカル導入」と「同梱版」で結果を変えるのかを測る
 *
 * 使い方:
 *   node tools/measure-extension-modes.mjs
 *   node tools/measure-extension-modes.mjs --ext-dir ~/.vscode/extensions/html-validate.vscode-html-validate-2.15.5
 *   node tools/measure-extension-modes.mjs --out tools/results/010-extension-modes.json
 *
 * 公式は 3 つのモード（ローカル導入 / グローバル導入 / 同梱版）があると書いているが、
 * どの順で選ばれるかも、結果が変わるかも書いていない。だから測る。
 *
 * VS Code の GUI は使わない。拡張機能の言語サーバーを --stdio で直接起動し、
 * LSP の publishDiagnostics を受け取って数える。画面撮影の読み取り誤差が入らず、
 * ルール名と位置まで機械で比較できるため。
 *
 * 2 つの作業ディレクトリを一時的に作って比べる。
 *
 *   local  … node_modules/html-validate を持つ（このリポジトリの node_modules への symlink）
 *   bundled … node_modules を持たない（上位ディレクトリにも無い場所に作る）
 *
 * 依存: node のみ。VS Code 本体は起動しない。
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const SAMPLE = 'symptoms/010-markup-errors/broken.html';
const CONFIG_SOURCE = 'compare/010-validation-stages/.htmlvalidate.json';
const DIAGNOSTIC_TIMEOUT_MS = 20000;

/** 拡張機能の package.json contributes.configuration に宣言されている既定値。 */
const SETTINGS = {
  enable: true,
  validate: ['html', 'javascript', 'markdown', 'vue', 'vue-html'],
  configFile: '',
  trace: { server: 'off' },
};

function parseArgs(argv) {
  const opts = { out: 'tools/results/010-extension-modes.json', extDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') { opts.out = argv[i + 1]; i += 1; }
    else if (argv[i] === '--ext-dir') { opts.extDir = argv[i + 1]; i += 1; }
  }
  return opts;
}

/** インストール済み拡張機能のうち、版が最も新しいものを選ぶ。 */
function findExtension(explicit) {
  if (explicit) return explicit.replace(/^~/, homedir());
  const base = join(homedir(), '.vscode', 'extensions');
  const dirs = readdirSync(base).filter((name) => name.startsWith('html-validate.vscode-html-validate-')).sort();
  if (dirs.length === 0) throw new Error('html-validate.vscode-html-validate が見つからない');
  return join(base, dirs[dirs.length - 1]);
}

/** LSP の 1 メッセージを Content-Length 付きで書き出す。 */
function send(child, message) {
  const body = JSON.stringify(message);
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

/**
 * stdout を LSP のフレームとして読み進める。
 * ヘッダとボディが 1 回の data イベントに収まらないため、バッファに溜めて切り出す。
 */
function createReader(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = buffer.subarray(0, headerEnd).toString('utf8');
      const match = /Content-Length: (\d+)/i.exec(header);
      if (!match) return;
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      const body = buffer.subarray(start, start + length).toString('utf8');
      buffer = buffer.subarray(start + length);
      onMessage(JSON.parse(body));
    }
  };
}

/** 1 モードぶんの測定。サーバーを起動し、ファイルを開いて診断を待つ。 */
async function measureMode({ name, workdir, serverPath }) {
  const filePath = join(workdir, 'broken.html');
  const fileUri = pathToFileURL(filePath).href;
  const child = spawn(process.execPath, [serverPath, '--stdio'], { cwd: workdir });

  const diagnostics = [];
  let resolveDiagnostics;
  const gotDiagnostics = new Promise((r) => { resolveDiagnostics = r; });
  let nextId = 100;

  child.stdout.on('data', createReader((message) => {
    // サーバー → クライアントの要求には答える。無視すると初期化が進まない。
    if (message.method === 'workspace/configuration') {
      // 拡張機能が package.json で宣言している既定値をそのまま返す。
      // 空オブジェクトを返すと enable が未定義になり、検証が走らず 0 件になる（初回の取り違え）。
      send(child, { jsonrpc: '2.0', id: message.id, result: message.params.items.map(() => SETTINGS) });
      return;
    }
    if (message.method === 'client/registerCapability' || message.method === 'window/workDoneProgress/create') {
      send(child, { jsonrpc: '2.0', id: message.id, result: null });
      return;
    }
    if (message.method === 'textDocument/publishDiagnostics' && message.params.uri === fileUri) {
      diagnostics.push(...message.params.diagnostics);
      resolveDiagnostics();
    }
  }));

  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));

  send(child, {
    jsonrpc: '2.0',
    id: nextId += 1,
    method: 'initialize',
    params: {
      processId: process.pid,
      rootUri: pathToFileURL(workdir).href,
      workspaceFolders: [{ uri: pathToFileURL(workdir).href, name }],
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true, didChangeConfiguration: { dynamicRegistration: true } },
        textDocument: { synchronization: { dynamicRegistration: true }, publishDiagnostics: { relatedInformation: true } },
      },
      initializationOptions: {},
    },
  });
  send(child, { jsonrpc: '2.0', method: 'initialized', params: {} });
  send(child, { jsonrpc: '2.0', method: 'workspace/didChangeConfiguration', params: { settings: {} } });

  send(child, {
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: fileUri, languageId: 'html', version: 1, text: readFileSync(filePath, 'utf8') } },
  });

  const timedOut = await Promise.race([
    gotDiagnostics.then(() => false),
    new Promise((r) => setTimeout(() => r(true), DIAGNOSTIC_TIMEOUT_MS)),
  ]);
  // 追加の publishDiagnostics が続く場合があるため、少し待って締める
  await new Promise((r) => setTimeout(r, 1500));
  child.kill();

  const entries = diagnostics.map((d) => ({
    rule: typeof d.code === 'object' ? d.code.value : d.code,
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
    severity: d.severity,
    message: d.message,
  })).sort((a, b) => a.line - b.line || a.column - b.column || String(a.rule).localeCompare(String(b.rule)));

  return {
    mode: name,
    workdir,
    hasLocalInstall: existsSync(join(workdir, 'node_modules', 'html-validate')),
    timedOut,
    count: entries.length,
    rules: [...new Set(entries.map((e) => e.rule))].sort(),
    entries,
    stderrTail: stderr.join('').split('\n').filter(Boolean).slice(-3),
  };
}

const opts = parseArgs(process.argv.slice(2));
const source = process.cwd();
const extDir = findExtension(opts.extDir);
const serverPath = join(extDir, 'server', 'out', 'server.mjs');
if (!existsSync(serverPath)) throw new Error(`server not found: ${serverPath}`);

const root = mkdtempSync(join(tmpdir(), 'ext-modes-'));
const results = [];
try {
  for (const mode of ['local', 'bundled']) {
    const workdir = join(root, mode);
    mkdirSync(workdir, { recursive: true });
    copyFileSync(join(source, SAMPLE), join(workdir, 'broken.html'));
    copyFileSync(join(source, CONFIG_SOURCE), join(workdir, '.htmlvalidate.json'));
    if (mode === 'local') {
      mkdirSync(join(workdir, 'node_modules'), { recursive: true });
      symlinkSync(join(source, 'node_modules', 'html-validate'), join(workdir, 'node_modules', 'html-validate'));
    }
    results.push(await measureMode({ name: mode, workdir, serverPath }));
  }

  const [local, bundled] = results;
  // 両方 0 件だったときに「一致した」と書くと、検証が走らなかった失敗を成功と読み違える。
  // 診断が 1 件も来ていない、またはタイムアウトした場合は判定不能として扱う。
  const inconclusive = results.some((r) => r.timedOut || r.count === 0);
  const sameCount = local.count === bundled.count;
  const sameRules = JSON.stringify(local.rules) === JSON.stringify(bundled.rules);
  const samePositions = JSON.stringify(local.entries.map((e) => `${e.rule}@${e.line}:${e.column}`))
    === JSON.stringify(bundled.entries.map((e) => `${e.rule}@${e.line}:${e.column}`));

  const result = {
    measuredAt: new Date().toISOString(),
    env: { node: process.version, platform: process.platform, extension: extDir.split('/').pop() },
    sample: SAMPLE,
    method: 'LSP（拡張機能の言語サーバーを --stdio で直接起動し publishDiagnostics を数える）',
    modes: results,
    comparison: { inconclusive, sameCount, sameRules, samePositions },
    conclusion: inconclusive
      ? '判定不能。診断が届かなかったモードがある（タイムアウトまたは 0 件）。測定手順の不備であり、差がないという結論には使えない'
      : sameCount && sameRules && samePositions
        ? 'この題材では、ローカル導入と同梱版で件数・ルール名・位置が一致した'
        : 'ローカル導入と同梱版で結果が違う（差分は modes を突き合わせて確認する）',
  };

  mkdirSync(dirname(resolve(source, opts.out)), { recursive: true });
  writeFileSync(resolve(source, opts.out), `${JSON.stringify(result, null, 2)}\n`);

  for (const r of results) {
    console.log(`${r.mode}: localInstall=${r.hasLocalInstall} count=${r.count} rules=${r.rules.join(',') || '(none)'} timedOut=${r.timedOut}`);
    if (r.stderrTail.length) console.log(`  stderr: ${r.stderrTail.join(' | ')}`);
  }
  console.log(result.conclusion);
  console.log(`written: ${opts.out}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

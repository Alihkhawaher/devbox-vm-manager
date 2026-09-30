#!/usr/bin/env node
/*
 * devbox-vms - MCP server that lets Claude create sandbox VMs on demand and
 * run and test things inside them, through the devbox VM Manager.
 *
 * Transport: stdio, JSON-RPC 2.0, one JSON object per line (lib/mcp/protocol.js).
 * Tools: lib/mcp/tools.js (status, create_vm, exec, write_file, read_file,
 * upload, download, forward_port, deploy_image, setup, get_task, ...).
 *
 * Register it with an MCP host (Claude Desktop / Claude Code) using ABSOLUTE
 * paths - the GUI's "Connect Claude (MCP)" panel (GET /api/about) prints the
 * exact snippet for this install:
 *
 *   "devbox-vms": {
 *     "command": "<path to node>",
 *     "args": ["<this folder>/mcp-server.js"],
 *     "env": { "VM_MANAGER_ROOT": "<data folder>" }
 *   }
 *
 * The data folder is resolved like the manager's (--data <dir> >
 * VM_MANAGER_ROOT > an existing install in the home folder > ./data), so this
 * server and the manager always agree on the registry, the SSH key and the
 * access token. If no manager is running for that folder, the first tool call
 * starts one headless (no window, no browser; output in
 * <data>/logs/manager-console.log). It keeps running after this server exits,
 * like the VMs themselves.
 *
 * House rules for MCP servers (kept here, in this order):
 *   1. Nothing but protocol on stdout. Before ANY module is loaded, console.*
 *      and process.stdout.write are pointed at stderr; the protocol writes
 *      through the one saved reference to the real stdout. A stray
 *      console.log anywhere can never corrupt the stream.
 *   2. Exit when stdin closes: the host is gone, and so is every reason to
 *      stay alive (no orphaned copies piling up between host restarts).
 *   3. Never crash on bad input or a failing tool; errors go to stderr.
 *   4. restart_server builds its reply first and exits ~0.5 s after the reply
 *      is written; the host respawns the server on the next call.
 *
 * Check it with a real protocol conversation, not by loading it:
 *   node tools/mcp-probe.js mcp-server.js status
 *
 * Usage: node mcp-server.js [--data <dir>] [--help]
 */
'use strict';

// (1) must run before anything else is required
const WIRE = require.main === module ? takeStdout() : null;

function takeStdout() {
  const out = process.stdout;
  const realWrite = out.write.bind(out);
  const nodeUtil = require('util');
  const toErr = function () {
    try { process.stderr.write(nodeUtil.format.apply(null, arguments) + '\n'); } catch (e) { /* nowhere to report */ }
  };
  for (const m of ['log', 'info', 'debug', 'warn', 'dir', 'table', 'trace']) console[m] = toErr;
  out.write = function (chunk, encoding, cb) { return process.stderr.write(chunk, encoding, cb); };
  return realWrite;
}

const path = require('path');
const config = require('./lib/config');
const protocol = require('./lib/mcp/protocol');
const tools = require('./lib/mcp/tools');

const USAGE = [
  'Usage: node mcp-server.js [--data <dir>] [--help]',
  '',
  'MCP server (stdio) for the devbox VM Manager: lets Claude create sandbox VMs,',
  'run commands and copy files in them. Start it from an MCP host, not by hand.',
  '',
  '  --data <dir>   data folder of the VM manager (default: VM_MANAGER_ROOT, else',
  '                 an existing install in your home folder, else ./data)',
  '',
  'Check it with: node tools/mcp-probe.js mcp-server.js status',
].join('\n');

// Returns {data, help} or throws with a readable message.
function parseArgs(argv) {
  const out = { data: null, help: false };
  const args = (argv || []).slice();
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--data') {
      const v = args[i + 1];
      if (v === undefined || String(v).indexOf('--') === 0 || !String(v).trim()) throw new Error('--data needs a folder path');
      out.data = String(v).trim();
      i++;
    } else if (a.indexOf('--data=') === 0) {
      if (!a.slice(7).trim()) throw new Error('--data needs a folder path');
      out.data = a.slice(7).trim();
    } else {
      protocol.logErr('ignoring unknown argument: ' + a);
    }
  }
  return out;
}

function buildServer() {
  const server = protocol.createServer({ name: 'devbox-vms', version: config.version(), instructions: tools.INSTRUCTIONS });
  for (const t of tools.createTools()) server.addTool(t);
  return server;
}

function main(argv) {
  let opts;
  try { opts = parseArgs(argv); }
  catch (e) {
    process.stderr.write(e.message + '\n\n' + USAGE + '\n');
    process.exitCode = 2;
    return null;
  }
  if (opts.help) { process.stderr.write(USAGE + '\n'); return null; }
  // The data folder travels to a manager started from here as VM_MANAGER_ROOT,
  // so --data behaves exactly like the environment variable.
  if (opts.data) {
    process.env.VM_MANAGER_ROOT = path.resolve(opts.data);
    config.configure({});
  }

  // (3) last line of defence: report, keep serving
  process.on('uncaughtException', (e) => protocol.logErr('unexpected error (still serving): ' + ((e && e.stack) || e)));
  process.on('unhandledRejection', (e) => protocol.logErr('unhandled rejection (still serving): ' + ((e && e.stack) || e)));

  const write = WIRE || process.stdout.write.bind(process.stdout);
  let exiting = false;
  const exitNow = () => {
    if (exiting) return;
    exiting = true;
    // let queued replies reach the pipe, but never hang on a dead one
    try { write('', () => process.exit(0)); } catch (e) { process.exit(0); }
    setTimeout(() => process.exit(0), 1000).unref();
  };
  // a host that closed our stdout is gone as well
  process.stdout.on('error', exitNow);

  const server = buildServer();
  // (2) exit when the host closes stdin
  server.serve({ input: process.stdin, write: write, onClose: exitNow });
  protocol.logErr('ready (pid ' + process.pid + ', ' + server.tools.size + ' tools, data folder ' + config.CFG.root + ')');
  return server;
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { main, buildServer, parseArgs, USAGE };

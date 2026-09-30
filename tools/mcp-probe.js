#!/usr/bin/env node
/*
 * Prove an MCP server works with a real protocol conversation - not by
 * loading it.
 *
 * usage: node tools/mcp-probe.js <server.js> [tool_name] [json_args] [--timeout <s>] [--call-timeout <s>] [--expect <tool,tool,...>]
 *
 * Spawns `node <server.js>` the way an MCP host does (stdio pipes, the current
 * environment), then:
 *   initialize                  answered? protocol version supported? serverInfo,
 *                               capabilities.tools, instructions
 *   notifications/initialized   must NOT be answered
 *   ping                        must answer {}
 *   tools/list                  every tool's schema health: name, description,
 *                               inputSchema {type:object, properties}, each
 *                               property typed and described, required names
 *                               exist, no bogus {a, kw} schema, annotations
 *   --expect a,b,c              every named tool must be listed (a server that
 *                               lost tools - a module that failed to load, an
 *                               old copy still running - fails the probe)
 *   an unknown method           must answer -32601
 *   tools/call (optional)       answered, not isError; prints the reply
 *   stdout                      ANY non-JSON line fails (it corrupts the protocol)
 *   stdin closed                the server must exit by itself
 * and prints timing and the last stderr lines. Exit code 0 = PASS, 1 = FAIL.
 *
 * Examples:
 *   node tools/mcp-probe.js mcp-server.js status
 *   node tools/mcp-probe.js mcp-server.js list_vms
 *   node tools/mcp-probe.js mcp-server.js serial_log "{\"name\": \"web\", \"lines\": 20}"
 *   node tools/mcp-probe.js mcp-server.js --expect run_image,share_folder,list_containers
 *   node tools/mcp-probe.js mcp-server.js run_image "{\"image\": \"hello-world\", \"wait_for\": \"exit\", \"remove_on_exit\": true}"
 *
 * The server sees this process's environment, so VM_MANAGER_ROOT /
 * VM_MANAGER_PORT select the data folder / port of a manager it starts.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const SUPPORTED = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const TYPES = ['string', 'integer', 'number', 'boolean', 'array', 'object'];

function usage() {
  const doc = require('fs').readFileSync(__filename, 'utf8').split('\n');
  const i = doc.findIndex((l) => /^ \* usage:/.test(l));
  console.log(doc[i].replace(/^ \* /, ''));
  process.exit(2);
}

function parseCli(argv) {
  const o = { server: null, tool: null, args: {}, timeoutS: 60, callTimeoutS: 600, expect: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--timeout') o.timeoutS = Number(argv[++i]);
    else if (argv[i] === '--call-timeout') o.callTimeoutS = Number(argv[++i]);
    else if (argv[i] === '--expect') o.expect = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === '--help' || argv[i] === '-h') usage();
    else rest.push(argv[i]);
  }
  if (!rest.length) usage();
  o.server = path.resolve(rest[0]);
  o.tool = rest[1] || null;
  if (rest[2]) {
    try { o.args = JSON.parse(rest[2]); }
    catch (e) { console.log('FAIL  json_args is not valid JSON: ' + e.message); process.exit(1); }
  }
  if (!(o.timeoutS > 0) || !(o.callTimeoutS > 0)) { console.log('FAIL  timeouts must be positive numbers of seconds'); process.exit(1); }
  return o;
}

// Problems with one listed tool (hard) and advice (soft).
function checkTool(t) {
  const hard = [], soft = [];
  const n = t && t.name;
  if (typeof n !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(n)) hard.push('bad name ' + JSON.stringify(n));
  const desc = (t && t.description) || '';
  if (!desc.trim()) soft.push('no description (the model gets no documentation)');
  else if (desc.trim().length < 40) soft.push('very short description');
  const s = t && t.inputSchema;
  if (!s || s.type !== 'object' || !s.properties || typeof s.properties !== 'object') {
    hard.push('inputSchema is not {type:"object", properties:{...}}');
    return { hard, soft };
  }
  const props = Object.keys(s.properties);
  if (props.slice().sort().join(',') === 'a,kw') hard.push('bogus {a, kw} schema');
  for (const k of props) {
    const p = s.properties[k] || {};
    if (TYPES.indexOf(p.type) === -1 && !p.anyOf && !p.oneOf) hard.push('property ' + k + ' has no type');
    if (!p.description) soft.push('property ' + k + ' has no description');
    if (p.type === 'array' && !(p.items && p.items.type)) soft.push('array property ' + k + ' has no items type');
  }
  for (const r of s.required || []) if (props.indexOf(r) === -1) hard.push('required "' + r + '" is not a property');
  const a = t.annotations;
  if (!a) soft.push('no annotations (the host cannot tell reads from writes)');
  else {
    for (const k of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) if (typeof a[k] !== 'boolean') soft.push('annotations.' + k + ' missing');
    if (a.readOnlyHint === true && a.destructiveHint === true) hard.push('annotations say read-only AND destructive');
  }
  return { hard, soft };
}

// Names in `expected` that the listed tools lack.
function missingTools(tools, expected) {
  const have = new Set((tools || []).map((t) => t && t.name));
  return (expected || []).filter((n) => !have.has(n));
}

function main() {
  const o = parseCli(process.argv.slice(2));
  const t0 = Date.now();
  const child = spawn(process.execPath, [o.server], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const out = [];       // every stdout line
  const err = [];       // every stderr line
  const byId = new Map();
  const unsolicited = [];
  let exitInfo = null;
  let ok = true;
  const fail = (m) => { ok = false; console.log('FAIL  ' + m); };
  const good = (m) => console.log('ok    ' + m);
  const note = (m) => console.log('      ' + m);

  const lines = (stream, onLine) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) { const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); onLine(l); }
    });
    stream.on('end', () => { if (buf) onLine(buf); buf = ''; });
  };
  lines(child.stdout, (l) => {
    out.push(l);
    let j;
    try { j = JSON.parse(l); } catch (e) { return; }
    const items = Array.isArray(j) ? j : [j];
    for (const m of items) {
      if (m && m.id !== undefined && m.id !== null && ('result' in m || 'error' in m)) byId.set(m.id, m);
      else unsolicited.push(m);
    }
  });
  lines(child.stderr, (l) => err.push(l));
  child.on('exit', (code, signal) => { exitInfo = { code: code, signal: signal }; });
  child.on('error', (e) => { exitInfo = { code: null, error: e.message }; });

  const send = (obj) => { try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch (e) { /* reported by the wait */ } };
  const wait = (id, seconds) => new Promise((resolve) => {
    const end = Date.now() + seconds * 1000;
    const tick = () => {
      if (byId.has(id)) return resolve(byId.get(id));
      if (exitInfo || Date.now() > end) return resolve(null);
      setTimeout(tick, 20);
    };
    tick();
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const secs = (ms) => (ms / 1000).toFixed(2) + 's';

  (async () => {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-probe', version: '1' } } });
    const init = await wait(1, o.timeoutS);
    if (!init || !init.result) {
      fail('initialize: ' + (init ? 'error ' + JSON.stringify(init.error) : 'no answer') + (exitInfo ? ' (server exited: ' + JSON.stringify(exitInfo) + ')' : ''));
    } else {
      const r = init.result;
      good('initialize in ' + secs(Date.now() - t0) + '  -> ' + JSON.stringify(r.serverInfo) + ' protocol ' + r.protocolVersion);
      if (SUPPORTED.indexOf(r.protocolVersion) === -1) fail('unsupported protocolVersion ' + r.protocolVersion);
      if (r.protocolVersion !== '2025-06-18') note('asked for 2025-06-18, got ' + r.protocolVersion);
      if (!r.capabilities || !r.capabilities.tools) fail('capabilities.tools missing');
      if (!r.serverInfo || !r.serverInfo.name) fail('serverInfo.name missing');
      if (!r.instructions) note('no instructions in the initialize result');

      const before = unsolicited.length;
      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      send({ jsonrpc: '2.0', id: 2, method: 'ping', params: {} });
      const pong = await wait(2, o.timeoutS);
      if (!pong || !pong.result || Object.keys(pong.result).length) fail('ping: ' + (pong ? JSON.stringify(pong) : 'no answer'));
      else good('ping answered {}');

      const t1 = Date.now();
      send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
      const tl = await wait(3, o.timeoutS);
      const tools = (tl && tl.result && tl.result.tools) || [];
      let hard = 0;
      const softAll = [];
      for (const t of tools) {
        const c = checkTool(t);
        for (const h of c.hard) { hard++; console.log('      ' + t.name + ': ' + h); }
        for (const s of c.soft) softAll.push(t.name + ': ' + s);
      }
      if (!tools.length) fail('tools/list: no tools' + (tl && tl.error ? ' (' + JSON.stringify(tl.error) + ')' : ''));
      else if (hard) fail('tools/list: ' + tools.length + ' tools, ' + hard + ' schema problem(s) above');
      else good('tools/list: ' + tools.length + ' tools in ' + secs(Date.now() - t1) + ', schemas healthy');
      for (const s of softAll.slice(0, 12)) note('advice - ' + s);
      if (tools.length) {
        note(tools.map((t) => t.name + (t.annotations && t.annotations.readOnlyHint ? '(ro)' : (t.annotations && t.annotations.destructiveHint ? '(destructive)' : ''))).join(' '));
      }
      if (o.expect.length) {
        const missing = missingTools(tools, o.expect);
        if (missing.length) fail('tools/list lacks the expected tool(s): ' + missing.join(', '));
        else good('tools/list has all ' + o.expect.length + ' expected tools');
      }

      send({ jsonrpc: '2.0', id: 4, method: 'devbox/no-such-method', params: {} });
      const nm = await wait(4, o.timeoutS);
      if (!nm || !nm.error || nm.error.code !== -32601) fail('unknown method: expected error -32601, got ' + JSON.stringify(nm));
      else good('unknown method -> -32601');

      if (o.tool) {
        if (tools.length && !tools.some((t) => t.name === o.tool)) note('"' + o.tool + '" is not in tools/list');
        const t2 = Date.now();
        send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: o.tool, arguments: o.args } });
        const r5 = await wait(5, o.callTimeoutS);
        if (!r5) fail('tools/call ' + o.tool + ': no reply' + (exitInfo ? ' (server exited: ' + JSON.stringify(exitInfo) + ')' : ' within ' + o.callTimeoutS + ' s'));
        else if (r5.error) fail('tools/call ' + o.tool + ': protocol error ' + JSON.stringify(r5.error));
        else {
          const res = r5.result || {};
          if (res.isError) fail('tools/call ' + o.tool + ' in ' + secs(Date.now() - t2) + ' returned isError');
          else good('tools/call ' + o.tool + ' in ' + secs(Date.now() - t2));
          for (const b of (res.content || []).slice(0, 3)) {
            const txt = b.type === 'text' ? String(b.text) : '<' + b.type + ' block>';
            note(txt.slice(0, 1500).replace(/\n/g, '\n      ') + (txt.length > 1500 ? '\n      ... (' + txt.length + ' chars)' : ''));
          }
        }
      }
      await sleep(300);
      const answeredNotification = unsolicited.slice(before).filter((m) => m && (m.id === undefined || m.id === null) && ('result' in m));
      if (answeredNotification.length) fail('the server answered a notification: ' + JSON.stringify(answeredNotification[0]).slice(0, 200));
    }

    await sleep(200);
    const junk = out.filter((l) => l.trim() && !/^\s*[[{]/.test(l));
    const badJson = out.filter((l) => /^\s*[[{]/.test(l)).filter((l) => { try { JSON.parse(l); return false; } catch (e) { return true; } });
    if (junk.length || badJson.length) fail('stdout carried non-JSON (corrupts the protocol): ' + JSON.stringify(junk.concat(badJson).slice(0, 3).map((l) => l.slice(0, 160))));
    else good('stdout: ' + out.filter((l) => l.trim()).length + ' line(s), all JSON-RPC');

    // closing stdin must make the server exit on its own
    try { child.stdin.end(); } catch (e) { /* already gone */ }
    const tExit = Date.now();
    while (!exitInfo && Date.now() - tExit < 5000) await sleep(25);
    if (!exitInfo) { fail('the server did not exit within 5 s after stdin closed'); try { child.kill(); } catch (e) { /* ignore */ } }
    else good('exited ' + (exitInfo.code === null ? 'by ' + exitInfo.signal : 'with code ' + exitInfo.code) + ' ' + secs(Date.now() - tExit) + ' after stdin closed');

    if (err.length) {
      note('stderr (last lines):');
      for (const l of err.slice(-8)) note('| ' + l.slice(0, 200));
    }
    console.log('\n' + (ok ? 'PASS' : 'FAIL'));
    process.exit(ok ? 0 : 1);
  })().catch((e) => {
    console.log('FAIL  probe crashed: ' + ((e && e.stack) || e));
    try { child.kill(); } catch (x) { /* ignore */ }
    process.exit(1);
  });
}

if (require.main === module) main();

module.exports = { checkTool, missingTools, parseCli };

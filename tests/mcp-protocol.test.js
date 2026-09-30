'use strict';
/*
 * lib/mcp/protocol.js: JSON-RPC framing over a byte stream, MCP version
 * negotiation, the fixed method set, error codes, notifications never
 * answered, tool results, argument checking and schema generation.
 * Pure: no process, no network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');
const protocol = require('../lib/mcp/protocol');
const {
  createServer, ToolError, buildInputSchema, schemaProblems, coerceArgs, lineSplitter, negotiateVersion,
  SUPPORTED_VERSIONS, LATEST_VERSION,
} = protocol;

function demoServer() {
  const s = createServer({ name: 'demo', version: '9.9.9', instructions: 'use it wisely' });
  s.addTool({
    name: 'echo', title: 'Echo',
    description: 'Return the arguments it was given, after checking them.',
    params: {
      text: { type: 'string', required: true, description: 'Text to echo.' },
      times: { type: 'integer', default: 1, minimum: 1, maximum: 5, description: 'Repeat count.' },
      loud: { type: 'boolean', default: false, description: 'Upper-case it.' },
      mode: { type: 'string', enum: ['a', 'b'], description: 'A mode.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags.' },
      env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Env.' },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (a) => a,
  });
  s.addTool({
    name: 'boom', description: 'Always fails with a message written for the model.',
    params: {}, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: () => { throw new ToolError('the VM "x" is stopped - call start_vm first'); },
  });
  s.addTool({
    name: 'crash', description: 'Fails with an unexpected error (a bug).',
    params: {}, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: async () => { throw new TypeError('cannot read properties of undefined'); },
  });
  s.addTool({
    name: 'later', description: 'Registers something to run after its reply is written.',
    params: {}, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: (a, ctx) => { ctx.afterReply(() => { s.afterRan = true; }); return { ok: true }; },
  });
  return s;
}

const req = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params });

// Quiet the protocol's stderr diagnostics for tests that provoke them.
async function quietly(fn) {
  const orig = process.stderr.write;
  process.stderr.write = function () { return true; };
  try { return await fn(); } finally { process.stderr.write = orig; }
}

// Serve over in-memory streams; returns helpers to send lines and read replies.
function wire(server) {
  const input = new PassThrough();
  const lines = [];
  let closed = false;
  const writes = [];
  const handle = server.serve({
    input: input,
    write: (text, cb) => { writes.push(text); for (const l of text.split('\n')) if (l) lines.push(JSON.parse(l)); setImmediate(cb); },
    onClose: () => { closed = true; },
  });
  const waitFor = async (pred, ms) => {
    const end = Date.now() + (ms || 2000);
    while (Date.now() < end) {
      const hit = lines.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 5));
    }
    return null;
  };
  return { input, lines, writes, waitFor, handle, isClosed: () => closed };
}

test('protocol version negotiation: the client\'s when supported, else the newest', () => {
  assert.deepEqual(SUPPORTED_VERSIONS, ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
  for (const v of SUPPORTED_VERSIONS) assert.equal(negotiateVersion(v), v);
  assert.equal(negotiateVersion('1999-01-01'), LATEST_VERSION);
  assert.equal(negotiateVersion('2026-07-28'), LATEST_VERSION);
  assert.equal(negotiateVersion(undefined), LATEST_VERSION);
  assert.equal(LATEST_VERSION, '2025-11-25');
});

test('initialize answers version, capabilities, serverInfo and instructions', async () => {
  const s = demoServer();
  const r = await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, {});
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.deepEqual(r.result.capabilities, { tools: { listChanged: false }, prompts: { listChanged: false }, resources: { listChanged: false, subscribe: false } });
  assert.deepEqual(r.result.serverInfo, { name: 'demo', version: '9.9.9' });
  assert.equal(r.result.instructions, 'use it wisely');
  const r2 = await s.handle({ jsonrpc: '2.0', id: 'x', method: 'initialize', params: { protocolVersion: '3000-01-01' } }, {});
  assert.equal(r2.result.protocolVersion, LATEST_VERSION);
  assert.equal(r2.id, 'x', 'string ids are echoed');
});

test('ping, tools/list and the empty prompt/resource lists', async () => {
  const s = demoServer();
  assert.deepEqual((await s.handle({ jsonrpc: '2.0', id: 1, method: 'ping' }, {})).result, {});
  const tl = (await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, {})).result.tools;
  assert.deepEqual(tl.map((t) => t.name), ['echo', 'boom', 'crash', 'later']);
  assert.equal(tl[0].title, 'Echo');
  assert.equal(tl[0].annotations.title, 'Echo', 'the title is repeated in annotations for older hosts');
  assert.deepEqual((await s.handle({ jsonrpc: '2.0', id: 3, method: 'prompts/list' }, {})).result, { prompts: [] });
  assert.deepEqual((await s.handle({ jsonrpc: '2.0', id: 4, method: 'resources/list' }, {})).result, { resources: [] });
  assert.deepEqual((await s.handle({ jsonrpc: '2.0', id: 5, method: 'resources/templates/list' }, {})).result, { resourceTemplates: [] });
});

test('unknown method -> -32601 with the method name; invalid messages -> -32600', async () => {
  const s = demoServer();
  const r = await s.handle({ jsonrpc: '2.0', id: 7, method: 'sampling/createMessage' }, {});
  assert.deepEqual(r.error, { code: -32601, message: 'Method not found', data: 'sampling/createMessage' });
  assert.equal(r.id, 7);
  assert.equal((await s.handle('hello', {})).error.code, -32600);
  assert.equal((await s.handle([1], {})).error.code, -32600);
  assert.equal((await s.handle({ jsonrpc: '2.0', id: 8 }, {})).error.code, -32600, 'a request without a method');
  assert.equal((await s.handle({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' }, {})).error.code, -32600, 'an object id');
  const bad = await s.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: 'echo' }, {});
  assert.equal(bad.error.code, -32602);
});

test('notifications are never answered, whatever the method; client responses are ignored', async () => {
  const s = demoServer();
  for (const m of ['notifications/initialized', 'notifications/cancelled', 'no/such/method', 'tools/call', 'initialize']) {
    assert.equal(await s.handle({ jsonrpc: '2.0', method: m, params: {} }, {}), null, m);
    assert.equal(await s.handle({ jsonrpc: '2.0', id: null, method: m }, {}), null, m + ' with id null');
  }
  assert.equal(await s.handle({ jsonrpc: '2.0', id: 5, result: {} }, {}), null);
  assert.equal(await s.handle({ jsonrpc: '2.0', id: 5, error: { code: 1, message: 'x' } }, {}), null);
});

test('parse errors -> -32700 with id null; batches get an array; an empty batch is invalid', async () => {
  const s = demoServer();
  assert.deepEqual(await s.handleLine('{not json', {}), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  const batch = await s.handleLine(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }, { jsonrpc: '2.0', id: 2, method: 'nope' }]), {});
  assert.equal(batch.length, 2);
  assert.deepEqual(batch[0], { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(batch[1].error.code, -32601);
  assert.equal(await s.handleLine(JSON.stringify([{ jsonrpc: '2.0', method: 'notifications/x' }]), {}), null, 'only notifications: no reply');
  assert.equal((await s.handleLine('[]', {})).error.code, -32600);
});

test('tools/call: results are pretty JSON text; failures are isError with a readable message', async () => {
  const s = demoServer();
  const ok = await s.callTool({ name: 'echo', arguments: { text: 'hi' } }, {});
  assert.equal(ok.isError, false);
  assert.equal(ok.content.length, 1);
  assert.equal(ok.content[0].type, 'text');
  assert.equal(ok.content[0].text, JSON.stringify({ text: 'hi', times: 1, loud: false }, null, 2), 'defaults are filled in');

  const te = await s.callTool({ name: 'boom', arguments: {} }, {});
  assert.equal(te.isError, true);
  assert.equal(te.content[0].text, 'Error executing tool boom: the VM "x" is stopped - call start_vm first');

  const crash = await quietly(() => s.callTool({ name: 'crash' }, {}));
  assert.equal(crash.isError, true);
  assert.match(crash.content[0].text, /^Error executing tool crash: cannot read properties of undefined$/, 'never a bare "error"');

  const unknown = await s.callTool({ name: 'nope', arguments: {} }, {});
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /^Unknown tool: nope \(available: echo, boom, crash, later\)$/);
  assert.equal((await s.callTool({}, {})).isError, true, 'no name');
});

test('tools/call of an unknown tool is a JSON-RPC protocol error -32602 (MCP spec "Error Handling"), not a tool result', async () => {
  const s = demoServer();
  const r = await s.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope', arguments: {} } }, {});
  assert.equal(r.result, undefined);
  assert.equal(r.id, 7);
  assert.equal(r.error.code, -32602);
  assert.equal(r.error.message, 'Unknown tool: nope');
  assert.deepEqual(r.error.data.available, ['echo', 'boom', 'crash', 'later']);
  const noName = await s.handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: {} }, {});
  assert.equal(noName.error.code, -32602);
  // a known tool that fails is still an isError RESULT
  const failed = await s.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'boom', arguments: {} } }, {});
  assert.equal(failed.result.isError, true);
});

test('arguments: lax coercion like pydantic, strict where it matters, every problem named', () => {
  const schema = buildInputSchema(demoServer().tools.get('echo').def.params);
  assert.deepEqual(coerceArgs(schema, { text: 'a', times: '3', loud: 'yes' }), { text: 'a', times: 3, loud: true });
  assert.deepEqual(coerceArgs(schema, { text: 'a', times: 2.0, loud: 0 }), { text: 'a', times: 2, loud: false });
  assert.deepEqual(coerceArgs(schema, { text: 'a', tags: '["x","y"]', env: '{"A":"1"}' }), { text: 'a', times: 1, loud: false, tags: ['x', 'y'], env: { A: '1' } }, 'JSON-encoded lists/objects are accepted');
  assert.deepEqual(coerceArgs(schema, { text: 'a', mode: null, times: null }), { text: 'a', times: 1, loud: false }, 'null = not given');
  const bad = (args, re) => assert.throws(() => coerceArgs(schema, args), (e) => e instanceof ToolError && re.test(e.message));
  bad({}, /missing required argument "text"/);
  bad({ text: 123 }, /text must be text, got number/);
  bad({ text: 'a', times: 2.5 }, /times must be a whole number/);
  bad({ text: 'a', times: 9 }, /times must be at most 5/);
  bad({ text: 'a', times: 0 }, /times must be at least 1/);
  bad({ text: 'a', loud: 'maybe' }, /loud must be true or false/);
  bad({ text: 'a', mode: 'c' }, /mode must be one of "a", "b"/);
  bad({ text: 'a', tags: [1] }, /tags\[0\] must be text/);
  bad({ text: 'a', env: { A: 1 } }, /env\.A must be text/);
  bad({ text: 'a', timeout: 5 }, /unknown argument "timeout" \(valid: text, times, loud, mode, tags, env\)/);
  bad({ times: 'x', extra: 1 }, /unknown argument "extra".*missing required argument "text".*times must be a whole number/);
  assert.throws(() => coerceArgs(schema, [1]), /arguments must be an object/);
  assert.deepEqual(coerceArgs({ type: 'object', properties: {} }, undefined), {});
});

test('schema generation: types, descriptions, defaults, required, no extra properties', () => {
  const s = buildInputSchema({
    name: { type: 'string', required: true, description: 'The name.', minLength: 1 },
    wait: { type: 'boolean', default: true, description: 'Wait.' },
    ports: { type: 'array', items: { type: 'string' }, description: 'Ports.' },
    internalOnly: { type: 'string', description: 'x', required: false, somethingElse: 1 },
  });
  assert.deepEqual(s, {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The name.', minLength: 1 },
      wait: { type: 'boolean', description: 'Wait.', default: true },
      ports: { type: 'array', description: 'Ports.', items: { type: 'string' } },
      internalOnly: { type: 'string', description: 'x' },
    },
    required: ['name'],
    additionalProperties: false,
  });
  assert.deepEqual(buildInputSchema({}), { type: 'object', properties: {}, additionalProperties: false });
});

test('schemaProblems finds what a model or host would trip over', () => {
  const s = demoServer();
  for (const t of s.listTools()) assert.deepEqual(schemaProblems(t), [], t.name);
  const good = s.listTools()[0];
  const probs = (patch) => schemaProblems(Object.assign({}, good, patch));
  assert.match(probs({ name: 'bad name' }).join(), /bad tool name/);
  assert.match(probs({ description: '' }).join(), /description/);
  assert.match(probs({ inputSchema: { type: 'object', properties: { a: { type: 'string', description: 'x' }, kw: { type: 'object', description: 'y' } } } }).join(), /bogus \{a, kw\}/);
  assert.match(probs({ inputSchema: { type: 'object', properties: { x: { description: 'no type' } } } }).join(), /no valid type/);
  assert.match(probs({ inputSchema: { type: 'object', properties: { x: { type: 'string' } } } }).join(), /no description/);
  assert.match(probs({ inputSchema: { type: 'object', properties: {}, required: ['x'] } }).join(), /required x is not a property/);
  assert.match(probs({ inputSchema: { type: 'object', properties: { n: { type: 'integer', description: 'n', default: 'x' } } } }).join(), /default of n is invalid/);
  assert.match(probs({ annotations: undefined }).join(), /no annotations/);
  assert.match(probs({ annotations: { readOnlyHint: true, destructiveHint: true, openWorldHint: false } }).join(), /read-only tool cannot be destructive/);
});

test('framing: chunks split anywhere, CRLF, blank lines, a BOM and a final line without newline', () => {
  const got = [];
  const sp = lineSplitter((l) => got.push(l));
  const text = '﻿{"a":1}\r\n\n  \n{"b":"é€😀"}\n{"c":3}';
  const bytes = Buffer.from(text, 'utf8');
  for (let i = 0; i < bytes.length; i++) sp.push(bytes.subarray(i, i + 1)); // byte by byte: splits multi-byte chars
  assert.deepEqual(got, ['{"a":1}', '{"b":"é€😀"}']);
  sp.end();
  assert.deepEqual(got, ['{"a":1}', '{"b":"é€😀"}', '{"c":3}']);
});

test('serve(): one JSON reply per line, notifications silent, bad lines answered, input end closes', async () => {
  const s = demoServer();
  const w = wire(s);
  w.input.write(req(1, 'initialize', { protocolVersion: '2025-06-18' }) + '\n');
  w.input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  w.input.write('garbage\n');
  w.input.write(req(2, 'tools/call', { name: 'echo', arguments: { text: 'x' } }).slice(0, 20));
  w.input.write(req(2, 'tools/call', { name: 'echo', arguments: { text: 'x' } }).slice(20) + '\n');
  assert.ok(await w.waitFor((m) => m.id === 1));
  assert.ok(await w.waitFor((m) => m.id === 2 && m.result && m.result.isError === false));
  assert.ok(await w.waitFor((m) => m.id === null && m.error && m.error.code === -32700));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(w.lines.length, 3, 'the notification got no reply');
  for (const t of w.writes) assert.ok(t.endsWith('\n') && t.indexOf('\n') === t.length - 1, 'exactly one line per write');
  assert.equal(w.isClosed(), false);
  w.input.end();
  await w.handle.done;
  assert.equal(w.isClosed(), true);
});

test('serve(): a slow tool does not block ping (requests run concurrently)', async () => {
  const s = createServer({ name: 'x', version: '1' });
  let release;
  s.addTool({
    name: 'slow', description: 'Waits until the test releases it.', params: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: () => new Promise((r) => { release = r; }),
  });
  const w = wire(s);
  w.input.write(req(1, 'tools/call', { name: 'slow' }) + '\n' + req(2, 'ping') + '\n');
  assert.ok(await w.waitFor((m) => m.id === 2), 'ping answered while the tool runs');
  assert.equal(w.lines.some((m) => m.id === 1), false);
  release('finished');
  const r1 = await w.waitFor((m) => m.id === 1);
  assert.equal(r1.result.content[0].text, 'finished', 'a string result is sent as is');
  w.input.end();
});

test('serve(): afterReply callbacks run only after the reply was written', async () => {
  const s = demoServer();
  const input = new PassThrough();
  const pending = [];
  const written = [];
  s.serve({ input: input, write: (text, cb) => { written.push(text); pending.push(cb); } });
  input.write(req(1, 'tools/call', { name: 'later' }) + '\n');
  for (let i = 0; i < 100 && !written.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(written.length, 1, 'the reply was handed to the writer');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.afterRan, undefined, 'not before the write has completed');
  pending.shift()();
  assert.equal(s.afterRan, true);
  input.end();
});

test('serve(): a reply that cannot be serialised still gets an answer', async () => {
  const s = createServer({ name: 'x', version: '1' });
  s.addTool({ name: 'big', description: 'Returns a BigInt, which JSON cannot encode.', params: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, handler: () => ({ n: 10n }) });
  const w = wire(s);
  w.input.write(req(1, 'tools/call', { name: 'big' }) + '\n');
  const r = await quietly(() => w.waitFor((m) => m.id === 1));
  assert.ok(r, 'answered');
  assert.ok(r.error ? r.error.code === -32603 : r.result.isError === true);
  w.input.end();
});

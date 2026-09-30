'use strict';
/*
 * MCP (Model Context Protocol) over stdio: JSON-RPC 2.0, one JSON object per
 * line. Node standard library only - a minimal tools-only MCP server: tools
 * over stdio and nothing else, because that is all an MCP host needs from
 * this server, and a server that starts in milliseconds never misses the
 * host's 60 s start-up window.
 *
 * What it does (spec section 13):
 *   initialize                -> protocol version (the client's if supported,
 *                                else the newest), capabilities, serverInfo,
 *                                instructions
 *   notifications/*           -> never answered (a message without an id is a
 *                                notification, whatever its method)
 *   ping                      -> {}
 *   tools/list, tools/call    -> the registered tools
 *   prompts/list, resources/list, resources/templates/list -> empty lists
 *   anything else             -> -32601 Method not found
 *   a line that is not JSON   -> -32700 Parse error (id null)
 *   a message that is not a request -> -32600 Invalid Request
 * Nothing a client sends can crash the server: every handler runs inside
 * try/catch and an unexpected failure becomes -32603 or an isError result.
 *
 * Requests are handled CONCURRENTLY (not one at a time): a tool here can legitimately wait minutes for a VM to boot, and the
 * host's pings and other calls must still be answered meanwhile. Replies may
 * therefore arrive out of order, which JSON-RPC allows (they carry the id).
 *
 * Tools are declared with a compact parameter table that becomes the JSON
 * Schema the model sees (buildInputSchema) and drives argument checking
 * (coerceArgs). Coercion follows pydantic's lax rules, which MCP clients
 * expect ("5" is accepted for an integer, "yes" for a boolean, 123 is NOT
 * accepted for a string, 5.5 is not an integer). An UNKNOWN argument is
 * refused with a message naming the valid ones: silently dropping a
 * misspelt "timeout" would run the call with the default and look like
 * success.
 *
 * Tool results are {content:[{type:'text', text: JSON (2-space indent)}],
 * isError:false}. Failures are isError:true with a readable message - a
 * ToolError's message as written, any other error's message too (logged with
 * its stack on stderr), never a bare "error".
 *
 * This module never touches process.stdout itself: serve() is given the
 * writer, so the entry point decides what the protocol channel is. Requiring
 * it has no side effects.
 */
const nodeUtil = require('util');

const SUPPORTED_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const LATEST_VERSION = SUPPORTED_VERSIONS[SUPPORTED_VERSIONS.length - 1];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// A line longer than this is refused (Parse error) instead of being buffered
// forever: a host that never sends a newline must not exhaust memory.
const MAX_LINE_BYTES = 64 * 1024 * 1024;

// An error whose message is written for the model: shown as is.
class ToolError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'ToolError';
    if (extra) Object.assign(this, extra);
  }
}

// Diagnostics go to stderr, never stdout (stdout is the protocol channel).
function logErr() {
  try { process.stderr.write('devbox-vms: ' + nodeUtil.format.apply(null, arguments) + '\n'); } catch (e) { /* nowhere left to say it */ }
}

function negotiateVersion(asked) {
  return SUPPORTED_VERSIONS.indexOf(asked) !== -1 ? asked : LATEST_VERSION;
}

// ---------------------------------------------------------------------------
// schemas
// ---------------------------------------------------------------------------
// Keys of a parameter table entry that are copied into the JSON Schema.
const SCHEMA_KEYS = ['type', 'description', 'enum', 'default', 'minimum', 'maximum', 'minLength', 'maxLength',
  'items', 'additionalProperties', 'minItems', 'maxItems', 'pattern', 'examples'];
const TYPES = ['string', 'integer', 'number', 'boolean', 'array', 'object'];

// Parameter table -> JSON Schema for tools/list.
//   params: { name: {type, description, required?, default?, enum?, minimum?,
//             maximum?, items?, additionalProperties?, ...}, ... }  (ordered)
function buildInputSchema(params) {
  const properties = {};
  const required = [];
  for (const key of Object.keys(params || {})) {
    const p = params[key] || {};
    const s = {};
    for (const k of SCHEMA_KEYS) if (p[k] !== undefined) s[k] = p[k];
    properties[key] = s;
    if (p.required) required.push(key);
  }
  const schema = { type: 'object', properties: properties };
  if (required.length) schema.required = required;
  schema.additionalProperties = false;
  return schema;
}

// Health check of one tool definition as it will be listed (used by the
// tests and mirrors what tools/mcp-probe.js checks on the wire). Returns a
// list of problems; empty means healthy.
function schemaProblems(tool) {
  const out = [];
  const name = tool && tool.name;
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) out.push('bad tool name ' + JSON.stringify(name));
  const where = 'tool ' + name + ': ';
  if (!tool || typeof tool.description !== 'string' || tool.description.trim().length < 20) out.push(where + 'missing or too short description');
  const s = tool && tool.inputSchema;
  if (!s || s.type !== 'object' || !s.properties || typeof s.properties !== 'object') {
    out.push(where + 'inputSchema must be {type:"object", properties:{...}}');
    return out;
  }
  const props = Object.keys(s.properties);
  if (props.length === 2 && props.indexOf('a') !== -1 && props.indexOf('kw') !== -1) out.push(where + 'bogus {a, kw} schema');
  for (const k of props) {
    const p = s.properties[k];
    if (!p || TYPES.indexOf(p.type) === -1) out.push(where + 'property ' + k + ' has no valid type');
    else if (typeof p.description !== 'string' || !p.description.trim()) out.push(where + 'property ' + k + ' has no description');
    if (p && p.type === 'array' && (!p.items || !p.items.type)) out.push(where + 'array property ' + k + ' has no items type');
    if (p && p.default !== undefined) {
      try { coerceValue(p, p.default, k); } catch (e) { out.push(where + 'default of ' + k + ' is invalid: ' + e.message); }
    }
  }
  for (const r of s.required || []) if (props.indexOf(r) === -1) out.push(where + 'required ' + r + ' is not a property');
  const a = tool.annotations;
  if (!a || typeof a !== 'object') out.push(where + 'no annotations');
  else {
    for (const k of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
      if (typeof a[k] !== 'boolean') out.push(where + 'annotations.' + k + ' must be true or false');
    }
    if (a.readOnlyHint && a.destructiveHint) out.push(where + 'a read-only tool cannot be destructive');
  }
  return out;
}

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------
function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// Check (and leniently convert) one value against its schema. Throws an Error
// whose message says what was expected.
function coerceValue(schema, v, label) {
  const t = schema.type;
  let out = v;
  if (t === 'string') {
    if (typeof v !== 'string') throw new Error(label + ' must be text, got ' + typeName(v));
    if (schema.minLength !== undefined && v.length < schema.minLength) throw new Error(label + ' must not be empty');
    if (schema.maxLength !== undefined && v.length > schema.maxLength) throw new Error(label + ' is longer than ' + schema.maxLength + ' characters');
  } else if (t === 'integer') {
    if (typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v) out = v;
    else if (typeof v === 'string' && /^\s*-?\d{1,15}\s*$/.test(v)) out = parseInt(v, 10);
    else throw new Error(label + ' must be a whole number, got ' + JSON.stringify(v));
  } else if (t === 'number') {
    if (typeof v === 'number' && Number.isFinite(v)) out = v;
    else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) out = Number(v);
    else throw new Error(label + ' must be a number, got ' + JSON.stringify(v));
  } else if (t === 'boolean') {
    if (typeof v === 'boolean') out = v;
    else if (v === 1 || v === 0) out = v === 1;
    else if (typeof v === 'string' && /^(true|yes|on|1|false|no|off|0)$/i.test(v.trim())) out = /^(true|yes|on|1)$/i.test(v.trim());
    else throw new Error(label + ' must be true or false, got ' + JSON.stringify(v));
  } else if (t === 'array') {
    // Some clients send a structured argument JSON-encoded as a string.
    if (typeof v === 'string' && /^\s*\[/.test(v)) { try { out = JSON.parse(v); } catch (e) { /* reported below */ } }
    if (!Array.isArray(out)) throw new Error(label + ' must be a list, got ' + typeName(v));
    if (schema.minItems !== undefined && out.length < schema.minItems) throw new Error(label + ' needs at least ' + schema.minItems + ' entries');
    if (schema.maxItems !== undefined && out.length > schema.maxItems) throw new Error(label + ' has more than ' + schema.maxItems + ' entries');
    if (schema.items && schema.items.type) out = out.map((x, i) => coerceValue(schema.items, x, label + '[' + i + ']'));
  } else if (t === 'object') {
    if (typeof v === 'string' && /^\s*\{/.test(v)) { try { out = JSON.parse(v); } catch (e) { /* reported below */ } }
    if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error(label + ' must be an object, got ' + typeName(v));
    const ap = schema.additionalProperties;
    if (ap && typeof ap === 'object' && ap.type) {
      const o = {};
      for (const k of Object.keys(out)) o[k] = coerceValue(ap, out[k], label + '.' + k);
      out = o;
    }
  }
  if (schema.enum && schema.enum.indexOf(out) === -1) {
    throw new Error(label + ' must be one of ' + schema.enum.map((x) => JSON.stringify(x)).join(', ') + ', got ' + JSON.stringify(v));
  }
  if (typeof out === 'number') {
    if (schema.minimum !== undefined && out < schema.minimum) throw new Error(label + ' must be at least ' + schema.minimum + ', got ' + out);
    if (schema.maximum !== undefined && out > schema.maximum) throw new Error(label + ' must be at most ' + schema.maximum + ', got ' + out);
  }
  if (typeof out === 'string' && schema.pattern && !new RegExp(schema.pattern).test(out)) {
    throw new Error(label + ' has an invalid format: ' + JSON.stringify(out.slice(0, 80)));
  }
  return out;
}

// Validate a call's arguments against the tool's input schema. Returns a new
// object with defaults filled in; throws ToolError listing every problem.
// A null/undefined optional argument counts as "not given".
function coerceArgs(schema, args) {
  const props = (schema && schema.properties) || {};
  const req = (schema && schema.required) || [];
  const problems = [];
  const out = {};
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new ToolError('arguments must be an object');
  const unknown = Object.keys(args).filter((k) => !Object.prototype.hasOwnProperty.call(props, k));
  if (unknown.length) {
    problems.push('unknown argument' + (unknown.length > 1 ? 's ' : ' ') + unknown.map((k) => '"' + k + '"').join(', ') +
      ' (valid: ' + (Object.keys(props).join(', ') || 'none') + ')');
  }
  for (const k of Object.keys(props)) {
    const v = args[k];
    if (v === undefined || v === null) {
      if (req.indexOf(k) !== -1) problems.push('missing required argument "' + k + '"');
      else if (props[k].default !== undefined) out[k] = props[k].default;
      continue;
    }
    try { out[k] = coerceValue(props[k], v, k); } catch (e) { problems.push(e.message); }
  }
  if (problems.length) throw new ToolError('invalid arguments: ' + problems.join('; '));
  return out;
}

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------
function textResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value === undefined ? null : value, null, 2);
  return { content: [{ type: 'text', text: text }], isError: false };
}
function errorResult(text) {
  return { content: [{ type: 'text', text: String(text) }], isError: true };
}

// ---------------------------------------------------------------------------
// framing: bytes -> lines
// ---------------------------------------------------------------------------
// Returns {push(chunk), end()} calling onLine(string) for each complete,
// non-blank line. Lines are split on \n (a trailing \r is dropped) and decoded
// as UTF-8 only once complete, so a multi-byte character split across two
// chunks survives. end() delivers a final line that had no newline.
function lineSplitter(onLine, onOversize) {
  let parts = [];
  let size = 0;
  let skipping = false;
  const emit = (buf) => {
    let s = buf.toString('utf8');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // a BOM from a Windows host
    if (s.endsWith('\r')) s = s.slice(0, -1);
    if (s.trim()) onLine(s);
  };
  return {
    push(chunk) {
      let b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      for (;;) {
        const nl = b.indexOf(0x0a);
        if (nl === -1) {
          if (!skipping) {
            parts.push(b);
            size += b.length;
            if (size > MAX_LINE_BYTES) { parts = []; size = 0; skipping = true; if (onOversize) onOversize(); }
          }
          return;
        }
        const piece = b.subarray(0, nl);
        b = b.subarray(nl + 1);
        if (skipping) { skipping = false; continue; }
        const line = parts.length ? Buffer.concat(parts.concat([piece])) : piece;
        parts = [];
        size = 0;
        emit(line);
      }
    },
    end() {
      if (parts.length && !skipping) emit(Buffer.concat(parts));
      parts = [];
      size = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------
class McpServer {
  // opts: {name, version, instructions}
  constructor(opts) {
    opts = opts || {};
    this.name = opts.name || 'mcp-server';
    this.version = opts.version || '0.0.0';
    this.instructions = opts.instructions || null;
    this.tools = new Map();
    this.client = null;            // clientInfo from initialize
    this.protocolVersion = null;   // negotiated
  }

  // def: {name, title?, description, params (table) | inputSchema, annotations, handler(args, ctx)}
  addTool(def) {
    if (!def || !def.name || typeof def.handler !== 'function') throw new Error('a tool needs a name and a handler');
    const inputSchema = def.inputSchema || buildInputSchema(def.params || {});
    const listed = { name: def.name };
    if (def.title) listed.title = def.title;
    listed.description = def.description || '';
    listed.inputSchema = inputSchema;
    if (def.annotations) listed.annotations = Object.assign(def.title ? { title: def.title } : {}, def.annotations);
    this.tools.set(def.name, { def: def, listed: listed });
    return listed;
  }

  listTools() { return Array.from(this.tools.values()).map((t) => t.listed); }

  initializeResult(params) {
    const asked = params && typeof params === 'object' ? params.protocolVersion : undefined;
    this.protocolVersion = negotiateVersion(asked);
    if (params && params.clientInfo && typeof params.clientInfo === 'object') this.client = params.clientInfo;
    const r = {
      protocolVersion: this.protocolVersion,
      capabilities: {
        tools: { listChanged: false },
        prompts: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
      },
      serverInfo: { name: this.name, version: this.version },
    };
    if (this.instructions) r.instructions = this.instructions;
    return r;
  }

  // The JSON-RPC error for a tools/call naming no registered tool, or null.
  // The MCP spec (2025-06-18, 2025-11-25 "Error Handling") makes an unknown
  // tool a PROTOCOL error (-32602), unlike a tool that ran and failed.
  unknownToolError(params) {
    const name = params && typeof params === 'object' ? params.name : undefined;
    if (typeof name === 'string' && this.tools.has(name)) return null;
    return {
      code: INVALID_PARAMS,
      message: 'Unknown tool: ' + (typeof name === 'string' ? name : JSON.stringify(name === undefined ? null : name)),
      data: { available: Array.from(this.tools.keys()) },
    };
  }

  // tools/call -> a CallToolResult (never throws). An unknown tool is still
  // answered as an isError result here, for direct callers; handle() turns
  // it into the -32602 protocol error first.
  async callTool(params, ctx) {
    params = params && typeof params === 'object' ? params : {};
    const name = params.name;
    const entry = typeof name === 'string' ? this.tools.get(name) : null;
    if (!entry) {
      return errorResult('Unknown tool: ' + (typeof name === 'string' ? name : JSON.stringify(name)) +
        ' (available: ' + Array.from(this.tools.keys()).join(', ') + ')');
    }
    let args;
    try { args = coerceArgs(entry.listed.inputSchema, params.arguments); }
    catch (e) { return errorResult('Error executing tool ' + name + ': ' + e.message); }
    try {
      const value = await entry.def.handler(args, ctx);
      return textResult(value);
    } catch (e) {
      if (!(e instanceof ToolError)) logErr('tool ' + name + ' failed: ' + ((e && e.stack) || e));
      const msg = (e && e.message) ? String(e.message) : String(e || 'unknown failure');
      return errorResult('Error executing tool ' + name + ': ' + msg);
    }
  }

  // One decoded message -> a reply object, or null for notifications and
  // client responses. ctx collects afterReply callbacks.
  async handle(msg, ctx) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Invalid Request: expected a JSON-RPC object' } };
    }
    const id = msg.id;
    const hasId = id !== undefined && id !== null;
    if (typeof msg.method !== 'string') {
      // a response to something (we never send requests), or garbage
      if (!hasId || 'result' in msg || 'error' in msg) return null;
      return { jsonrpc: '2.0', id: id, error: { code: INVALID_REQUEST, message: 'Invalid Request: no method' } };
    }
    if (!hasId) return null; // a notification: never answered, whatever it is
    if (typeof id !== 'string' && typeof id !== 'number') {
      return { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Invalid Request: id must be a string or a number' } };
    }
    const params = msg.params;
    let result;
    try {
      switch (msg.method) {
        case 'initialize': result = this.initializeResult(params); break;
        case 'ping': result = {}; break;
        case 'tools/list': result = { tools: this.listTools() }; break;
        case 'tools/call':
          if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
            return { jsonrpc: '2.0', id: id, error: { code: INVALID_PARAMS, message: 'Invalid params: expected {name, arguments}' } };
          }
          {
            const unknown = this.unknownToolError(params);
            if (unknown) return { jsonrpc: '2.0', id: id, error: unknown };
          }
          result = await this.callTool(params, ctx);
          break;
        case 'prompts/list': result = { prompts: [] }; break;
        case 'resources/list': result = { resources: [] }; break;
        case 'resources/templates/list': result = { resourceTemplates: [] }; break;
        default:
          return { jsonrpc: '2.0', id: id, error: { code: METHOD_NOT_FOUND, message: 'Method not found', data: msg.method } };
      }
    } catch (e) {
      logErr('internal error in ' + msg.method + ': ' + ((e && e.stack) || e));
      return { jsonrpc: '2.0', id: id, error: { code: INTERNAL_ERROR, message: 'Internal error: ' + ((e && e.message) || e) } };
    }
    return { jsonrpc: '2.0', id: id, result: result };
  }

  // One raw line -> the reply to send (object, array for a batch, or null).
  async handleLine(line, ctx) {
    let msg;
    try { msg = JSON.parse(line); }
    catch (e) { return { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } }; }
    if (Array.isArray(msg)) {
      if (!msg.length) return { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Invalid Request: empty batch' } };
      const replies = (await Promise.all(msg.map((m) => this.handle(m, ctx)))).filter(Boolean);
      return replies.length ? replies : null;
    }
    return this.handle(msg, ctx);
  }

  // Run over a byte stream. opts:
  //   input   - readable stream (process.stdin)
  //   write   - (text, callback) => void; writes one line to the protocol channel
  //   onClose - called once when input ends or errors (the host is gone)
  // Returns {done: Promise resolving when input has closed}.
  serve(opts) {
    const input = opts.input;
    const write = opts.write;
    let closed = false;
    const send = (reply, after) => {
      let text;
      try { text = JSON.stringify(reply); }
      catch (e) {
        // a result that cannot be serialised must still get an answer
        const id = Array.isArray(reply) ? null : reply.id;
        text = JSON.stringify({ jsonrpc: '2.0', id: id, error: { code: INTERNAL_ERROR, message: 'Internal error: the reply could not be serialised: ' + e.message } });
      }
      try {
        write(text + '\n', () => { for (const fn of after) { try { fn(); } catch (e) { logErr('afterReply failed: ' + e.message); } } });
      } catch (e) { logErr('could not write a reply: ' + e.message); }
    };
    const onLine = (line) => {
      const after = [];
      const ctx = { afterReply: (fn) => { if (typeof fn === 'function') after.push(fn); }, server: this };
      Promise.resolve()
        .then(() => this.handleLine(line, ctx))
        .then((reply) => { if (reply) send(reply, after); else for (const fn of after) fn(); })
        .catch((e) => logErr('unexpected failure handling a message: ' + ((e && e.stack) || e)));
    };
    const splitter = lineSplitter(onLine, () => {
      send({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error: message larger than ' + MAX_LINE_BYTES + ' bytes' } }, []);
    });
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const finish = () => {
      if (closed) return;
      closed = true;
      try { splitter.end(); } catch (e) { /* ignore */ }
      resolveDone();
      if (opts.onClose) { try { opts.onClose(); } catch (e) { logErr('onClose failed: ' + e.message); } }
    };
    input.on('data', (chunk) => { try { splitter.push(chunk); } catch (e) { logErr('bad input chunk: ' + e.message); } });
    input.on('end', finish);
    input.on('close', finish);
    input.on('error', (e) => { logErr('input error: ' + e.message); finish(); });
    if (typeof input.resume === 'function') input.resume();
    return { done: done };
  }
}

function createServer(opts) { return new McpServer(opts); }

module.exports = {
  SUPPORTED_VERSIONS, LATEST_VERSION,
  PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL_ERROR,
  ToolError, McpServer, createServer,
  negotiateVersion, buildInputSchema, schemaProblems, coerceArgs, coerceValue,
  textResult, errorResult, lineSplitter, logErr,
};

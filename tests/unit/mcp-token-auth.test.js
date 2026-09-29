/**
 * @fileoverview Unit tests for requireMcpToken/isMcpEnabled
 * (server/mcp/auth.js) — the auth gate in front of the /mcp endpoint.
 * Exercises the middleware directly against fake req/res objects, no real
 * HTTP server involved (that end-to-end path is covered by
 * tests/e2e/17-mcp.test.js).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isMcpEnabled, requireMcpToken } from '../../server/mcp/auth.js';

/** Minimal fake Express req: `.get(name)` for headers, `.query` for the query string. */
function fakeReq({ authorization, token } = {}) {
  return {
    get: (name) => (name.toLowerCase() === 'authorization' ? authorization : undefined),
    query: token !== undefined ? { token } : {},
  };
}

/** Minimal fake Express res capturing status/json calls. */
function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

describe('isMcpEnabled', () => {
  const original = process.env.MCP_AUTH_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.MCP_AUTH_TOKEN;
    else process.env.MCP_AUTH_TOKEN = original;
  });

  test('false when MCP_AUTH_TOKEN is unset', () => {
    delete process.env.MCP_AUTH_TOKEN;
    assert.equal(isMcpEnabled(), false);
  });

  test('true when MCP_AUTH_TOKEN is set', () => {
    process.env.MCP_AUTH_TOKEN = 'some-token';
    assert.equal(isMcpEnabled(), true);
  });
});

describe('requireMcpToken', () => {
  const original = process.env.MCP_AUTH_TOKEN;
  beforeEach(() => { process.env.MCP_AUTH_TOKEN = 'correct-token'; });
  afterEach(() => {
    if (original === undefined) delete process.env.MCP_AUTH_TOKEN;
    else process.env.MCP_AUTH_TOKEN = original;
  });

  test('rejects a request with no token at all', () => {
    const res = fakeRes();
    let nextCalled = false;
    requireMcpToken(fakeReq(), res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.jsonrpc, '2.0');
    assert.equal(res.body.error.code, -32001);
  });

  test('rejects a wrong bearer token', () => {
    const res = fakeRes();
    let nextCalled = false;
    requireMcpToken(fakeReq({ authorization: 'Bearer wrong-token' }), res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  test('rejects a wrong query-param token', () => {
    const res = fakeRes();
    let nextCalled = false;
    requireMcpToken(fakeReq({ token: 'wrong-token' }), res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  test('accepts the correct bearer token', () => {
    const res = fakeRes();
    let nextCalled = false;
    requireMcpToken(fakeReq({ authorization: 'Bearer correct-token' }), res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null, 'should never touch res on success');
  });

  test('accepts the correct query-param token — the path Claude Desktop\'s custom-connector URL field needs, since it has no header input', () => {
    const res = fakeRes();
    let nextCalled = false;
    requireMcpToken(fakeReq({ token: 'correct-token' }), res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  test('rejects every request when MCP_AUTH_TOKEN itself is unset, even with a token presented', () => {
    delete process.env.MCP_AUTH_TOKEN;
    const res = fakeRes();
    let nextCalled = false;
    requireMcpToken(fakeReq({ token: 'correct-token' }), res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });
});

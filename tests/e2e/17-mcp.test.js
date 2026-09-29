/**
 * @fileoverview E2E tests for the /mcp endpoint (server/mcp/*) — drives it
 * with the real @modelcontextprotocol/sdk client over Streamable HTTP, the
 * same protocol path a real Claude Code or Claude Desktop connection would
 * use, rather than hand-rolled JSON-RPC over fetch. No Puppeteer/browser
 * needed here — this is a pure server-API surface.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, stopServer, resetData, TEST_PORT } from '../helpers/server.js';

const TOKEN = 'test-mcp-token';
const MCP_URL = `http://localhost:${TEST_PORT}/mcp?token=${TOKEN}`;

/**
 * Connects a fresh MCP client to the running test server.
 * @param {string} [url]
 * @returns {Promise<Client>}
 */
async function connectClient(url = MCP_URL) {
  const client = new Client({ name: 'e2e-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

/**
 * Calls a tool. On success, mcp/tools.js's `ok()` helper returns JSON text —
 * parse it. On failure, `fail()` returns a plain human-readable error
 * string instead, so `parsed` is left as that raw string rather than JSON.
 * @param {Client} client
 * @param {string} name
 * @param {Record<string, unknown>} [args]
 */
async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text;
  let parsed;
  if (!result.isError && text !== undefined) {
    parsed = JSON.parse(text);
  } else {
    parsed = text;
  }
  return { result, parsed };
}

describe('MCP server (/mcp)', () => {
  before(async () => {
    await startServer({ MCP_AUTH_TOKEN: TOKEN });
  });

  after(async () => {
    await stopServer();
  });

  test('rejects a connection with a missing/wrong token', async () => {
    const client = new Client({ name: 'e2e-test-bad-token', version: '0' });
    await assert.rejects(
      client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${TEST_PORT}/mcp?token=wrong`)))
    );
  });

  test('lists every registered tool', async () => {
    await resetData();
    const client = await connectClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'add_agent_to_chat',
      'create_agent',
      'create_chat',
      'delete_agent',
      'delete_chat',
      'get_chat',
      'list_agents',
      'list_chats',
      'remove_agent_from_chat',
      'restart_agent',
      'search_messages',
      'send_message',
      'update_agent',
      'update_chat',
    ]);
    await client.close();
  });

  test('create_agent -> create_chat -> send_message -> get_chat round trip drives real app state', async () => {
    await resetData();
    const client = await connectClient();

    const { parsed: agent } = await callTool(client, 'create_agent', {
      name: 'MCP E2E Agent',
      color: '#888888',
      // The test runner's own cwd — guaranteed to exist wherever this suite runs.
      workingDir: process.cwd(),
    });
    assert.ok(agent.id, 'create_agent should return the created agent');

    const { parsed: chat } = await callTool(client, 'create_chat', {
      name: 'mcp-e2e-chat',
      memberAgentIds: [agent.id],
    });
    assert.deepEqual(chat.memberAgentIds, [agent.id]);

    const { parsed: sendResult, result: sendRaw } = await callTool(client, 'send_message', {
      chatId: chat.id,
      content: 'Reply with exactly the single word OK and nothing else.',
    });
    assert.equal(sendRaw.isError, undefined, 'send_message should not error for a real chat/agent');
    assert.ok(sendResult.replies.length >= 1, 'should get at least one reply back');
    assert.equal(sendResult.replies[0].agentId, agent.id);

    // Confirm it's real, server-side state — not just echoed back — by
    // reading it via a separate tool call.
    const { parsed: fetched } = await callTool(client, 'get_chat', { chatId: chat.id });
    assert.equal(fetched.chat.id, chat.id);
    const agentMessages = fetched.messages.filter((m) => m.role === 'agent');
    assert.ok(agentMessages.length >= 1);

    await callTool(client, 'delete_chat', { chatId: chat.id, deleteAgents: true });
    await client.close();
  });

  test('get_chat on a nonexistent chat returns an isError result, not a thrown protocol error', async () => {
    await resetData();
    const client = await connectClient();
    const { result } = await callTool(client, 'get_chat', { chatId: 'no-such-chat' });
    assert.equal(result.isError, true);
    await client.close();
  });
});

describe('MCP server disabled (no MCP_AUTH_TOKEN)', () => {
  before(async () => {
    await startServer({ MCP_AUTH_TOKEN: '' });
  });

  after(async () => {
    await stopServer();
  });

  test('POST /mcp 404s — the route was never mounted, not just unauthorized', async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 404);
  });
});

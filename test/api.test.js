const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDb, createApp } = require('../server.js');

let server, base;
before(async () => {
  server = http.createServer(createApp(openDb(':memory:')));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function api(method, path, body, key) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
const register = async (name) => (await api('POST', '/api/agents/register', { name, owner: 'tester' })).data.api_key;

test('full flow: register, post, comment, reply, vote, read', async () => {
  const alice = await register('alice');
  const bob = await register('bob');
  assert.match(alice, /^af_/);

  const me = await api('GET', '/api/agents/me', null, alice);
  assert.equal(me.data.name, 'alice');
  assert.equal(me.data.key_hash, undefined);

  const post = await api('POST', '/api/posts', { board: 'general', title: 'Hello', body: 'First post' }, alice);
  assert.equal(post.status, 201);
  assert.equal(post.data.agent, 'alice');

  const c1 = await api('POST', `/api/posts/${post.data.id}/comments`, { body: 'Hi alice' }, bob);
  assert.equal(c1.status, 201);
  const c2 = await api('POST', `/api/posts/${post.data.id}/comments`, { body: 'Hi bob', parent_id: c1.data.id }, alice);
  assert.equal(c2.data.parent_id, c1.data.id);

  assert.equal((await api('POST', `/api/posts/${post.data.id}/vote`, { value: 1 }, bob)).data.score, 1);
  assert.equal((await api('POST', `/api/posts/${post.data.id}/vote`, { value: 1 }, bob)).data.score, 1, 'one vote per agent');
  assert.equal((await api('POST', `/api/posts/${post.data.id}/vote`, { value: -1 }, alice)).data.score, 0);

  const full = await api('GET', `/api/posts/${post.data.id}`);
  assert.equal(full.data.comments.length, 2);
  assert.equal(full.data.comment_count, 2);

  const list = await api('GET', '/api/posts?board=general');
  assert.equal(list.data.posts.length, 1);
  assert.equal((await api('GET', '/api/posts?board=other')).data.posts.length, 0);
});

test('writes require a valid api_key', async () => {
  assert.equal((await api('POST', '/api/posts', { board: 'general', title: 't', body: 'b' })).status, 401);
  assert.equal((await api('POST', '/api/posts', { board: 'general', title: 't', body: 'b' }, 'af_wrong')).status, 401);
});

test('post cooldown returns 429', async () => {
  const key = await register('carol');
  assert.equal((await api('POST', '/api/posts', { board: 'general', title: 'a', body: 'a' }, key)).status, 201);
  const second = await api('POST', '/api/posts', { board: 'general', title: 'b', body: 'b' }, key);
  assert.equal(second.status, 429);
});

test('validation errors', async () => {
  assert.equal((await api('POST', '/api/agents/register', { name: 'bad name!' })).status, 400);
  assert.equal((await api('POST', '/api/agents/register', { name: 'alice' })).status, 409);
  const key = await register('dave');
  assert.equal((await api('POST', '/api/posts', { board: 'General', title: 't', body: 'b' }, key)).status, 400);
  assert.equal((await api('POST', '/api/posts/999/comments', { body: 'x' }, key)).status, 404);
  assert.equal((await api('POST', '/api/posts/1/comments', { body: 'x', parent_id: 999 }, key)).status, 400);
  assert.equal((await api('POST', '/api/posts/1/vote', { value: 5 }, key)).status, 400);
  const bad = await fetch(base + '/api/agents/register', { method: 'POST', body: 'not json' });
  assert.equal(bad.status, 400);
});

test('serves web page and skill.md', async () => {
  assert.match(await (await fetch(base + '/')).text(), /Agent Forum/);
  assert.match(await (await fetch(base + '/skill.md')).text(), /untrusted data/);
});

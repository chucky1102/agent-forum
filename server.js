// Agent Forum MVP: a Moltbook-style board where only agents post and humans watch.
// Zero dependencies: node:http + node:sqlite (Node >= 22.5).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const POST_COOLDOWN_MS = 30 * 60 * 1000;   // 1 post per 30 min per agent
const COMMENT_LIMIT_PER_HOUR = 50;
const MAX_BODY_BYTES = 20 * 1024;

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      owner TEXT NOT NULL DEFAULT '',
      key_hash TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY,
      agent_id INTEGER NOT NULL REFERENCES agents(id),
      board TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES posts(id),
      parent_id INTEGER REFERENCES comments(id),
      agent_id INTEGER NOT NULL REFERENCES agents(id),
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS votes (
      post_id INTEGER NOT NULL REFERENCES posts(id),
      agent_id INTEGER NOT NULL REFERENCES agents(id),
      value INTEGER NOT NULL CHECK (value IN (-1, 1)),
      PRIMARY KEY (post_id, agent_id)
    );
  `);
  return db;
}

const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function requireString(obj, field, { max, pattern } = {}) {
  const v = obj[field];
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${field} is required`);
  if (max && v.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  if (pattern && !pattern.test(v)) throw new HttpError(400, `${field} has invalid format`);
  return v.trim();
}

function createApp(db) {
  const POST_SELECT = `
    SELECT p.id, p.board, p.title, p.body, p.created_at, a.name AS agent, a.owner,
      COALESCE((SELECT SUM(value) FROM votes v WHERE v.post_id = p.id), 0) AS score,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
    FROM posts p JOIN agents a ON a.id = p.agent_id`;

  function auth(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) throw new HttpError(401, 'Missing Authorization: Bearer <api_key>');
    const agent = db.prepare('SELECT id, name, description, owner, created_at FROM agents WHERE key_hash = ?').get(hashKey(m[1]));
    if (!agent) throw new HttpError(401, 'Invalid api_key');
    return agent;
  }

  function getPost(id) {
    const post = db.prepare(`${POST_SELECT} WHERE p.id = ?`).get(id);
    if (!post) throw new HttpError(404, 'Post not found');
    return post;
  }

  const routes = [
    ['POST', /^\/api\/agents\/register$/, (req, body) => {
      const name = requireString(body, 'name', { max: 32, pattern: /^[A-Za-z0-9_-]+$/ });
      const description = typeof body.description === 'string' ? body.description.slice(0, 500) : '';
      const owner = typeof body.owner === 'string' ? body.owner.slice(0, 64) : '';
      const apiKey = 'af_' + crypto.randomBytes(24).toString('hex');
      try {
        db.prepare('INSERT INTO agents (name, description, owner, key_hash, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(name, description, owner, hashKey(apiKey), Date.now());
      } catch (e) {
        if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'Agent name already taken');
        throw e;
      }
      return [201, { name, api_key: apiKey, note: 'Save this api_key now. It is shown only once.' }];
    }],

    ['GET', /^\/api\/agents\/me$/, (req) => [200, auth(req)]],

    ['GET', /^\/api\/posts$/, (req, body, m, url) => {
      const sort = url.searchParams.get('sort') === 'top' ? 'score DESC, p.id DESC' : 'p.id DESC';
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 25, 1), 100);
      const board = url.searchParams.get('board');
      const where = board ? 'WHERE p.board = ?' : '';
      const params = board ? [board, limit] : [limit];
      return [200, { posts: db.prepare(`${POST_SELECT} ${where} ORDER BY ${sort} LIMIT ?`).all(...params) }];
    }],

    ['POST', /^\/api\/posts$/, (req, body) => {
      const agent = auth(req);
      const board = requireString(body, 'board', { max: 32, pattern: /^[a-z0-9_-]+$/ });
      const title = requireString(body, 'title', { max: 200 });
      const text = requireString(body, 'body', { max: 10000 });
      const last = db.prepare('SELECT MAX(created_at) AS t FROM posts WHERE agent_id = ?').get(agent.id).t;
      if (last && Date.now() - last < POST_COOLDOWN_MS) {
        const wait = Math.ceil((POST_COOLDOWN_MS - (Date.now() - last)) / 1000);
        throw new HttpError(429, `Post cooldown: try again in ${wait}s`);
      }
      const { lastInsertRowid } = db.prepare('INSERT INTO posts (agent_id, board, title, body, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(agent.id, board, title, text, Date.now());
      return [201, getPost(lastInsertRowid)];
    }],

    ['GET', /^\/api\/posts\/(\d+)$/, (req, body, m) => {
      const post = getPost(Number(m[1]));
      post.comments = db.prepare(`
        SELECT c.id, c.parent_id, c.body, c.created_at, a.name AS agent
        FROM comments c JOIN agents a ON a.id = c.agent_id
        WHERE c.post_id = ? ORDER BY c.id`).all(post.id);
      return [200, post];
    }],

    ['POST', /^\/api\/posts\/(\d+)\/comments$/, (req, body, m) => {
      const agent = auth(req);
      const post = getPost(Number(m[1]));
      const text = requireString(body, 'body', { max: 5000 });
      const parentId = body.parent_id ?? null;
      if (parentId !== null && !db.prepare('SELECT 1 FROM comments WHERE id = ? AND post_id = ?').get(parentId, post.id)) {
        throw new HttpError(400, 'parent_id does not belong to this post');
      }
      const recent = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE agent_id = ? AND created_at > ?')
        .get(agent.id, Date.now() - 3600 * 1000).n;
      if (recent >= COMMENT_LIMIT_PER_HOUR) throw new HttpError(429, 'Comment limit reached: 50 per hour');
      const { lastInsertRowid } = db.prepare('INSERT INTO comments (post_id, parent_id, agent_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(post.id, parentId, agent.id, text, Date.now());
      return [201, { id: Number(lastInsertRowid), post_id: post.id, parent_id: parentId, agent: agent.name, body: text }];
    }],

    ['POST', /^\/api\/posts\/(\d+)\/vote$/, (req, body, m) => {
      const agent = auth(req);
      const post = getPost(Number(m[1]));
      if (body.value !== 1 && body.value !== -1 && body.value !== 0) throw new HttpError(400, 'value must be 1, -1 or 0');
      if (body.value === 0) {
        db.prepare('DELETE FROM votes WHERE post_id = ? AND agent_id = ?').run(post.id, agent.id);
      } else {
        db.prepare('INSERT INTO votes (post_id, agent_id, value) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET value = excluded.value')
          .run(post.id, agent.id, body.value);
      }
      return [200, { post_id: post.id, score: getPost(post.id).score }];
    }],
  ];

  const STATIC = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/skill.md': ['skill.md', 'text/markdown; charset=utf-8'],
  };

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        res.writeHead(200, { 'Content-Type': type });
        return res.end(fs.readFileSync(path.join(__dirname, 'public', file)));
      }
      for (const [method, pattern, handler] of routes) {
        const m = pattern.exec(url.pathname);
        if (!m || method !== req.method) continue;
        let body = {};
        if (method === 'POST') {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
            chunks.push(chunk);
          }
          try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new HttpError(400, 'Invalid JSON'); }
          if (typeof body !== 'object' || body === null) throw new HttpError(400, 'Body must be a JSON object');
        }
        const [status, data] = handler(req, body, m, url);
        return send(status, data);
      }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      send(e.status || 500, { error: e instanceof HttpError ? e.message : 'Internal error' });
    }
  };
}

if (require.main === module) {
  const db = openDb(process.env.DB_PATH || path.join(__dirname, 'forum.db'));
  const port = Number(process.env.PORT) || 3000;
  http.createServer(createApp(db)).listen(port, () => console.log(`Agent Forum on http://localhost:${port}`));
}

module.exports = { openDb, createApp };

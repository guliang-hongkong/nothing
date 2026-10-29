'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { URL } = require('node:url');
const { openDatabase } = require('./db');
const {
  avatarColor,
  createSessionToken,
  hashPassword,
  hashToken,
  newId,
  verifyPassword,
} = require('./security');

const SESSION_COOKIE = 'islands_session';
const SESSION_DAYS = 30;
const PASSWORD_RESET_HOURS = 24;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MUSIC_BYTES = 25 * 1024 * 1024;
const MUSIC_TYPES = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/webm': '.weba',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
};
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
};

class HttpError extends Error {
  constructor(status, message, retryAfter = null) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  );
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let settled = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (settled) return;
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        settled = true;
        reject(new HttpError(413, '请求内容过大'));
      }
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new HttpError(400, '请求格式不正确'));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, '请求格式不正确'));
      }
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers['content-length'] || 0);
    if (declaredLength > maxBytes) {
      reject(new HttpError(413, '音频文件不能超过 25MB'));
      return;
    }
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new HttpError(413, '音频文件不能超过 25MB'));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, '请求来源无效');
  }
  if (originHost !== req.headers.host) {
    throw new HttpError(403, '请求来源无效');
  }
}

function assertJsonMutation(req) {
  const contentType = String(req.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    throw new HttpError(415, '请使用 JSON 格式提交');
  }
  assertSameOrigin(req);
}

function cleanText(value, { label, min = 1, max, singleLine = false }) {
  if (typeof value !== 'string') {
    throw new HttpError(400, `请填写${label}`);
  }
  let text = value.replaceAll('\u0000', '').trim();
  if (singleLine) text = text.replace(/\s+/g, ' ');
  else text = text.replace(/\r\n?/g, '\n');
  const length = [...text].length;
  if (length < min) {
    throw new HttpError(400, min <= 1 ? `请填写${label}` : `${label}至少需要 ${min} 个字符`);
  }
  if (length > max) {
    throw new HttpError(400, `${label}不能超过 ${max} 个字符`);
  }
  return text;
}

function optionalText(value, { label, max, singleLine = false }) {
  if (value === undefined || value === null || value === '') return '';
  return cleanText(value, { label, min: 1, max, singleLine });
}

function makeExcerpt(content, length = 150) {
  const flat = String(content).replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > length ? `${chars.slice(0, length).join('')}…` : flat;
}

function authorFromRow(row, prefix = 'author_') {
  const id = row[`${prefix}id`];
  if (!id) return null;
  const [from, to] = avatarColor(row[`${prefix}username`] || id);
  return {
    id,
    username: row[`${prefix}username`],
    displayName: row[`${prefix}display_name`],
    avatarFrom: from,
    avatarTo: to,
  };
}

function userFromRow(row) {
  const [avatarFrom, avatarTo] = avatarColor(row.username || row.id);
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio || '',
    avatarFrom,
    avatarTo,
    createdAt: row.created_at,
    isAdmin: Boolean(row.is_admin),
  };
}

function topicFromRow(row, includeContent = false) {
  const topic = {
    id: row.id,
    title: row.title,
    excerpt: makeExcerpt(row.content),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    isPinned: Boolean(row.is_pinned),
    isLocked: Boolean(row.is_locked),
    views: row.views,
    replyCount: row.reply_count,
    likeCount: row.like_count,
    liked: Boolean(row.liked),
    category: {
      id: row.category_id,
      slug: row.category_slug,
      name: row.category_name,
      icon: row.category_icon,
    },
    author: authorFromRow(row),
  };
  if (includeContent) topic.content = row.content;
  return topic;
}

function replyFromRow(row) {
  return {
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    likeCount: row.like_count,
    liked: Boolean(row.liked),
    author: authorFromRow(row),
  };
}

const TOPIC_SELECT = `
  SELECT t.id, t.title, t.content, t.created_at, t.updated_at, t.last_activity_at,
         t.is_pinned, t.is_locked, t.views, t.category_id,
         c.slug AS category_slug, c.name AS category_name, c.icon AS category_icon,
         u.id AS author_id, u.username AS author_username, u.display_name AS author_display_name,
         (SELECT COUNT(*) FROM replies r WHERE r.topic_id = t.id) AS reply_count,
         (SELECT COUNT(*) FROM likes l WHERE l.target_type = 'topic' AND l.target_id = t.id) AS like_count,
         EXISTS(SELECT 1 FROM likes l WHERE l.target_type = 'topic' AND l.target_id = t.id AND l.user_id = ?) AS liked
  FROM topics t
  JOIN categories c ON c.id = t.category_id
  JOIN users u ON u.id = t.user_id
`;

function createForumServer(options = {}) {
  const dbPath = options.dbPath || path.join(__dirname, '..', 'data', 'forum.db');
  const publicDir = path.resolve(options.publicDir || path.join(__dirname, '..', 'public'));
  const dataDir =
    dbPath === ':memory:'
      ? path.join(__dirname, '..', 'data')
      : path.dirname(path.resolve(dbPath));
  const musicDir = path.resolve(options.musicDir || path.join(dataDir, 'music'));
  const db = openDatabase(dbPath, { seed: options.seed !== false });
  fs.mkdirSync(musicDir, { recursive: true });
  const sseClients = new Map();
  const rateBuckets = new Map();
  let lastSessionCleanup = 0;

  const statements = {
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByUsername: db.prepare('SELECT * FROM users WHERE username_key = ?'),
    publicUser: db.prepare('SELECT id, username, display_name, bio, created_at, is_admin FROM users WHERE id = ?'),
    session: db.prepare(`
      SELECT s.token_hash, u.id, u.username, u.display_name, u.bio, u.created_at, u.is_admin
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `),
    unreadMessages: db.prepare(`
      SELECT COUNT(*) AS count
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.sender_id <> ? AND m.read_at IS NULL
        AND (c.user_a_id = ? OR c.user_b_id = ?)
    `),
  };

  function cleanupSessions() {
    const now = Date.now();
    if (now - lastSessionCleanup < 60 * 60 * 1000) return;
    lastSessionCleanup = now;
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date(now).toISOString());
  }

  function getAuth(req) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    if (!token || token.length > 200) return null;
    const tokenHash = hashToken(token);
    const row = statements.session.get(tokenHash, new Date().toISOString());
    if (!row) return null;
    return { user: userFromRow(row), tokenHash };
  }

  function requireAuth(req) {
    const auth = getAuth(req);
    if (!auth) throw new HttpError(401, '请先登录');
    return auth;
  }

  function setSessionCookie(req, res, token) {
    const secure = Boolean(req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https';
    const parts = [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
    ];
    if (secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  function clearSessionCookie(req, res) {
    const secure = Boolean(req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https';
    const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  async function createSession(req, res, userId) {
    cleanupSessions();
    const token = createSessionToken();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
      hashToken(token),
      userId,
      createdAt.toISOString(),
      expiresAt.toISOString(),
    );
    setSessionCookie(req, res, token);
  }

  function getUnreadMessages(userId) {
    return statements.unreadMessages.get(userId, userId, userId).count;
  }

  function summaryFor(userId) {
    return { unreadMessages: getUnreadMessages(userId) };
  }

  function getPrimaryAdmin() {
    return db
      .prepare('SELECT id, username, display_name FROM users WHERE is_admin = 1 ORDER BY created_at ASC LIMIT 1')
      .get();
  }

  function ensureConversation(userOne, userTwo) {
    const [userA, userB] = [userOne, userTwo].sort();
    let conversation = db
      .prepare('SELECT * FROM conversations WHERE user_a_id = ? AND user_b_id = ?')
      .get(userA, userB);
    if (conversation) return conversation;
    const now = new Date().toISOString();
    try {
      db.prepare('INSERT INTO conversations (id, user_a_id, user_b_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
        newId(),
        userA,
        userB,
        now,
        now,
      );
    } catch (error) {
      if (!String(error.message).includes('UNIQUE')) throw error;
    }
    conversation = db
      .prepare('SELECT * FROM conversations WHERE user_a_id = ? AND user_b_id = ?')
      .get(userA, userB);
    return conversation;
  }

  function createDirectMessage(senderId, recipientId, content) {
    const conversation = ensureConversation(senderId, recipientId);
    const now = new Date().toISOString();
    const id = newId();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO messages (id, conversation_id, sender_id, content, created_at, read_at) VALUES (?, ?, ?, ?, ?, NULL)').run(
        id,
        conversation.id,
        senderId,
        content,
        now,
      );
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversation.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const sender = db.prepare('SELECT display_name FROM users WHERE id = ?').get(senderId);
    const message = {
      id,
      content,
      createdAt: now,
      senderId,
      mine: true,
      senderDisplayName: sender?.display_name || '离岛',
    };
    for (const userId of [senderId, recipientId]) {
      broadcastToUser(userId, 'message:new', {
        type: 'message:new',
        conversationId: conversation.id,
        message,
        unreadMessages: getUnreadMessages(userId),
      });
    }
    return message;
  }

  function musicFromRow(row, viewer = null) {
    const [avatarFrom, avatarTo] = avatarColor(row.submitter_username || row.user_id);
    const isMine = Boolean(viewer && viewer.id === row.user_id);
    return {
      id: row.id,
      title: row.title,
      artist: row.artist,
      genre: row.genre,
      description: row.description,
      duration: row.duration,
      status: row.status,
      reviewNote: row.review_note,
      fileSize: row.file_size,
      mimeType: row.mime_type,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
      audioUrl: `/api/music/${encodeURIComponent(row.id)}/audio`,
      isMine,
      canListen: row.status === 'approved' || Boolean(viewer && (viewer.isAdmin || isMine)),
      submitter: {
        id: row.user_id,
        username: row.submitter_username,
        displayName: row.submitter_display_name,
        avatarFrom,
        avatarTo,
        isAdmin: Boolean(row.submitter_is_admin),
      },
    };
  }

  function getMusicCounts(auth) {
    const approved = db.prepare("SELECT COUNT(*) AS count FROM music WHERE status = 'approved'").get().count;
    let mine = 0;
    let pending = 0;
    if (auth) {
      mine = db.prepare('SELECT COUNT(*) AS count FROM music WHERE user_id = ?').get(auth.user.id).count;
      if (auth.user.isAdmin) {
        pending = db.prepare("SELECT COUNT(*) AS count FROM music WHERE status = 'pending'").get().count;
      }
    }
    return { approved, mine, pending };
  }

  function getClientIp(req) {
    return req.socket.remoteAddress || 'unknown';
  }

  function checkRate(key, limit, windowMs) {
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (rateBuckets.size > 5000) {
      for (const [bucketKey, value] of rateBuckets) {
        if (value.resetAt <= now) rateBuckets.delete(bucketKey);
      }
    }
    if (bucket.count > limit) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    }
    return { allowed: true, retryAfter: 0 };
  }

  function enforceRate(key, limit, windowMs, res) {
    const result = checkRate(key, limit, windowMs);
    if (!result.allowed) {
      if (res) res.setHeader('Retry-After', String(result.retryAfter));
      throw new HttpError(429, '操作太频繁了，请稍后再试', result.retryAfter);
    }
  }

  function getCategories() {
    return db
      .prepare(`
        SELECT c.*,
          (SELECT COUNT(*) FROM topics t WHERE t.category_id = c.id) AS topic_count,
          (SELECT MAX(t.last_activity_at) FROM topics t WHERE t.category_id = c.id) AS last_activity_at
        FROM categories c ORDER BY c.sort_order
      `)
      .all()
      .map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        icon: row.icon,
        topicCount: row.topic_count,
        lastActivityAt: row.last_activity_at,
      }));
  }

  function getStats() {
    const counts = db
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM users) AS users,
          (SELECT COUNT(*) FROM topics) AS topics,
          (SELECT COUNT(*) FROM replies) AS replies
      `)
      .get();
    const activeUsers = db
      .prepare(`
        SELECT u.id, u.username, u.display_name, MAX(activity.at) AS last_active_at
        FROM users u
        JOIN (
          SELECT user_id, MAX(created_at) AS at FROM topics GROUP BY user_id
          UNION ALL
          SELECT user_id, MAX(created_at) AS at FROM replies GROUP BY user_id
        ) activity ON activity.user_id = u.id
        GROUP BY u.id
        ORDER BY last_active_at DESC
        LIMIT 5
      `)
      .all()
      .map((row) => {
        const [avatarFrom, avatarTo] = avatarColor(row.username);
        return {
          id: row.id,
          username: row.username,
          displayName: row.display_name,
          avatarFrom,
          avatarTo,
          lastActiveAt: row.last_active_at,
        };
      });
    return {
      users: counts.users,
      topics: counts.topics,
      replies: counts.replies,
      online: sseClients.size,
      activeUsers,
    };
  }

  function broadcastToUser(userId, event, payload) {
    const clients = sseClients.get(userId);
    if (!clients) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
      try {
        client.res.write(frame);
      } catch {
        // The close handler will remove broken clients.
      }
    }
  }

  function addSseClient(req, res, userId) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(`event: ready\ndata: ${JSON.stringify({ online: sseClients.size + 1 })}\n\n`);

    const client = { res, heartbeat: null };
    let clients = sseClients.get(userId);
    if (!clients) {
      clients = new Set();
      sseClients.set(userId, clients);
    }
    clients.add(client);
    client.heartbeat = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        // Ignore; close cleanup follows.
      }
    }, 25000);
    client.heartbeat.unref?.();

    const cleanup = () => {
      if (client.heartbeat) clearInterval(client.heartbeat);
      const set = sseClients.get(userId);
      if (set) {
        set.delete(client);
        if (set.size === 0) sseClients.delete(userId);
      }
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
  }

  function topicRowsFor(options) {
    const { where = [], params = [], sort = 'latest', limit = 12, offset = 0, viewerId = null } = options;
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    let orderSql = 'ORDER BY t.is_pinned DESC, t.last_activity_at DESC';
    if (sort === 'hot') {
      orderSql =
        'ORDER BY t.is_pinned DESC, (like_count * 4 + reply_count * 3 + t.views / 20.0) DESC, t.last_activity_at DESC';
    }
    const rows = db
      .prepare(`
        ${TOPIC_SELECT}
        ${whereSql}
        ${orderSql}
        LIMIT ? OFFSET ?
      `)
      .all(viewerId || '', ...params, limit, offset);
    return rows.map((row) => topicFromRow(row));
  }

  function topicDetail(id, viewerId) {
    const row = db
      .prepare(`
        ${TOPIC_SELECT}
        WHERE t.id = ?
      `)
      .get(viewerId || '', id);
    return row ? topicFromRow(row, true) : null;
  }

  function conversationForUser(id, userId) {
    return db
      .prepare(`
        SELECT c.*,
          (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id <> ? AND m.read_at IS NULL) AS unread
        FROM conversations c
        WHERE c.id = ? AND (c.user_a_id = ? OR c.user_b_id = ?)
      `)
      .get(userId, id, userId, userId);
  }

  function otherUserFor(conversation, userId) {
    const otherId = conversation.user_a_id === userId ? conversation.user_b_id : conversation.user_a_id;
    return statements.publicUser.get(otherId);
  }

  async function handleApi(req, res, pathname, url) {
    const segments = pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
    const method = req.method;
    const api = segments.slice(1);

    if (pathname === '/api/health' && method === 'GET') {
      sendJson(res, 200, { ok: true, name: "Island's forum", time: new Date().toISOString() });
      return;
    }

    if (pathname === '/api/auth/register' && method === 'POST') {
      enforceRate(`register:${getClientIp(req)}`, 5, 60 * 60 * 1000, res);
      const body = await readJsonBody(req);
      const username = cleanText(body.username, { label: '用户名', min: 3, max: 20, singleLine: true });
      const usernameKey = username.toLowerCase();
      if (!/^[A-Za-z0-9_\u4e00-\u9fa5]+$/.test(username)) {
        throw new HttpError(400, '用户名只能使用中文、字母、数字或下划线');
      }
      const displayName = cleanText(body.displayName || username, {
        label: '昵称',
        min: 1,
        max: 24,
        singleLine: true,
      });
      if (typeof body.password !== 'string') throw new HttpError(400, '请填写密码');
      if (body.password.length < 8) throw new HttpError(400, '密码至少需要 8 个字符');
      if (body.password.length > 128) throw new HttpError(400, '密码不能超过 128 个字符');
      if (statements.userByUsername.get(usernameKey)) throw new HttpError(409, '这个用户名已经被使用了');

      const now = new Date().toISOString();
      const userId = newId();
      const passwordHash = await hashPassword(body.password);
      try {
        db.prepare(`
          INSERT INTO users (id, username, username_key, display_name, password_hash, bio, created_at)
          VALUES (?, ?, ?, ?, ?, '', ?)
        `).run(userId, username, usernameKey, displayName, passwordHash, now);
      } catch (error) {
        if (String(error.message).includes('UNIQUE')) throw new HttpError(409, '这个用户名已经被使用了');
        throw error;
      }
      await createSession(req, res, userId);
      const row = statements.userById.get(userId);
      sendJson(res, 201, { user: userFromRow(row), summary: summaryFor(userId) });
      return;
    }

    if (pathname === '/api/auth/login' && method === 'POST') {
      enforceRate(`login:${getClientIp(req)}`, 12, 5 * 60 * 1000, res);
      const body = await readJsonBody(req);
      if (typeof body.username !== 'string' || typeof body.password !== 'string') {
        throw new HttpError(400, '请输入用户名和密码');
      }
      const usernameKey = body.username.trim().toLowerCase();
      const row = statements.userByUsername.get(usernameKey);
      const valid = row ? await verifyPassword(body.password, row.password_hash) : false;
      if (!row || !valid) throw new HttpError(401, '用户名或密码不正确');
      await createSession(req, res, row.id);
      sendJson(res, 200, { user: userFromRow(row), summary: summaryFor(row.id) });
      return;
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      const auth = getAuth(req);
      if (auth) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(auth.tokenHash);
      clearSessionCookie(req, res);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/auth/me' && method === 'GET') {
      const auth = getAuth(req);
      if (!auth) {
        sendJson(res, 200, { user: null, summary: { unreadMessages: 0 } });
        return;
      }
      sendJson(res, 200, { user: auth.user, summary: summaryFor(auth.user.id) });
      return;
    }

    if (pathname === '/api/auth/password-reset/request' && method === 'POST') {
      enforceRate(`password-reset:${getClientIp(req)}`, 6, 60 * 60 * 1000, res);
      const body = await readJsonBody(req);
      const username = cleanText(body.username, { label: '用户名', min: 1, max: 20, singleLine: true });
      const user = db
        .prepare('SELECT id, username, display_name, is_admin FROM users WHERE username_key = ?')
        .get(username.toLowerCase());
      if (!user) throw new HttpError(404, '账号不存在');
      if (user.is_admin) throw new HttpError(400, '管理员账号请直接在服务器上重置');
      enforceRate(`password-reset-user:${user.id}`, 3, 15 * 60 * 1000, res);

      const token = createSessionToken();
      const id = newId();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + PASSWORD_RESET_HOURS * 60 * 60 * 1000);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(user.id);
        db.prepare(`
          INSERT INTO password_resets (id, user_id, token_hash, status, note, requested_at, expires_at)
          VALUES (?, ?, ?, 'pending', '', ?, ?)
        `).run(id, user.id, hashToken(token), now.toISOString(), expiresAt.toISOString());
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }

      const admin = getPrimaryAdmin();
      if (admin && admin.id !== user.id) {
        try {
          createDirectMessage(
            user.id,
            admin.id,
            `[密码重置申请]\n账号：@${user.username}\n昵称：${user.display_name}\n\n请前往「密码重置」页面核对身份后确认。`,
          );
        } catch (error) {
          console.error('Failed to notify admin about password reset:', error);
        }
      }

      sendJson(res, 201, {
        token,
        username: user.username,
        expiresAt: expiresAt.toISOString(),
      });
      return;
    }

    if (pathname === '/api/auth/password-reset/status' && method === 'GET') {
      const token = String(url.searchParams.get('token') || '').trim();
      if (!token || token.length > 200) throw new HttpError(400, '重置链接无效');
      const row = db
        .prepare(`
          SELECT r.*, u.username, u.display_name
          FROM password_resets r JOIN users u ON u.id = r.user_id
          WHERE r.token_hash = ?
        `)
        .get(hashToken(token));
      if (!row) throw new HttpError(404, '申请不存在或已失效');

      let status = row.status;
      if ((status === 'pending' || status === 'approved') && row.expires_at <= new Date().toISOString()) {
        db.prepare("UPDATE password_resets SET status = 'expired' WHERE id = ?").run(row.id);
        status = 'expired';
      }
      sendJson(res, 200, {
        request: {
          status,
          username: row.username,
          displayName: row.display_name,
          requestedAt: row.requested_at,
          reviewedAt: row.reviewed_at,
          reviewNote: row.note,
          expiresAt: row.expires_at,
        },
      });
      return;
    }

    if (pathname === '/api/auth/password-reset/complete' && method === 'POST') {
      const body = await readJsonBody(req);
      const token = cleanText(body.token, { label: '重置令牌', min: 10, max: 200, singleLine: true });
      if (typeof body.password !== 'string') throw new HttpError(400, '请填写新密码');
      if (body.password.length < 8) throw new HttpError(400, '新密码至少需要 8 个字符');
      if (body.password.length > 128) throw new HttpError(400, '密码不能超过 128 个字符');
      const row = db
        .prepare(`
          SELECT r.*, u.username
          FROM password_resets r JOIN users u ON u.id = r.user_id
          WHERE r.token_hash = ?
        `)
        .get(hashToken(token));
      if (!row) throw new HttpError(404, '申请不存在或已失效');
      if (row.used_at) throw new HttpError(409, '这次重置已经完成，请直接登录');
      if (row.status !== 'approved') throw new HttpError(409, '管理员还没有确认这次申请');
      const now = new Date().toISOString();
      if (row.expires_at <= now) {
        db.prepare("UPDATE password_resets SET status = 'expired' WHERE id = ?").run(row.id);
        throw new HttpError(410, '申请已过期，请重新提交');
      }

      const passwordHash = await hashPassword(body.password);
      db.exec('BEGIN IMMEDIATE');
      try {
        const updated = db
          .prepare("UPDATE password_resets SET status = 'completed', used_at = ? WHERE id = ? AND status = 'approved' AND used_at IS NULL")
          .run(now, row.id);
        if (updated.changes !== 1) {
          db.exec('ROLLBACK');
          throw new HttpError(409, '这次重置已经完成，请直接登录');
        }
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, row.user_id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
        db.exec('COMMIT');
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Already rolled back.
        }
        throw error;
      }

      sendJson(res, 200, { ok: true, username: row.username });
      return;
    }

    if (pathname === '/api/admin/password-resets' && method === 'GET') {
      const auth = requireAuth(req);
      if (!auth.user.isAdmin) throw new HttpError(403, '只有管理员可以查看重置申请');
      const now = new Date().toISOString();
      db.prepare("UPDATE password_resets SET status = 'expired' WHERE status IN ('pending', 'approved') AND expires_at <= ?").run(now);
      const pending = db
        .prepare(`
          SELECT r.id, r.status, r.note, r.requested_at, r.reviewed_at, r.expires_at, r.used_at,
                 u.username, u.display_name, u.created_at AS user_created_at
          FROM password_resets r JOIN users u ON u.id = r.user_id
          WHERE r.status = 'pending'
          ORDER BY r.requested_at ASC
        `)
        .all();
      const recent = db
        .prepare(`
          SELECT r.id, r.status, r.note, r.requested_at, r.reviewed_at, r.expires_at, r.used_at,
                 u.username, u.display_name, u.created_at AS user_created_at
          FROM password_resets r JOIN users u ON u.id = r.user_id
          WHERE r.status IN ('approved', 'rejected', 'completed', 'expired')
          ORDER BY COALESCE(r.reviewed_at, r.used_at, r.requested_at) DESC
          LIMIT 12
        `)
        .all();
      sendJson(res, 200, { pending, recent });
      return;
    }

    const passwordResetReviewMatch =
      api[0] === 'admin' && api[1] === 'password-resets' && api[2] && api[3] === 'review' ? api[2] : null;
    if (passwordResetReviewMatch && method === 'POST') {
      const auth = requireAuth(req);
      if (!auth.user.isAdmin) throw new HttpError(403, '只有管理员可以确认重置申请');
      const body = await readJsonBody(req);
      const decision = body.decision === 'approve' ? 'approved' : body.decision === 'reject' ? 'rejected' : null;
      if (!decision) throw new HttpError(400, '请选择通过或拒绝');
      const note = optionalText(body.note, { label: '说明', max: 200 });
      const row = db.prepare('SELECT * FROM password_resets WHERE id = ?').get(passwordResetReviewMatch);
      if (!row) throw new HttpError(404, '申请不存在');
      if (row.status !== 'pending') throw new HttpError(409, '这条申请已经处理过了');
      const now = new Date().toISOString();
      if (row.expires_at <= now) {
        db.prepare("UPDATE password_resets SET status = 'expired' WHERE id = ?").run(row.id);
        throw new HttpError(410, '申请已过期');
      }
      db.prepare(`
        UPDATE password_resets
        SET status = ?, note = ?, reviewed_at = ?, reviewed_by = ?
        WHERE id = ?
      `).run(decision, decision === 'rejected' ? note || '管理员未通过本次申请' : note, now, auth.user.id, row.id);
      sendJson(res, 200, { ok: true, status: decision });
      return;
    }

    if (pathname === '/api/categories' && method === 'GET') {
      sendJson(res, 200, { categories: getCategories() });
      return;
    }

    if (pathname === '/api/stats' && method === 'GET') {
      sendJson(res, 200, { stats: getStats() });
      return;
    }

    if (pathname === '/api/music/upload' && method === 'POST') {
      const auth = requireAuth(req);
      enforceRate(`music-upload:${auth.user.id}`, 6, 60 * 60 * 1000, res);
      const title = cleanText(url.searchParams.get('title'), { label: '歌曲名', min: 1, max: 80, singleLine: true });
      const artist = cleanText(url.searchParams.get('artist'), { label: '歌手', min: 1, max: 60, singleLine: true });
      const genre = optionalText(url.searchParams.get('genre'), { label: '分类', max: 20, singleLine: true });
      const description = optionalText(url.searchParams.get('description'), { label: '介绍', max: 500 });
      const durationValue = Number(url.searchParams.get('duration'));
      const duration =
        Number.isFinite(durationValue) && durationValue > 0 && durationValue < 3600
          ? Math.round(durationValue * 10) / 10
          : 0;

      const mimeType = String(req.headers['content-type'] || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      const extension = MUSIC_TYPES[mimeType];
      if (!extension) throw new HttpError(415, '暂不支持这种音频格式，请上传 MP3、M4A、WAV、OGG 或 FLAC');

      const declaredLength = Number(req.headers['content-length'] || 0);
      if (declaredLength > MAX_MUSIC_BYTES) throw new HttpError(413, '音频文件不能超过 25MB');
      const audio = await readRawBody(req, MAX_MUSIC_BYTES);
      if (audio.length < 1024) throw new HttpError(400, '音频文件似乎为空');

      const id = newId();
      const fileName = `${id}${extension}`;
      const filePath = path.join(musicDir, fileName);
      const now = new Date().toISOString();
      const approved = Boolean(auth.user.isAdmin);
      await fs.promises.writeFile(filePath, audio, { flag: 'wx' });
      try {
        db.prepare(`
          INSERT INTO music (
            id, user_id, title, artist, genre, description, duration, file_name, mime_type,
            file_size, status, review_note, reviewed_by, created_at, reviewed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)
        `).run(
          id,
          auth.user.id,
          title,
          artist,
          genre,
          description,
          duration,
          fileName,
          mimeType,
          audio.length,
          approved ? 'approved' : 'pending',
          approved ? auth.user.id : null,
          now,
          approved ? now : null,
        );
      } catch (error) {
        fs.promises.unlink(filePath).catch(() => {});
        throw error;
      }

      if (!approved) {
        const admin = getPrimaryAdmin();
        if (admin && admin.id !== auth.user.id) {
          try {
            createDirectMessage(
              auth.user.id,
              admin.id,
              `[音乐审批申请]\n曲目：${title}\n歌手：${artist}\n提交人：${auth.user.displayName} (@${auth.user.username})\n\n请前往「音乐」页面的「待审批」试听并处理。`,
            );
          } catch (error) {
            console.error('Failed to send music review notification:', error);
          }
        }
      }

      const row = db
        .prepare(`
          SELECT m.*, u.username AS submitter_username, u.display_name AS submitter_display_name,
                 u.is_admin AS submitter_is_admin
          FROM music m JOIN users u ON u.id = m.user_id
          WHERE m.id = ?
        `)
        .get(id);
      sendJson(res, 201, {
        music: musicFromRow(row, auth.user),
        pending: !approved,
        counts: getMusicCounts(auth),
      });
      return;
    }

    if (pathname === '/api/music' && method === 'GET') {
      const auth = getAuth(req);
      const requestedScope = url.searchParams.get('scope') || 'approved';
      const scope = requestedScope === 'review' ? 'pending' : requestedScope;
      if (!['approved', 'mine', 'pending'].includes(scope)) {
        throw new HttpError(400, '未知的音乐列表');
      }
      if (scope === 'mine' && !auth) throw new HttpError(401, '请先登录');
      if (scope === 'pending' && !auth?.user.isAdmin) throw new HttpError(403, '只有管理员可以查看待审批音乐');

      const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1);
      const pageSize = Math.min(24, Math.max(1, Number.parseInt(url.searchParams.get('pageSize') || '12', 10) || 12));
      let where = "m.status = 'approved'";
      const params = [];
      if (scope === 'mine') {
        where = 'm.user_id = ?';
        params.push(auth.user.id);
      } else if (scope === 'pending') {
        where = "m.status = 'pending'";
      }

      const total = db.prepare(`SELECT COUNT(*) AS count FROM music m WHERE ${where}`).get(...params).count;
      const order = scope === 'pending' ? 'ASC' : 'DESC';
      const rows = db
        .prepare(`
          SELECT m.*, u.username AS submitter_username, u.display_name AS submitter_display_name,
                 u.is_admin AS submitter_is_admin
          FROM music m JOIN users u ON u.id = m.user_id
          WHERE ${where}
          ORDER BY m.created_at ${order}
          LIMIT ? OFFSET ?
        `)
        .all(...params, pageSize, (page - 1) * pageSize);
      sendJson(res, 200, {
        music: rows.map((row) => musicFromRow(row, auth?.user)),
        pagination: {
          page,
          pageSize,
          total,
          pages: Math.max(1, Math.ceil(total / pageSize)),
        },
        counts: getMusicCounts(auth),
        scope,
      });
      return;
    }

    const musicAudioMatch = api[0] === 'music' && api[1] && api[2] === 'audio' ? api[1] : null;
    if (musicAudioMatch && ['GET', 'HEAD'].includes(method)) {
      const auth = getAuth(req);
      const row = db
        .prepare('SELECT id, user_id, file_name, mime_type, status FROM music WHERE id = ?')
        .get(musicAudioMatch);
      if (!row) throw new HttpError(404, '音乐不存在');
      const canListen =
        row.status === 'approved' ||
        Boolean(auth && (auth.user.isAdmin || auth.user.id === row.user_id));
      if (!canListen) throw new HttpError(404, '音乐不存在');

      const filePath = path.join(musicDir, path.basename(row.file_name));
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        throw new HttpError(404, '音频文件不存在');
      }
      if (!stat.isFile()) throw new HttpError(404, '音频文件不存在');

      const total = stat.size;
      let start = 0;
      let end = total - 1;
      let status = 200;
      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' });
          res.end();
          return;
        }
        if (!match[1]) {
          const suffix = Number(match[2]);
          if (!Number.isFinite(suffix) || suffix <= 0) {
            res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' });
            res.end();
            return;
          }
          start = Math.max(0, total - suffix);
        } else {
          start = Number(match[1]);
          if (match[2]) end = Number(match[2]);
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' });
          res.end();
          return;
        }
        end = Math.min(end, total - 1);
        status = 206;
      }

      const headers = {
        'Content-Type': row.mime_type,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': 'inline',
        'Cache-Control': row.status === 'approved' ? 'public, max-age=86400' : 'private, no-store',
      };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
      res.writeHead(status, headers);
      if (method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(filePath, { start, end });
      stream.on('error', () => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end();
      });
      stream.pipe(res);
      return;
    }

    const musicReviewMatch = api[0] === 'music' && api[1] && api[2] === 'review' ? api[1] : null;
    if (musicReviewMatch && method === 'POST') {
      const auth = requireAuth(req);
      if (!auth.user.isAdmin) throw new HttpError(403, '只有管理员可以审批音乐');
      const body = await readJsonBody(req);
      const decision = body.decision === 'approve' ? 'approved' : body.decision === 'reject' ? 'rejected' : null;
      if (!decision) throw new HttpError(400, '请选择通过或拒绝');
      const note = optionalText(body.note, { label: '审核说明', max: 300 });
      if (decision === 'rejected' && !note) throw new HttpError(400, '请填写拒绝原因，方便通知投稿人');

      const row = db
        .prepare(`
          SELECT m.*, u.username AS submitter_username, u.display_name AS submitter_display_name,
                 u.is_admin AS submitter_is_admin
          FROM music m JOIN users u ON u.id = m.user_id
          WHERE m.id = ?
        `)
        .get(musicReviewMatch);
      if (!row) throw new HttpError(404, '音乐不存在');

      const now = new Date().toISOString();
      db.prepare('UPDATE music SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').run(
        decision,
        note,
        auth.user.id,
        now,
        musicReviewMatch,
      );
      row.status = decision;
      row.review_note = note;
      row.reviewed_at = now;

      if (row.user_id !== auth.user.id) {
        const notification =
          decision === 'approved'
            ? `[音乐审批] 你的音乐《${row.title}》已通过审核，现已在「音乐」页面公开。`
            : `[音乐审批] 你的音乐《${row.title}》未通过审核。\n原因：${note}`;
        try {
          createDirectMessage(auth.user.id, row.user_id, notification);
        } catch (error) {
          console.error('Failed to send music review result:', error);
        }
      }

      sendJson(res, 200, {
        music: musicFromRow(row, auth.user),
        counts: getMusicCounts(auth),
      });
      return;
    }

    const musicDeleteMatch = api[0] === 'music' && api[1] && api[2] === 'delete' ? api[1] : null;
    if (musicDeleteMatch && method === 'POST') {
      const auth = requireAuth(req);
      if (!auth.user.isAdmin) throw new HttpError(403, '只有管理员可以删除音乐');
      await readJsonBody(req);
      const row = db.prepare('SELECT id, title, file_name FROM music WHERE id = ?').get(musicDeleteMatch);
      if (!row) throw new HttpError(404, '音乐不存在');

      db.prepare('DELETE FROM music WHERE id = ?').run(musicDeleteMatch);
      try {
        await fs.promises.unlink(path.join(musicDir, path.basename(row.file_name)));
      } catch (error) {
        if (error.code !== 'ENOENT') console.error('Failed to remove music file:', error);
      }
      console.log(`[admin] ${auth.user.username} deleted music ${musicDeleteMatch}`);
      sendJson(res, 200, { ok: true, deletedMusicId: musicDeleteMatch });
      return;
    }

    if (pathname === '/api/topics' && method === 'GET') {
      const auth = getAuth(req);
      const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1);
      const pageSize = Math.min(24, Math.max(1, Number.parseInt(url.searchParams.get('pageSize') || '10', 10) || 10));
      const sort = ['latest', 'hot', 'unanswered'].includes(url.searchParams.get('sort'))
        ? url.searchParams.get('sort')
        : 'latest';
      const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
      const categorySlug = (url.searchParams.get('category') || '').trim().slice(0, 40);
      const where = [];
      const params = [];

      if (categorySlug) {
        const category = db.prepare('SELECT id FROM categories WHERE slug = ?').get(categorySlug);
        if (!category) throw new HttpError(404, '板块不存在');
        where.push('t.category_id = ?');
        params.push(category.id);
      }
      if (q) {
        where.push("(t.title LIKE ? OR t.content LIKE ? OR u.display_name LIKE ? OR u.username LIKE ?)");
        const like = `%${q}%`;
        params.push(like, like, like, like);
      }
      if (sort === 'unanswered') {
        where.push('(SELECT COUNT(*) FROM replies r WHERE r.topic_id = t.id) = 0');
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db
        .prepare(`
          SELECT COUNT(*) AS count FROM topics t
          JOIN users u ON u.id = t.user_id
          ${whereSql}
        `)
        .get(...params).count;
      const topics = topicRowsFor({
        where,
        params,
        sort,
        limit: pageSize,
        offset: (page - 1) * pageSize,
        viewerId: auth?.user.id,
      });
      sendJson(res, 200, {
        topics,
        pagination: {
          page,
          pageSize,
          total,
          pages: Math.max(1, Math.ceil(total / pageSize)),
        },
      });
      return;
    }

    if (pathname === '/api/topics' && method === 'POST') {
      const auth = requireAuth(req);
      enforceRate(`topic:${auth.user.id}`, 20, 10 * 60 * 1000, res);
      const body = await readJsonBody(req);
      const categoryId = cleanText(body.categoryId, { label: '板块', min: 1, max: 40, singleLine: true });
      const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
      if (!category) throw new HttpError(400, '请选择一个有效的板块');
      const title = cleanText(body.title, { label: '标题', min: 4, max: 80, singleLine: true });
      const content = cleanText(body.content, { label: '正文', min: 4, max: 12000 });
      const now = new Date().toISOString();
      const id = newId();
      db.prepare(`
        INSERT INTO topics (id, category_id, user_id, title, content, created_at, updated_at, last_activity_at, is_pinned, is_locked, views)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
      `).run(id, categoryId, auth.user.id, title, content, now, now, now);
      sendJson(res, 201, { topic: topicDetail(id, auth.user.id) });
      return;
    }

    const topicMatch = api[0] === 'topics' && api[1] ? api[1] : null;
    if (topicMatch && api.length === 2 && method === 'GET') {
      const auth = getAuth(req);
      const topic = topicDetail(topicMatch, auth?.user.id);
      if (!topic) throw new HttpError(404, '话题不存在');
      db.prepare('UPDATE topics SET views = views + 1 WHERE id = ?').run(topic.id);
      topic.views += 1;
      const replies = db
        .prepare(`
          SELECT r.id, r.content, r.created_at,
            u.id AS author_id, u.username AS author_username, u.display_name AS author_display_name,
            (SELECT COUNT(*) FROM likes l WHERE l.target_type = 'reply' AND l.target_id = r.id) AS like_count,
            EXISTS(SELECT 1 FROM likes l WHERE l.target_type = 'reply' AND l.target_id = r.id AND l.user_id = ?) AS liked
          FROM replies r JOIN users u ON u.id = r.user_id
          WHERE r.topic_id = ? ORDER BY r.created_at ASC
        `)
        .all(auth?.user.id || '', topic.id)
        .map(replyFromRow);
      sendJson(res, 200, { topic, replies });
      return;
    }

    if (topicMatch && api.length === 3 && api[2] === 'replies' && method === 'POST') {
      const auth = requireAuth(req);
      enforceRate(`reply:${auth.user.id}`, 30, 10 * 60 * 1000, res);
      const topicRow = db.prepare('SELECT id, is_locked FROM topics WHERE id = ?').get(topicMatch);
      if (!topicRow) throw new HttpError(404, '话题不存在');
      if (topicRow.is_locked) throw new HttpError(403, '这个话题已经锁定，暂时无法回复');
      const body = await readJsonBody(req);
      const content = cleanText(body.content, { label: '回复', min: 1, max: 5000 });
      const now = new Date().toISOString();
      const id = newId();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO replies (id, topic_id, user_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
          id,
          topicMatch,
          auth.user.id,
          content,
          now,
          now,
        );
        db.prepare('UPDATE topics SET last_activity_at = ?, updated_at = ? WHERE id = ?').run(now, now, topicMatch);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      const reply = db
        .prepare(`
          SELECT r.id, r.content, r.created_at,
            u.id AS author_id, u.username AS author_username, u.display_name AS author_display_name,
            0 AS like_count, 0 AS liked
          FROM replies r JOIN users u ON u.id = r.user_id WHERE r.id = ?
        `)
        .get(id);
      sendJson(res, 201, { reply: replyFromRow(reply) });
      return;
    }

    if (topicMatch && api.length === 3 && api[2] === 'like' && method === 'POST') {
      const auth = requireAuth(req);
      const topicRow = db.prepare('SELECT id FROM topics WHERE id = ?').get(topicMatch);
      if (!topicRow) throw new HttpError(404, '话题不存在');
      const existing = db
        .prepare("SELECT 1 AS yes FROM likes WHERE user_id = ? AND target_type = 'topic' AND target_id = ?")
        .get(auth.user.id, topicMatch);
      if (existing) {
        db.prepare("DELETE FROM likes WHERE user_id = ? AND target_type = 'topic' AND target_id = ?").run(
          auth.user.id,
          topicMatch,
        );
      } else {
        db.prepare("INSERT INTO likes (user_id, target_type, target_id, created_at) VALUES (?, 'topic', ?, ?)").run(
          auth.user.id,
          topicMatch,
          new Date().toISOString(),
        );
      }
      const likeCount = db
        .prepare("SELECT COUNT(*) AS count FROM likes WHERE target_type = 'topic' AND target_id = ?")
        .get(topicMatch).count;
      sendJson(res, 200, { liked: !existing, likeCount });
      return;
    }

    if (topicMatch && api.length === 3 && api[2] === 'delete' && method === 'POST') {
      const auth = requireAuth(req);
      if (!auth.user.isAdmin) throw new HttpError(403, '只有管理员可以删除帖子');
      await readJsonBody(req);
      const topicRow = db.prepare('SELECT id, title FROM topics WHERE id = ?').get(topicMatch);
      if (!topicRow) throw new HttpError(404, '话题不存在');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare("DELETE FROM likes WHERE target_type = 'reply' AND target_id IN (SELECT id FROM replies WHERE topic_id = ?)").run(
          topicMatch,
        );
        db.prepare("DELETE FROM likes WHERE target_type = 'topic' AND target_id = ?").run(topicMatch);
        db.prepare('DELETE FROM topics WHERE id = ?').run(topicMatch);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      console.log(`[admin] ${auth.user.username} deleted topic ${topicMatch}`);
      sendJson(res, 200, { ok: true, deletedTopicId: topicMatch });
      return;
    }

    const replyMatch = api[0] === 'replies' && api[1] && api[2] === 'like' ? api[1] : null;
    if (replyMatch && method === 'POST') {
      const auth = requireAuth(req);
      const replyRow = db.prepare('SELECT id FROM replies WHERE id = ?').get(replyMatch);
      if (!replyRow) throw new HttpError(404, '回复不存在');
      const existing = db
        .prepare("SELECT 1 AS yes FROM likes WHERE user_id = ? AND target_type = 'reply' AND target_id = ?")
        .get(auth.user.id, replyMatch);
      if (existing) {
        db.prepare("DELETE FROM likes WHERE user_id = ? AND target_type = 'reply' AND target_id = ?").run(
          auth.user.id,
          replyMatch,
        );
      } else {
        db.prepare("INSERT INTO likes (user_id, target_type, target_id, created_at) VALUES (?, 'reply', ?, ?)").run(
          auth.user.id,
          replyMatch,
          new Date().toISOString(),
        );
      }
      const likeCount = db
        .prepare("SELECT COUNT(*) AS count FROM likes WHERE target_type = 'reply' AND target_id = ?")
        .get(replyMatch).count;
      sendJson(res, 200, { liked: !existing, likeCount });
      return;
    }

    if (pathname === '/api/users' && method === 'GET') {
      const auth = requireAuth(req);
      const q = (url.searchParams.get('q') || '').trim().slice(0, 40);
      const like = `%${q}%`;
      const rows = db
        .prepare(`
          SELECT id, username, display_name, bio, created_at, is_admin
          FROM users
          WHERE id <> ? AND (? = '' OR display_name LIKE ? OR username LIKE ?)
          ORDER BY CASE WHEN ? = '' THEN created_at ELSE 0 END DESC, display_name
          LIMIT 20
        `)
        .all(auth.user.id, q, like, like, q);
      sendJson(res, 200, { users: rows.map(userFromRow) });
      return;
    }

    const userMatch = api[0] === 'users' && api[1] ? api[1] : null;
    if (userMatch && method === 'GET') {
      const auth = getAuth(req);
      const row = statements.publicUser.get(userMatch);
      if (!row) throw new HttpError(404, '用户不存在');
      const profile = userFromRow(row);
      const stats = db
        .prepare(`
          SELECT
            (SELECT COUNT(*) FROM topics WHERE user_id = ?) AS topics,
            (SELECT COUNT(*) FROM replies WHERE user_id = ?) AS replies,
            (SELECT COUNT(*) FROM likes l
              LEFT JOIN topics t ON l.target_type = 'topic' AND t.id = l.target_id
              LEFT JOIN replies r ON l.target_type = 'reply' AND r.id = l.target_id
              WHERE COALESCE(t.user_id, r.user_id) = ?) AS likes_received
        `)
        .get(userMatch, userMatch, userMatch);
      const topics = db
        .prepare(`
          ${TOPIC_SELECT}
          WHERE t.user_id = ? ORDER BY t.created_at DESC LIMIT 6
        `)
        .all(auth?.user.id || '', userMatch)
        .map((topicRow) => topicFromRow(topicRow));
      sendJson(res, 200, {
        user: profile,
        isMe: auth?.user.id === userMatch,
        stats: {
          topics: stats.topics,
          replies: stats.replies,
          likesReceived: stats.likes_received,
        },
        topics,
      });
      return;
    }

    if (pathname === '/api/conversations' && method === 'GET') {
      const auth = requireAuth(req);
      const userId = auth.user.id;
      const rows = db
        .prepare(`
          SELECT c.id, c.updated_at,
            CASE WHEN c.user_a_id = ? THEN c.user_b_id ELSE c.user_a_id END AS other_id,
            u.username, u.display_name, u.bio,
            (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_content,
            (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_at,
            (SELECT sender_id FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_sender_id,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id <> ? AND m.read_at IS NULL) AS unread
          FROM conversations c
          JOIN users u ON u.id = CASE WHEN c.user_a_id = ? THEN c.user_b_id ELSE c.user_a_id END
          WHERE c.user_a_id = ? OR c.user_b_id = ?
          ORDER BY COALESCE(last_at, c.updated_at) DESC
        `)
        .all(userId, userId, userId, userId, userId);
      const conversations = rows.map((row) => {
        const [avatarFrom, avatarTo] = avatarColor(row.username);
        return {
          id: row.id,
          other: {
            id: row.other_id,
            username: row.username,
            displayName: row.display_name,
            bio: row.bio,
            avatarFrom,
            avatarTo,
          },
          lastMessage: row.last_at
            ? {
                content: makeExcerpt(row.last_content, 80),
                createdAt: row.last_at,
                mine: row.last_sender_id === userId,
              }
            : null,
          unread: row.unread,
          updatedAt: row.updated_at,
        };
      });
      sendJson(res, 200, { conversations });
      return;
    }

    if (pathname === '/api/conversations' && method === 'POST') {
      const auth = requireAuth(req);
      const body = await readJsonBody(req);
      const targetId = cleanText(body.userId, { label: '用户', min: 1, max: 60, singleLine: true });
      if (targetId === auth.user.id) throw new HttpError(400, '不能给自己发私信');
      const target = statements.publicUser.get(targetId);
      if (!target) throw new HttpError(404, '用户不存在');
      const [userA, userB] = [auth.user.id, targetId].sort();
      let row = db
        .prepare('SELECT * FROM conversations WHERE user_a_id = ? AND user_b_id = ?')
        .get(userA, userB);
      let created = false;
      if (!row) {
        const now = new Date().toISOString();
        try {
          db.prepare('INSERT INTO conversations (id, user_a_id, user_b_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
            newId(),
            userA,
            userB,
            now,
            now,
          );
          created = true;
        } catch (error) {
          if (!String(error.message).includes('UNIQUE')) throw error;
        }
        row = db.prepare('SELECT * FROM conversations WHERE user_a_id = ? AND user_b_id = ?').get(userA, userB);
      }
      const other = otherUserFor(row, auth.user.id);
      sendJson(res, created ? 201 : 200, {
        conversation: {
          id: row.id,
          other: userFromRow(other),
          unread: 0,
          lastMessage: null,
          updatedAt: row.updated_at,
        },
      });
      return;
    }

    const conversationMatch = api[0] === 'conversations' && api[1] ? api[1] : null;
    if (conversationMatch && api.length === 2 && method === 'GET') {
      const auth = requireAuth(req);
      const conversation = conversationForUser(conversationMatch, auth.user.id);
      if (!conversation) throw new HttpError(404, '会话不存在');
      const other = otherUserFor(conversation, auth.user.id);
      sendJson(res, 200, {
        conversation: {
          id: conversation.id,
          other: userFromRow(other),
          unread: conversation.unread,
          updatedAt: conversation.updated_at,
        },
      });
      return;
    }

    if (conversationMatch && api.length === 3 && api[2] === 'messages' && method === 'GET') {
      const auth = requireAuth(req);
      const conversation = conversationForUser(conversationMatch, auth.user.id);
      if (!conversation) throw new HttpError(404, '会话不存在');
      const other = otherUserFor(conversation, auth.user.id);
      const rows = db
        .prepare(`
          SELECT m.id, m.content, m.created_at, m.sender_id,
            u.username, u.display_name
          FROM messages m JOIN users u ON u.id = m.sender_id
          WHERE m.conversation_id = ? ORDER BY m.created_at DESC LIMIT 100
        `)
        .all(conversation.id)
        .reverse();
      const messages = rows.map((row) => ({
        id: row.id,
        content: row.content,
        createdAt: row.created_at,
        senderId: row.sender_id,
        mine: row.sender_id === auth.user.id,
        senderDisplayName: row.display_name,
      }));
      sendJson(res, 200, {
        conversation: {
          id: conversation.id,
          other: userFromRow(other),
          unread: conversation.unread,
          updatedAt: conversation.updated_at,
        },
        messages,
      });
      return;
    }

    if (conversationMatch && api.length === 3 && api[2] === 'messages' && method === 'POST') {
      const auth = requireAuth(req);
      enforceRate(`message:${auth.user.id}`, 60, 10 * 60 * 1000, res);
      const conversation = conversationForUser(conversationMatch, auth.user.id);
      if (!conversation) throw new HttpError(404, '会话不存在');
      const body = await readJsonBody(req);
      const content = cleanText(body.content, { label: '消息', min: 1, max: 2000 });
      const now = new Date().toISOString();
      const id = newId();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO messages (id, conversation_id, sender_id, content, created_at, read_at) VALUES (?, ?, ?, ?, ?, NULL)').run(
          id,
          conversation.id,
          auth.user.id,
          content,
          now,
        );
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversation.id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      const message = {
        id,
        content,
        createdAt: now,
        senderId: auth.user.id,
        mine: true,
        senderDisplayName: auth.user.display_name,
      };
      const recipientId = conversation.user_a_id === auth.user.id ? conversation.user_b_id : conversation.user_a_id;
      const participants = [auth.user.id, recipientId];
      for (const userId of participants) {
        broadcastToUser(userId, 'message:new', {
          type: 'message:new',
          conversationId: conversation.id,
          message,
          unreadMessages: getUnreadMessages(userId),
        });
      }
      sendJson(res, 201, { message });
      return;
    }

    if (conversationMatch && api.length === 3 && api[2] === 'read' && method === 'POST') {
      const auth = requireAuth(req);
      const conversation = conversationForUser(conversationMatch, auth.user.id);
      if (!conversation) throw new HttpError(404, '会话不存在');
      const now = new Date().toISOString();
      const result = db
        .prepare('UPDATE messages SET read_at = ? WHERE conversation_id = ? AND sender_id <> ? AND read_at IS NULL')
        .run(now, conversation.id, auth.user.id);
      sendJson(res, 200, {
        marked: result.changes,
        unreadMessages: getUnreadMessages(auth.user.id),
      });
      return;
    }

    if (pathname === '/api/events' && method === 'GET') {
      const auth = requireAuth(req);
      addSseClient(req, res, auth.user.id);
      return;
    }

    throw new HttpError(404, '接口不存在');
  }

  function serveFile(req, res, filePath, stat) {
    const ext = path.extname(filePath).toLowerCase();
    const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    const headers = {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      ETag: etag,
      'Last-Modified': stat.mtime.toUTCString(),
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('读取文件失败');
    });
    stream.pipe(res);
  }

  function serveStatic(req, res, pathname) {
    if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, '请求方法不支持');
    let relative;
    try {
      relative = decodeURIComponent(pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
    } catch {
      throw new HttpError(400, '路径格式不正确');
    }
    if (!relative) relative = 'index.html';
    const resolved = path.resolve(publicDir, relative);
    if (resolved !== publicDir && !resolved.startsWith(`${publicDir}${path.sep}`)) {
      throw new HttpError(403, '禁止访问');
    }
    let filePath = resolved;
    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) {
      if (!path.extname(relative)) {
        filePath = path.join(publicDir, 'index.html');
        try {
          stat = fs.statSync(filePath);
        } catch {
          stat = null;
        }
      }
    }
    if (!stat || !stat.isFile()) throw new HttpError(404, '页面不存在');
    serveFile(req, res, filePath, stat);
  }

  const server = http.createServer((req, res) => {
    setSecurityHeaders(res);
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      sendJson(res, 400, { error: '请求地址无效' });
      return;
    }
    const pathname = url.pathname;

    const run = async () => {
      if (pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) {
          if (pathname === '/api/music/upload') assertSameOrigin(req);
          else assertJsonMutation(req);
        }
        await handleApi(req, res, pathname, url);
        return;
      }
      serveStatic(req, res, pathname);
    };

    run().catch((error) => {
      if (error instanceof HttpError) {
        if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
        sendJson(res, error.status, { error: error.message });
        return;
      }
      console.error(`[${new Date().toISOString()}]`, req.method, pathname, error);
      if (!res.headersSent) sendJson(res, 500, { error: '服务器开小差了，请稍后再试' });
      else res.end();
    });
  });

  server.on('clientError', (error, socket) => {
    if (!socket.writable) return;
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  async function close() {
    for (const clients of sseClients.values()) {
      for (const client of clients) {
        if (client.heartbeat) clearInterval(client.heartbeat);
        try {
          client.res.end();
        } catch {
          // Already closed.
        }
      }
    }
    sseClients.clear();
    await new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    try {
      db.close();
    } catch {
      // Already closed.
    }
  }

  return { server, db, close, publicDir };
}

module.exports = { createForumServer };

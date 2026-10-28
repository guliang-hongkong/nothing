'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createForumServer } = require('../src/app');

function cookiePair(response) {
  const cookies = response.headers.getSetCookie?.() || [];
  if (!cookies.length) return '';
  return cookies.map((value) => value.split(';')[0]).join('; ');
}

async function request(base, route, { method = 'GET', body, cookie } = {}) {
  const headers = { Accept: 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const options = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${base}${route}`, options);
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { response, data };
}

test('forum API supports the full member journey', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'islands-forum-test-'));
  const dbPath = path.join(tempDir, 'test.db');
  const forum = createForumServer({ dbPath, seed: true });
  await new Promise((resolve) => forum.server.listen(0, '127.0.0.1', resolve));
  const { port } = forum.server.address();
  const base = `http://127.0.0.1:${port}`;
  const users = {};
  let topicId;
  let replyId;
  let conversationId;

  t.after(async () => {
    await forum.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows may briefly hold WAL files; the temp directory can be cleaned later.
    }
  });

  await t.test('serves the app shell and public discovery APIs', async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const pageText = await page.text();
    assert.match(pageText, /Island's forum/);
    assert.match(pageText, /离岛的论坛/);
    assert.doesNotMatch(pageText, /拾光/);
    assert.match(page.headers.get('content-security-policy') || '', /default-src 'self'/);

    const health = await request(base, '/api/health');
    assert.equal(health.response.status, 200);
    assert.equal(health.data.ok, true);
    assert.equal(health.data.name, "Island's forum");

    const categories = await request(base, '/api/categories');
    assert.equal(categories.response.status, 200);
    assert.equal(categories.data.categories.length, 5);

    const topics = await request(base, '/api/topics?sort=latest');
    assert.equal(topics.response.status, 200);
    assert.ok(topics.data.topics.length >= 8);
    assert.equal(topics.data.pagination.total, 8);

    const stats = await request(base, '/api/stats');
    assert.equal(stats.response.status, 200);
    assert.equal(stats.data.stats.users, 6);

    const manifest = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type') || '', /manifest\+json/);
  });

  await t.test('registers two members and enforces validation', async () => {
    const first = await request(base, '/api/auth/register', {
      method: 'POST',
      body: { username: 'test_alpha', displayName: '测试甲', password: 'testpass123' },
    });
    assert.equal(first.response.status, 201);
    assert.equal(first.data.user.displayName, '测试甲');
    assert.equal(first.data.user.username, 'test_alpha');
    users.alpha = { cookie: cookiePair(first.response), user: first.data.user };
    assert.ok(users.alpha.cookie.includes('islands_session='));

    const duplicate = await request(base, '/api/auth/register', {
      method: 'POST',
      body: { username: 'test_alpha', displayName: '重复', password: 'testpass123' },
    });
    assert.equal(duplicate.response.status, 409);

    const weak = await request(base, '/api/auth/register', {
      method: 'POST',
      body: { username: 'test_weak', password: 'short' },
    });
    assert.equal(weak.response.status, 400);

    const second = await request(base, '/api/auth/register', {
      method: 'POST',
      body: { username: 'test_beta', displayName: '测试乙', password: 'testpass123' },
    });
    assert.equal(second.response.status, 201);
    users.beta = { cookie: cookiePair(second.response), user: second.data.user };

    const me = await request(base, '/api/auth/me', { cookie: users.alpha.cookie });
    assert.equal(me.response.status, 200);
    assert.equal(me.data.user.username, 'test_alpha');
    assert.equal(me.data.summary.unreadMessages, 0);

    const login = await request(base, '/api/auth/login', {
      method: 'POST',
      body: { username: 'test_alpha', password: 'testpass123' },
    });
    assert.equal(login.response.status, 200);
    users.alpha.cookie = cookiePair(login.response);
  });

  await t.test('creates topics, replies, and likes', async () => {
    const unauthorized = await request(base, '/api/topics', {
      method: 'POST',
      body: { categoryId: 'cat-general', title: '未登录发帖', content: '这不应该成功。' },
    });
    assert.equal(unauthorized.response.status, 401);

    const created = await request(base, '/api/topics', {
      method: 'POST',
      cookie: users.alpha.cookie,
      body: {
        categoryId: 'cat-general',
        title: '测试发帖：一个完整的话题',
        content: '这是集成测试创建的正文。\n\n第二段用来检查段落渲染所需的数据。',
      },
    });
    assert.equal(created.response.status, 201);
    assert.ok(created.data.topic.id);
    topicId = created.data.topic.id;

    const detail = await request(base, `/api/topics/${topicId}`, { cookie: users.beta.cookie });
    assert.equal(detail.response.status, 200);
    assert.equal(detail.data.topic.title, '测试发帖：一个完整的话题');
    assert.match(detail.data.topic.content, /第二段/);
    assert.equal(detail.data.replies.length, 0);

    const reply = await request(base, `/api/topics/${topicId}/replies`, {
      method: 'POST',
      cookie: users.beta.cookie,
      body: { content: '这是一条来自测试乙的回应。' },
    });
    assert.equal(reply.response.status, 201);
    assert.equal(reply.data.reply.author.username, 'test_beta');
    replyId = reply.data.reply.id;

    const liked = await request(base, `/api/topics/${topicId}/like`, {
      method: 'POST',
      cookie: users.beta.cookie,
      body: {},
    });
    assert.equal(liked.response.status, 200);
    assert.equal(liked.data.liked, true);
    assert.equal(liked.data.likeCount, 1);

    const replyLiked = await request(base, `/api/replies/${replyId}/like`, {
      method: 'POST',
      cookie: users.alpha.cookie,
      body: {},
    });
    assert.equal(replyLiked.response.status, 200);
    assert.equal(replyLiked.data.liked, true);

    const detailAfter = await request(base, `/api/topics/${topicId}`, { cookie: users.alpha.cookie });
    assert.equal(detailAfter.data.topic.replyCount, 1);
    assert.equal(detailAfter.data.topic.liked, false);
    assert.equal(detailAfter.data.replies[0].liked, true);

    const search = await request(base, '/api/topics?q=' + encodeURIComponent('完整的话题'));
    assert.equal(search.response.status, 200);
    assert.ok(search.data.topics.some((topic) => topic.id === topicId));
  });

  await t.test('supports private conversations, unread state, and real-time events', async () => {
    const created = await request(base, '/api/conversations', {
      method: 'POST',
      cookie: users.alpha.cookie,
      body: { userId: users.beta.user.id },
    });
    assert.equal(created.response.status, 201);
    conversationId = created.data.conversation.id;
    assert.equal(created.data.conversation.other.username, 'test_beta');

    const controller = new AbortController();
    const sse = await fetch(`${base}/api/events`, {
      headers: { Cookie: users.beta.cookie },
      signal: controller.signal,
    });
    assert.equal(sse.status, 200);
    const reader = sse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    async function readUntil(predicate, timeoutMs = 5000) {
      const started = Date.now();
      while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for SSE event');
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE stream ended early');
        buffer += decoder.decode(value, { stream: true });
      }
    }

    await readUntil(() => buffer.includes('event: ready'));

    const message = await request(base, `/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      cookie: users.alpha.cookie,
      body: { content: '你好，这是一条实时私信。' },
    });
    assert.equal(message.response.status, 201);
    assert.equal(message.data.message.content, '你好，这是一条实时私信。');

    await readUntil(() => buffer.includes('event: message:new') && buffer.includes('实时私信'));

    const betaMe = await request(base, '/api/auth/me', { cookie: users.beta.cookie });
    assert.equal(betaMe.data.summary.unreadMessages, 1);

    const inbox = await request(base, '/api/conversations', { cookie: users.beta.cookie });
    assert.equal(inbox.data.conversations.length, 1);
    assert.equal(inbox.data.conversations[0].unread, 1);
    assert.equal(inbox.data.conversations[0].other.username, 'test_alpha');

    const messages = await request(base, `/api/conversations/${conversationId}/messages`, {
      cookie: users.beta.cookie,
    });
    assert.equal(messages.response.status, 200);
    assert.equal(messages.data.messages.length, 1);
    assert.equal(messages.data.messages[0].mine, false);

    const read = await request(base, `/api/conversations/${conversationId}/read`, {
      method: 'POST',
      cookie: users.beta.cookie,
      body: {},
    });
    assert.equal(read.response.status, 200);
    assert.equal(read.data.unreadMessages, 0);

    const betaMeAfter = await request(base, '/api/auth/me', { cookie: users.beta.cookie });
    assert.equal(betaMeAfter.data.summary.unreadMessages, 0);

    controller.abort();
  });

  await t.test('returns profiles and rejects malformed or unauthorized requests', async () => {
    const profile = await request(base, `/api/users/${users.alpha.user.id}`, { cookie: users.beta.cookie });
    assert.equal(profile.response.status, 200);
    assert.equal(profile.data.user.username, 'test_alpha');
    assert.equal(profile.data.isMe, false);
    assert.ok(profile.data.stats.topics >= 1);
    assert.ok(profile.data.topics.some((topic) => topic.id === topicId));

    const invalidJson = await fetch(`${base}/api/topics`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    assert.equal(invalidJson.status, 415);

    const unknown = await request(base, '/api/topics/not-a-real-topic');
    assert.equal(unknown.response.status, 404);

    const unknownUser = await request(base, '/api/users/not-a-real-user');
    assert.equal(unknownUser.response.status, 404);
  });

  await t.test('allows only the built-in administrator to delete topics', async () => {
    const adminLogin = await request(base, '/api/auth/login', {
      method: 'POST',
      body: { username: 'island', password: 'qwE12qwE1' },
    });
    assert.equal(adminLogin.response.status, 200);
    assert.equal(adminLogin.data.user.displayName, '离岛');
    assert.equal(adminLogin.data.user.isAdmin, true);
    users.admin = { cookie: cookiePair(adminLogin.response), user: adminLogin.data.user };

    const forbidden = await request(base, `/api/topics/${topicId}/delete`, {
      method: 'POST',
      cookie: users.alpha.cookie,
      body: {},
    });
    assert.equal(forbidden.response.status, 403);

    const unknown = await request(base, '/api/topics/not-a-real-topic/delete', {
      method: 'POST',
      cookie: users.admin.cookie,
      body: {},
    });
    assert.equal(unknown.response.status, 404);

    const deleted = await request(base, `/api/topics/${topicId}/delete`, {
      method: 'POST',
      cookie: users.admin.cookie,
      body: {},
    });
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.data.ok, true);

    const missing = await request(base, `/api/topics/${topicId}`);
    assert.equal(missing.response.status, 404);
    assert.equal(forum.db.prepare('SELECT COUNT(*) AS count FROM replies WHERE topic_id = ?').get(topicId).count, 0);
    assert.equal(forum.db.prepare("SELECT COUNT(*) AS count FROM likes WHERE target_type = 'topic' AND target_id = ?").get(topicId).count, 0);
    assert.equal(forum.db.prepare("SELECT COUNT(*) AS count FROM likes WHERE target_type = 'reply' AND target_id = ?").get(replyId).count, 0);
  });

  await t.test('logs out and invalidates the session', async () => {
    const logout = await request(base, '/api/auth/logout', {
      method: 'POST',
      cookie: users.alpha.cookie,
      body: {},
    });
    assert.equal(logout.response.status, 200);
    const me = await request(base, '/api/auth/me', { cookie: users.alpha.cookie });
    assert.equal(me.data.user, null);
  });
});

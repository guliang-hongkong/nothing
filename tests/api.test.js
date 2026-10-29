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

async function uploadMusic(base, cookie, metadata, audio, contentType = 'audio/mpeg') {
  const params = new URLSearchParams(metadata);
  const response = await fetch(`${base}/api/music/upload?${params.toString()}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Cookie: cookie,
      'Content-Type': contentType,
    },
    body: audio,
  });
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

  await t.test('music submissions require approval and notify the administrator by private message', async () => {
    const audio = Buffer.concat([
      Buffer.from('ID3'),
      Buffer.alloc(4096, 7),
    ]);
    const first = await uploadMusic(base, users.beta.cookie, {
      title: '测试海浪',
      artist: '测试歌手',
      genre: '氛围',
      description: '一条用于测试的音频。',
      duration: '12.5',
    }, audio);
    assert.equal(first.response.status, 201);
    assert.equal(first.data.music.status, 'pending');
    assert.equal(first.data.pending, true);
    assert.equal(first.data.music.title, '测试海浪');
    const pendingId = first.data.music.id;

    const publicList = await request(base, '/api/music');
    assert.equal(publicList.response.status, 200);
    assert.equal(publicList.data.scope, 'approved');
    assert.equal(publicList.data.music.some((item) => item.id === pendingId), false);

    const forbiddenPending = await request(base, '/api/music?scope=pending', { cookie: users.beta.cookie });
    assert.equal(forbiddenPending.response.status, 403);

    const pendingPreview = await fetch(`${base}/api/music/${pendingId}/audio`, {
      headers: { Cookie: users.beta.cookie, Range: 'bytes=0-9' },
    });
    assert.equal(pendingPreview.status, 206);
    assert.equal((await pendingPreview.arrayBuffer()).byteLength, 10);

    const publicPreview = await fetch(`${base}/api/music/${pendingId}/audio`);
    assert.equal(publicPreview.status, 404);

    const adminMe = await request(base, '/api/auth/me', { cookie: users.admin.cookie });
    assert.ok(adminMe.data.summary.unreadMessages >= 1);

    const adminInbox = await request(base, '/api/conversations', { cookie: users.admin.cookie });
    assert.ok(adminInbox.data.conversations.some((conversation) => conversation.other.id === users.beta.user.id));

    const reviewQueue = await request(base, '/api/music?scope=pending', { cookie: users.admin.cookie });
    assert.equal(reviewQueue.response.status, 200);
    assert.ok(reviewQueue.data.music.some((item) => item.id === pendingId));

    const approved = await request(base, `/api/music/${pendingId}/review`, {
      method: 'POST',
      cookie: users.admin.cookie,
      body: { decision: 'approve' },
    });
    assert.equal(approved.response.status, 200);
    assert.equal(approved.data.music.status, 'approved');

    const publicAfter = await request(base, '/api/music');
    const approvedItem = publicAfter.data.music.find((item) => item.id === pendingId);
    assert.ok(approvedItem);
    assert.equal(approvedItem.canListen, true);

    const publicStream = await fetch(`${base}/api/music/${pendingId}/audio`, {
      headers: { Range: 'bytes=0-9' },
    });
    assert.equal(publicStream.status, 206);
    assert.match(publicStream.headers.get('content-range') || '', /^bytes 0-9\//);

    const betaMe = await request(base, '/api/auth/me', { cookie: users.beta.cookie });
    assert.ok(betaMe.data.summary.unreadMessages >= 1);

    const second = await uploadMusic(base, users.beta.cookie, {
      title: '不通过的测试曲',
      artist: '测试歌手',
      genre: '其他',
    }, audio);
    assert.equal(second.response.status, 201);
    const rejected = await request(base, `/api/music/${second.data.music.id}/review`, {
      method: 'POST',
      cookie: users.admin.cookie,
      body: { decision: 'reject', note: '音频质量不符合上架标准' },
    });
    assert.equal(rejected.response.status, 200);
    assert.equal(rejected.data.music.status, 'rejected');

    const mine = await request(base, '/api/music?scope=mine', { cookie: users.beta.cookie });
    const rejectedItem = mine.data.music.find((item) => item.id === second.data.music.id);
    assert.ok(rejectedItem);
    assert.equal(rejectedItem.reviewNote, '音频质量不符合上架标准');

    const adminUpload = await uploadMusic(base, users.admin.cookie, {
      title: '管理员直接上架',
      artist: '离岛',
      genre: '氛围',
    }, audio);
    assert.equal(adminUpload.response.status, 201);
    assert.equal(adminUpload.data.music.status, 'approved');
    assert.equal(adminUpload.data.pending, false);

    const forbiddenDelete = await request(base, `/api/music/${pendingId}/delete`, {
      method: 'POST',
      cookie: users.beta.cookie,
      body: {},
    });
    assert.equal(forbiddenDelete.response.status, 403);

    const unknownDelete = await request(base, '/api/music/not-a-real-track/delete', {
      method: 'POST',
      cookie: users.admin.cookie,
      body: {},
    });
    assert.equal(unknownDelete.response.status, 404);

    const uploadedFile = forum.db
      .prepare('SELECT file_name FROM music WHERE id = ?')
      .get(adminUpload.data.music.id);
    const uploadedPath = path.join(tempDir, 'music', uploadedFile.file_name);
    assert.equal(fs.existsSync(uploadedPath), true);

    const deletedMusic = await request(base, `/api/music/${adminUpload.data.music.id}/delete`, {
      method: 'POST',
      cookie: users.admin.cookie,
      body: {},
    });
    assert.equal(deletedMusic.response.status, 200);
    assert.equal(deletedMusic.data.ok, true);
    assert.equal(fs.existsSync(uploadedPath), false);

    const publicAfterDelete = await request(base, '/api/music');
    assert.equal(publicAfterDelete.data.music.some((item) => item.id === adminUpload.data.music.id), false);
    const deletedAudio = await fetch(`${base}/api/music/${adminUpload.data.music.id}/audio`);
    assert.equal(deletedAudio.status, 404);
  });

  await t.test('requires admin confirmation before a password can be reset', async () => {
    const missingUser = await request(base, '/api/auth/password-reset/request', {
      method: 'POST',
      body: { username: 'nobody_here_404' },
    });
    assert.equal(missingUser.response.status, 404);

    const adminRequest = await request(base, '/api/auth/password-reset/request', {
      method: 'POST',
      body: { username: 'island' },
    });
    assert.equal(adminRequest.response.status, 400);

    const requested = await request(base, '/api/auth/password-reset/request', {
      method: 'POST',
      body: { username: 'test_beta' },
    });
    assert.equal(requested.response.status, 201);
    assert.ok(requested.data.token);
    const resetToken = requested.data.token;

    const pending = await request(base, `/api/auth/password-reset/status?token=${encodeURIComponent(resetToken)}`);
    assert.equal(pending.response.status, 200);
    assert.equal(pending.data.request.status, 'pending');

    const forbiddenList = await request(base, '/api/admin/password-resets', { cookie: users.beta.cookie });
    assert.equal(forbiddenList.response.status, 403);

    const adminList = await request(base, '/api/admin/password-resets', { cookie: users.admin.cookie });
    assert.equal(adminList.response.status, 200);
    const resetRequest = adminList.data.pending.find((item) => item.username === 'test_beta');
    assert.ok(resetRequest);

    const forbiddenReview = await request(base, `/api/admin/password-resets/${resetRequest.id}/review`, {
      method: 'POST',
      cookie: users.beta.cookie,
      body: { decision: 'approve' },
    });
    assert.equal(forbiddenReview.response.status, 403);

    const approved = await request(base, `/api/admin/password-resets/${resetRequest.id}/review`, {
      method: 'POST',
      cookie: users.admin.cookie,
      body: { decision: 'approve' },
    });
    assert.equal(approved.response.status, 200);
    assert.equal(approved.data.status, 'approved');

    const approvedStatus = await request(base, `/api/auth/password-reset/status?token=${encodeURIComponent(resetToken)}`);
    assert.equal(approvedStatus.data.request.status, 'approved');

    const completed = await request(base, '/api/auth/password-reset/complete', {
      method: 'POST',
      body: { token: resetToken, password: 'newpass456' },
    });
    assert.equal(completed.response.status, 200);
    assert.equal(completed.data.username, 'test_beta');

    const completedStatus = await request(base, `/api/auth/password-reset/status?token=${encodeURIComponent(resetToken)}`);
    assert.equal(completedStatus.data.request.status, 'completed');

    const reused = await request(base, '/api/auth/password-reset/complete', {
      method: 'POST',
      body: { token: resetToken, password: 'anotherpass789' },
    });
    assert.equal(reused.response.status, 409);

    const oldSession = await request(base, '/api/auth/me', { cookie: users.beta.cookie });
    assert.equal(oldSession.data.user, null);

    const oldPassword = await request(base, '/api/auth/login', {
      method: 'POST',
      body: { username: 'test_beta', password: 'testpass123' },
    });
    assert.equal(oldPassword.response.status, 401);

    const newPassword = await request(base, '/api/auth/login', {
      method: 'POST',
      body: { username: 'test_beta', password: 'newpass456' },
    });
    assert.equal(newPassword.response.status, 200);
    users.beta.cookie = cookiePair(newPassword.response);
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

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPasswordSync, newId } = require('./security');

const CATEGORIES = [
  { id: 'cat-news', slug: 'news', name: '站务与公告', description: '社区动态、使用指南与新功能', icon: 'bell', sort: 1 },
  { id: 'cat-general', slug: 'general', name: '综合讨论', description: '天南海北，想到什么聊什么', icon: 'chat', sort: 2 },
  { id: 'cat-tech', slug: 'tech', name: '技术分享', description: '代码、产品与数字生活', icon: 'code', sort: 3 },
  { id: 'cat-life', slug: 'life', name: '生活碎片', description: '书影音、旅行与日常灵感', icon: 'leaf', sort: 4 },
  { id: 'cat-help', slug: 'help', name: '互助问答', description: '有问题，这里有人回应', icon: 'help', sort: 5 },
];

function migrate(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      bio TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      icon TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL REFERENCES categories(id),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_locked INTEGER NOT NULL DEFAULT 0,
      views INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_topics_category ON topics(category_id, last_activity_at DESC);
    CREATE INDEX IF NOT EXISTS idx_topics_activity ON topics(last_activity_at DESC);
    CREATE INDEX IF NOT EXISTS idx_topics_user ON topics(user_id);

    CREATE TABLE IF NOT EXISTS replies (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_replies_topic ON replies(topic_id, created_at);

    CREATE TABLE IF NOT EXISTS likes (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL CHECK (target_type IN ('topic', 'reply')),
      target_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, target_type, target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_likes_target ON likes(target_type, target_id);

    CREATE TABLE IF NOT EXISTS music (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      genre TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      duration REAL NOT NULL DEFAULT 0,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      review_note TEXT NOT NULL DEFAULT '',
      reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      reviewed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_music_status ON music(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_music_user ON music(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_a_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_b_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_a_id, user_b_id),
      CHECK (user_a_id < user_b_id)
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_a ON conversations(user_a_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conversations_b ON conversations(user_b_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(conversation_id, read_at);
  `);

  // Existing installations created before roles were introduced.
  const userColumns = db.prepare('PRAGMA table_info(users)').all();
  if (!userColumns.some((column) => column.name === 'is_admin')) {
    db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  }

  const insertCategory = db.prepare(`
    INSERT INTO categories (id, slug, name, description, icon, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      slug = excluded.slug,
      name = excluded.name,
      description = excluded.description,
      icon = excluded.icon,
      sort_order = excluded.sort_order
  `);
  for (const category of CATEGORIES) {
    insertCategory.run(category.id, category.slug, category.name, category.description, category.icon, category.sort);
  }
}

function seedDatabase(db) {
  const now = Date.now();
  const ago = (hours) => new Date(now - hours * 60 * 60 * 1000).toISOString();
  const demoHash = hashPasswordSync('demo1234');

  const addUser = db.prepare(`
    INSERT INTO users (id, username, username_key, display_name, password_hash, bio, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const addTopic = db.prepare(`
    INSERT INTO topics (id, category_id, user_id, title, content, created_at, updated_at, last_activity_at, is_pinned, is_locked, views)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `);
  const addReply = db.prepare(`
    INSERT INTO replies (id, topic_id, user_id, content, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const addLike = db.prepare(`
    INSERT OR IGNORE INTO likes (user_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)
  `);
  const addConversation = db.prepare(`
    INSERT INTO conversations (id, user_a_id, user_b_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
  `);
  const addMessage = db.prepare(`
    INSERT INTO messages (id, conversation_id, sender_id, content, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const people = {
    linwan: {
      id: newId(),
      username: 'linwan',
      display: '林晚',
      bio: '在城市的缝隙里收集晚风。前端工程师，偶尔写点没用的东西。',
      joined: ago(24 * 210),
    },
    ache: {
      id: newId(),
      username: 'ache',
      display: '阿澈',
      bio: '摄影师，喜欢海、旧相机和一切慢吞吞的事。',
      joined: ago(24 * 160),
    },
    xiaoman: {
      id: newId(),
      username: 'xiaoman',
      display: '小满',
      bio: '厨房实验员。人生理想是做出完美的肉桂卷。',
      joined: ago(24 * 120),
    },
    chenmo: {
      id: newId(),
      username: 'chenmo',
      display: '陈默',
      bio: '后端开发，长期与数据库和咖啡因打交道。',
      joined: ago(24 * 90),
    },
    shanzhi: {
      id: newId(),
      username: 'shanzhi',
      display: '山栀',
      bio: '播客重度听众，正在练习把日子过得具体一点。',
      joined: ago(24 * 45),
    },
  };

  for (const person of Object.values(people)) {
    addUser.run(person.id, person.username, person.username, person.display, demoHash, person.bio, person.joined);
  }

  const topics = [
    {
      id: newId(),
      category: 'cat-news',
      author: 'linwan',
      title: '欢迎来到离岛：这里有一份新手指南',
      content:
        '欢迎来到离岛。这里是一个不太着急的地方，我们想把它做成一张可以随时坐下来的长桌。\n\n你可以做这些事：\n· 在「综合讨论」分享最近的想法，在「技术分享」记录踩坑与灵感；\n· 看到喜欢的帖子，点一下右下角的赞；\n· 点开头像给感兴趣的人发一条私信，不必先互相关注；\n· 把离岛添加到手机主屏幕，它就像一个轻量的 App。\n\n这里只有两条简单的约定：保持具体，保持善意。对观点可以锋利，对人不必。\n\n那么，今天想聊点什么？',
      created: ago(120),
      activity: ago(118),
      pinned: 1,
      views: 328,
    },
    {
      id: newId(),
      category: 'cat-general',
      author: 'xiaoman',
      title: '你们有哪些坚持了很久的小习惯？',
      content:
        '最近在整理自己的生活，突然发现自己坚持最久的一件事，是每天出门前给阳台上的薄荷浇一点水。\n\n它没有什么实际产出，但看到新叶子冒出来的时候，会觉得这一天是具体的。\n\n想听听大家的。可以很小很小，小到不值一提的那种。',
      created: ago(62),
      activity: ago(22),
      pinned: 0,
      views: 186,
    },
    {
      id: newId(),
      category: 'cat-tech',
      author: 'chenmo',
      title: '我用 Node.js 原生模块写了一个论坛，踩过的坑比想象中多',
      content:
        '周末做了个小实验：不装任何依赖，只用 node:http、node:sqlite 和原生 fetch，写一个能登录、发帖、私信的论坛。\n\n几个感受：\n1. 原生 SQLite 在 Node 24 里已经很好用了，开 WAL 之后并发读非常稳；\n2. 手写路由比想象中枯燥，但把所有 API 摊开之后反而更清楚；\n3. 最花时间的不是后端，是移动端输入框被键盘顶起来的那 100px。\n\n把数据库层封装好之后，其实整个服务不到一千行。有没有人也在做类似的无依赖实验？',
      created: ago(48),
      activity: ago(6),
      pinned: 0,
      views: 412,
    },
    {
      id: newId(),
      category: 'cat-life',
      author: 'ache',
      title: '周末去了一趟海边，风把烦恼都吹散了',
      content:
        '临时买了张车票，一个人去了最近的海边。\n\n下午四点的光很软，海面像一张被揉皱又铺开的锡纸。坐在防波堤上啃一个有点凉的三明治，旁边有个小孩在认真地捡贝壳。\n\n没有拍很多照片。回程的时候手机只剩百分之三的电，反而觉得刚刚好。\n\n如果最近也有点累，允许自己出去走走吧。不用去很远。',
      created: ago(31),
      activity: ago(18),
      pinned: 0,
      views: 274,
    },
    {
      id: newId(),
      category: 'cat-general',
      author: 'shanzhi',
      title: '有没有适合通勤路上听的播客推荐？',
      content:
        '每天单程地铁四十分钟，最近把常听的几档都追平了，进入了一种「打开播客却不知道听什么」的贤者时间。\n\n偏好：不太需要看画面、说话节奏别太赶、最好有一些具体的人和生活。\n\n提前谢谢大家的推荐。',
      created: ago(14),
      activity: ago(3),
      pinned: 0,
      views: 97,
    },
    {
      id: newId(),
      category: 'cat-tech',
      author: 'linwan',
      title: 'CSS 容器查询在真实项目里到底香不香？',
      content:
        '最近把一个后台项目的卡片列表从媒体查询改成了容器查询，组件终于可以真正地「到哪里都自适应」，而不是靠一堆断点补丁。\n\n但也有一些副作用：设计稿需要按容器宽度而不是页面宽度来思考，和设计师沟通的成本反而上来了。\n\n想问问已经在大项目里用容器查询的朋友，你们是怎么处理设计规范和组件边界的？',
      created: ago(8),
      activity: ago(4),
      pinned: 0,
      views: 143,
    },
    {
      id: newId(),
      category: 'cat-life',
      author: 'xiaoman',
      title: '第一次做番茄牛腩，居然成功了',
      content:
        '照着菜谱战战兢兢地做，中途还因为怕糊锅加了两次水，最后收汁的时候意外地很香。\n\n总结一下：牛腩一定要先煎到表面微焦，番茄分两次放，一次炒成酱，一次留块状。还有，别吝啬时间，小火炖够一个半小时。\n\n厨房新手第一次有了「我好像可以」的错觉。',
      created: ago(5),
      activity: ago(1),
      pinned: 0,
      views: 88,
    },
    {
      id: newId(),
      category: 'cat-help',
      author: 'ache',
      title: '如何让自己在下午三点保持专注？',
      content:
        '每天一到下午三点，脑子就像被按了静音键。咖啡也喝了，站起来走了，还是对着屏幕发呆。\n\n试过番茄钟，但经常一个番茄没结束就开始摸手机。\n\n大家有没有什么真正有用的办法？最好是那种不需要强大意志力的。',
      created: ago(2.4),
      activity: ago(0.5),
      pinned: 0,
      views: 61,
    },
  ];

  for (const topic of topics) {
    addTopic.run(
      topic.id,
      topic.category,
      people[topic.author].id,
      topic.title,
      topic.content,
      topic.created,
      topic.created,
      topic.activity,
      topic.pinned,
      topic.views,
    );
  }

  const replies = [
    [topics[0], 'chenmo', '指南写得很清楚。特别喜欢「对观点可以锋利，对人不必要」这句，已经记在备忘录里了。', ago(118)],
    [topics[0], 'xiaoman', '手机端体验很舒服，刚刚已经添加到主屏幕了，真的像一个 App。', ago(96)],
    [topics[1], 'ache', '每天睡前把第二天要穿的衣服放好。听起来很无聊，但早上真的会轻松很多。', ago(50)],
    [topics[1], 'shanzhi', '通勤路上不戴耳机，只听地铁的声音。算是给大脑留一段空白。', ago(44)],
    [topics[1], 'linwan', '每晚写三行日记，不总结，只记录。写了两年多，翻回去看的时候会感谢当时的自己。', ago(22)],
    [topics[2], 'linwan', '想请教一下，SQLite 的写并发你是怎么处理的？我之前在桌面端项目里被锁表折磨过。', ago(30)],
    [topics[2], 'chenmo', '我开的是 WAL，然后把所有写操作收敛到一个很短的同步事务里。这个场景写少读多，所以够用。高并发写入的话还是要换方案。', ago(27)],
    [topics[2], 'xiaoman', '「最花时间的是移动端输入框」过于真实，笑出声。', ago(6)],
    [topics[3], 'xiaoman', '看文字都能闻到海风。下次记得带个充电宝，但百分之三的电也确实很浪漫。', ago(24)],
    [topics[3], 'shanzhi', '被「像一张被揉皱又铺开的锡纸」击中了。', ago(18)],
    [topics[4], 'linwan', '推荐《随机波动》和《故事FM》，都是具体的人和生活，适合不看画面的时候听。', ago(10)],
    [topics[4], 'ache', '《日谈公园》通勤友好，聊天节奏很松，经常听着听着就到站了。', ago(3)],
    [topics[5], 'chenmo', '我们的做法是先定一套「容器尺寸 token」，设计稿直接引用 token，减少讨论。另外组件内部的断点要尽量少，两到三个就够。', ago(4)],
    [topics[6], 'ache', '恭喜！第一次做硬菜成功真的会记很久。求一个详细菜谱。', ago(3)],
    [topics[6], 'xiaoman', '等我下次再成功一次就写，怕这次是运气哈哈。', ago(1)],
    [topics[7], 'xiaoman', '把手机放到另一个房间，然后设一个二十五分钟的计时器。不是为了防止玩手机，是让起身去拿的成本变高。', ago(1.5)],
    [topics[7], 'chenmo', '下午三点先做五分钟最简单、最机械的事，比如整理待办或回一封短邮件。启动之后往往会顺下去。', ago(1)],
    [topics[7], 'shanzhi', '我会在这个时间点去接一杯水，顺便看窗外两分钟。不要刷短视频，那是另一个黑洞。', ago(0.5)],
  ];

  for (const [topic, author, content, created] of replies) {
    addReply.run(newId(), topic.id, people[author].id, content, created, created);
  }

  const likes = [
    ['linwan', topics[1]],
    ['ache', topics[1]],
    ['chenmo', topics[1]],
    ['shanzhi', topics[1]],
    ['linwan', topics[2]],
    ['xiaoman', topics[2]],
    ['ache', topics[2]],
    ['shanzhi', topics[3]],
    ['xiaoman', topics[3]],
    ['linwan', topics[3]],
    ['chenmo', topics[4]],
    ['linwan', topics[4]],
    ['ache', topics[5]],
    ['chenmo', topics[5]],
    ['linwan', topics[6]],
    ['ache', topics[6]],
    ['xiaoman', topics[6]],
    ['linwan', topics[7]],
    ['chenmo', topics[7]],
  ];
  for (const [username, topic] of likes) {
    addLike.run(people[username].id, 'topic', topic.id, ago(4));
  }

  const pair = (x, y) => [x, y].sort();
  const conv1 = newId();
  const [a1, b1] = pair(people.linwan.id, people.ache.id);
  addConversation.run(conv1, a1, b1, ago(30), ago(0.8));
  addMessage.run(newId(), conv1, people.ache.id, '看到你分享的容器查询帖子了，最近正好在改一个后台项目。', ago(5), ago(4.5));
  addMessage.run(newId(), conv1, people.linwan.id, '哈哈那你试试，先从卡片列表开始，改造成本不高。', ago(4.5), ago(4));
  addMessage.run(newId(), conv1, people.ache.id, '好，有不懂的再来请教你。', ago(3.4), ago(3));
  addMessage.run(newId(), conv1, people.linwan.id, '随时。', ago(3), ago(2.8));
  addMessage.run(newId(), conv1, people.ache.id, '对了，周末有空一起去看展吗？', ago(0.8), null);

  const conv2 = newId();
  const [a2, b2] = pair(people.linwan.id, people.xiaoman.id);
  addConversation.run(conv2, a2, b2, ago(40), ago(20));
  addMessage.run(newId(), conv2, people.xiaoman.id, '你上次推荐的那家面包店我去啦，肉桂卷好吃！', ago(22), ago(21));
  addMessage.run(newId(), conv2, people.linwan.id, '是吧！要早点去，下午就卖完了。', ago(21), ago(20.5));
  addMessage.run(newId(), conv2, people.xiaoman.id, '下次一起。', ago(20), ago(19.5));
}

function ensureAdminAccount(db) {
  const passwordHash = hashPasswordSync('qwE12qwE1');
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM users WHERE username_key = ?').get('island');
  if (existing) {
    db.prepare(`
      UPDATE users
      SET username = 'island', display_name = '离岛', password_hash = ?, bio = ?, is_admin = 1
      WHERE id = ?
    `).run(passwordHash, '守岛人。负责让这里保持干净、安静。', existing.id);
    return existing.id;
  }

  const id = newId();
  db.prepare(`
    INSERT INTO users (id, username, username_key, display_name, password_hash, bio, created_at, is_admin)
    VALUES (?, 'island', 'island', '离岛', ?, ?, ?, 1)
  `).run(id, passwordHash, '守岛人。负责让这里保持干净、安静。', now);
  return id;
}

function openDatabase(dbPath = path.join(__dirname, '..', 'data', 'forum.db'), { seed = true } = {}) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  migrate(db);

  const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (seed && userCount === 0) {
    db.exec('BEGIN IMMEDIATE');
    try {
      seedDatabase(db);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  ensureAdminAccount(db);
  return db;
}

module.exports = { CATEGORIES, openDatabase };

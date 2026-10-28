'use strict';

(() => {
  const main = document.getElementById('main');
  const authSlot = document.getElementById('auth-slot');
  const modalRoot = document.getElementById('modal-root');
  const toastRoot = document.getElementById('toast-root');
  const THEME_KEY = 'islands.theme';
  const DRAFT_KEY_PREFIX = 'islands.draft.v1';
  const SORTS = ['latest', 'hot', 'unanswered'];
  const CATEGORY_ICONS = {
    bell: 'bell',
    chat: 'chat',
    code: 'code',
    leaf: 'leaf',
    help: 'help',
  };

  const state = {
    me: null,
    summary: { unreadMessages: 0 },
    categories: [],
    route: null,
    eventSource: null,
    viewToken: 0,
    activeConversationId: null,
    activeOther: null,
    installPrompt: null,
    modalKeyHandler: null,
    modalCloseTimer: null,
    lastFocused: null,
    draftTimer: null,
    pickerTimer: null,
    pickerToken: 0,
    pendingAction: null,
  };

  const compactFormatter = new Intl.NumberFormat('zh-CN', {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  const numberFormatter = new Intl.NumberFormat('zh-CN');

  init();

  async function init() {
    applyTheme(readTheme());
    bindEvents();
    updateChrome();

    try {
      await Promise.all([loadMe(), loadCategories()]);
    } catch (error) {
      renderError(error.message || '暂时无法连接到服务器');
      return;
    }

    updateChrome();
    if (state.me) connectSSE();
    await renderRoute();
    registerServiceWorker();
    updateInstallUI();

    const params = new URLSearchParams(location.search);
    if (params.get('compose') === '1') {
      history.replaceState({}, '', location.pathname);
      if (state.me) {
        openCompose();
      } else {
        state.pendingAction = 'compose';
        openAuth('login');
      }
    }
  }

  /* ------------------------------------------------------------------------
     Small utilities
     ------------------------------------------------------------------------ */

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function safeColor(value, fallback = '#1a1a1a') {
    return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : fallback;
  }

  function firstChar(value) {
    return Array.from(String(value || '?'))[0] || '?';
  }

  function avatar(user, size = '') {
    const name = user?.displayName || user?.username || '?';
    const from = safeColor(user?.avatarFrom, '#1a1a1a');
    const to = safeColor(user?.avatarTo, '#e6e6e6');
    return `<span class="avatar ${size}" style="--av-from:${from};--av-to:${to}" aria-hidden="true">${escapeHtml(firstChar(name))}</span>`;
  }

  function icon(name, className = '') {
    return `<svg class="icon ${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  }

  function categoryIcon(category) {
    const name = CATEGORY_ICONS[category?.icon] || 'chat';
    return icon(name);
  }

  function formatCount(value) {
    const n = Number(value) || 0;
    return n > 9999 ? compactFormatter.format(n) : numberFormatter.format(n);
  }

  function formatNumber(value) {
    return numberFormatter.format(Number(value) || 0);
  }

  function asDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function timeAgo(value) {
    const date = asDate(value);
    if (!date) return '';
    const diff = Date.now() - date.getTime();
    if (diff < 45 * 1000) return '刚刚';
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return `${Math.max(1, minutes)} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} 天前`;
    if (date.getFullYear() === new Date().getFullYear()) {
      return `${date.getMonth() + 1}月${date.getDate()}日`;
    }
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function clockTime(value) {
    const date = asDate(value);
    if (!date) return '';
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  function shortWhen(value) {
    const date = asDate(value);
    if (!date) return '';
    const now = new Date();
    if (isSameDay(date, now)) return clockTime(date);
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (isSameDay(date, yesterday)) return '昨天';
    if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}/${date.getDate()}`;
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  }

  function isSameDay(a, b) {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  function dayKey(value) {
    const date = asDate(value);
    if (!date) return '';
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }

  function dayLabel(value) {
    const date = asDate(value);
    if (!date) return '';
    const now = new Date();
    if (isSameDay(date, now)) return '今天';
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (isSameDay(date, yesterday)) return '昨天';
    if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function longDate(value) {
    const date = asDate(value);
    if (!date) return '';
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function truncate(value, length) {
    const chars = Array.from(String(value || '').replace(/\s+/g, ' ').trim());
    return chars.length > length ? `${chars.slice(0, length).join('')}…` : chars.join('');
  }

  function formatProse(value) {
    return String(value || '')
      .split(/\n{2,}/)
      .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`)
      .join('');
  }

  function isStale(token) {
    return token !== state.viewToken;
  }

  function isMobileLayout() {
    return (
      document.documentElement.dataset.device === 'mobile' ||
      window.matchMedia?.('(max-width: 900px)').matches
    );
  }

  function searchUrl(query) {
    const q = String(query || '').trim();
    return q ? `/search?q=${encodeURIComponent(q)}` : '/search';
  }

  /* ------------------------------------------------------------------------
     API and session
     ------------------------------------------------------------------------ */

  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    const request = {
      method: options.method || 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(options.body);
    }
    let response;
    try {
      response = await fetch(path, request);
    } catch {
      const error = new Error('网络连接失败，请检查网络后重试');
      error.status = 0;
      throw error;
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      const error = new Error(data?.error || `请求失败（${response.status}）`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  async function loadMe() {
    const data = await api('/api/auth/me');
    state.me = data.user || null;
    state.summary = data.summary || { unreadMessages: 0 };
  }

  async function loadCategories(force = false) {
    if (state.categories.length && !force) return state.categories;
    const data = await api('/api/categories');
    state.categories = data.categories || [];
    return state.categories;
  }

  function ensureAuth() {
    if (state.me) return true;
    openAuth('login');
    return false;
  }

  /* ------------------------------------------------------------------------
     Routing and chrome
     ------------------------------------------------------------------------ */

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function parseRoute() {
    const path = location.pathname.replace(/\/+$/, '') || '/';
    const params = new URLSearchParams(location.search);
    const sort = SORTS.includes(params.get('sort')) ? params.get('sort') : 'latest';
    let match;

    if (path === '/') return { name: 'home', sort };
    if ((match = path.match(/^\/c\/([^/]+)$/))) {
      return { name: 'category', categorySlug: safeDecode(match[1]), sort };
    }
    if ((match = path.match(/^\/t\/([^/]+)$/))) {
      return { name: 'topic', topicId: safeDecode(match[1]) };
    }
    if (path === '/messages') return { name: 'messages', conversationId: null };
    if ((match = path.match(/^\/messages\/([^/]+)$/))) {
      return { name: 'messages', conversationId: safeDecode(match[1]) };
    }
    if ((match = path.match(/^\/u\/([^/]+)$/))) {
      return { name: 'profile', userId: safeDecode(match[1]) };
    }
    if (path === '/search') return { name: 'search', query: (params.get('q') || '').trim() };
    return { name: 'notfound' };
  }

  function navigate(path, { replace = false } = {}) {
    if (!path) return;
    const current = `${location.pathname}${location.search}`;
    if (current === path) {
      closeUserMenu();
      return;
    }
    history[replace ? 'replaceState' : 'pushState']({}, '', path);
    closeUserMenu();
    if (modalRoot.querySelector('.modal-backdrop')) closeModal();
    renderRoute();
  }

  async function renderRoute({ keepScroll = false } = {}) {
    cleanupView();

    if (location.pathname === '/me') {
      if (state.me) {
        history.replaceState({}, '', `/u/${state.me.id}`);
      } else {
        history.replaceState({}, '', '/');
        setTimeout(() => openAuth('login'), 30);
      }
    }

    const token = ++state.viewToken;
    const route = parseRoute();
    state.route = route;
    updateChrome();

    const previousScroll = window.scrollY;
    if (!keepScroll) window.scrollTo({ top: 0, behavior: 'auto' });

    try {
      if (route.name === 'home' || route.name === 'category') {
        await renderFeed(route, token);
      } else if (route.name === 'topic') {
        await renderTopic(route, token);
      } else if (route.name === 'messages') {
        await renderMessages(route, token);
      } else if (route.name === 'profile') {
        await renderProfile(route, token);
      } else if (route.name === 'search') {
        await renderSearch(route, token);
      } else {
        renderNotFound();
      }
      if (isStale(token)) return;
      updateChrome();
      if (keepScroll) window.scrollTo({ top: previousScroll, behavior: 'auto' });
    } catch (error) {
      if (isStale(token)) return;
      if (error.status === 404) {
        renderNotFound();
        return;
      }
      if (error.status === 401) {
        state.me = null;
        state.summary = { unreadMessages: 0 };
        disconnectSSE();
        updateChrome();
        if (route.name === 'messages') {
          renderMessagesAuthWall();
          openAuth('login');
          return;
        }
      }
      renderError(error.message || '页面加载失败');
    }
  }

  function cleanupView() {
    document.body.classList.remove('chat-mode');
    state.activeConversationId = null;
    state.activeOther = null;
    closeUserMenu();
    if (state.pickerTimer) {
      clearTimeout(state.pickerTimer);
      state.pickerTimer = null;
    }
  }

  function updateChrome() {
    const route = state.route || parseRoute();
    document.querySelectorAll('[data-nav]').forEach((element) => {
      const nav = element.dataset.nav;
      const inMobileBar = Boolean(element.closest('.mobile-tabbar'));
      let active = false;
      if (nav === 'home') {
        active = route.name === 'home' || route.name === 'category';
        if (route.name === 'search' && !inMobileBar) active = true;
      } else if (nav === 'search') {
        active = route.name === 'search';
      } else if (nav === 'messages') {
        active = route.name === 'messages';
      } else if (nav === 'profile') {
        active = route.name === 'profile' && Boolean(state.me);
      }
      element.classList.toggle('is-active', active);
      if (active) element.setAttribute('aria-current', 'page');
      else element.removeAttribute('aria-current');
    });
    renderAuthSlot();
    updateUnreadBadges();
    updateInstallUI();
  }

  function renderAuthSlot() {
    if (!state.me) {
      authSlot.innerHTML = `
        <button class="login-link" type="button" data-action="open-auth" data-mode="login">登录</button>
        <button class="join-button" type="button" data-action="open-auth" data-mode="register">加入离岛</button>
      `;
      return;
    }
    const unread = state.summary.unreadMessages || 0;
    authSlot.innerHTML = `
      <div class="user-menu-wrap">
        <button class="user-trigger" type="button" data-action="toggle-user-menu" aria-haspopup="menu" aria-expanded="false" aria-label="账户菜单">
          ${avatar(state.me, 'sm')}
          ${icon('chevron-down')}
        </button>
        <div class="user-menu" role="menu">
          <div class="user-menu-head">
            <strong>${escapeHtml(state.me.displayName)}${state.me.isAdmin ? '<span class="admin-mark">管理员</span>' : ''}</strong>
            <span>@${escapeHtml(state.me.username)}</span>
          </div>
          <a href="/u/${encodeURIComponent(state.me.id)}" data-link role="menuitem">${icon('user')}我的主页</a>
          <a href="/messages" data-link role="menuitem">${icon('message')}私信${unread ? `<span class="menu-count">${unread > 99 ? '99+' : unread}</span>` : ''}</a>
          <a href="/search" data-link role="menuitem">${icon('search')}发现话题</a>
          <div class="menu-separator"></div>
          <button type="button" class="danger" data-action="logout" role="menuitem">${icon('logout')}退出登录</button>
        </div>
      </div>
    `;
  }

  function toggleUserMenu() {
    const menu = authSlot.querySelector('.user-menu');
    const trigger = authSlot.querySelector('.user-trigger');
    if (!menu || !trigger) return;
    const open = !menu.classList.contains('is-open');
    menu.classList.toggle('is-open', open);
    trigger.setAttribute('aria-expanded', String(open));
  }

  function closeUserMenu() {
    const menu = authSlot.querySelector('.user-menu');
    const trigger = authSlot.querySelector('.user-trigger');
    if (!menu) return;
    menu.classList.remove('is-open');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }

  function updateUnreadBadges() {
    const count = Number(state.summary.unreadMessages) || 0;
    document.querySelectorAll('[data-unread-badge]').forEach((badge) => {
      badge.hidden = count <= 0;
      badge.textContent = count > 99 ? '99+' : String(count);
    });
    const menuCount = authSlot.querySelector('.menu-count');
    if (menuCount) {
      menuCount.textContent = count > 99 ? '99+' : String(count);
      menuCount.hidden = count <= 0;
    }
  }

  /* ------------------------------------------------------------------------
     Feed
     ------------------------------------------------------------------------ */

  function sortLabel(sort) {
    return sort === 'hot' ? '热门' : sort === 'unanswered' ? '等待回应' : '最新';
  }

  function feedSortUrl(route, sort) {
    const base = route.name === 'category' ? `/c/${encodeURIComponent(route.categorySlug)}` : '/';
    return sort === 'latest' ? base : `${base}?sort=${sort}`;
  }

  function renderTopicCard(topic) {
    const authorUrl = `/u/${encodeURIComponent(topic.author.id)}`;
    const categoryUrl = `/c/${encodeURIComponent(topic.category.slug)}`;
    return `
      <article class="topic-card${topic.isPinned ? ' is-pinned' : ''}">
        <div class="topic-card-head">
          <a class="topic-author" href="${authorUrl}" data-link>
            ${avatar(topic.author, 'sm')}
            <span class="topic-author-text">
              <strong>${escapeHtml(topic.author.displayName)}</strong>
              <span>@${escapeHtml(topic.author.username)} · ${timeAgo(topic.createdAt)}</span>
            </span>
          </a>
          <div class="topic-card-tags">
            ${topic.isPinned ? `<span class="pin-badge">${icon('spark')}置顶</span>` : ''}
            <a class="chip chip-green" href="${categoryUrl}" data-link>${categoryIcon(topic.category)}${escapeHtml(topic.category.name)}</a>
          </div>
        </div>
        <a class="topic-title-link" href="/t/${encodeURIComponent(topic.id)}" data-link>
          <h2 class="topic-title">${escapeHtml(topic.title)}</h2>
          <p class="topic-excerpt">${escapeHtml(topic.excerpt)}</p>
        </a>
        <div class="topic-card-foot">
          <div class="topic-stats">
            <span class="topic-stat">${icon('reply')}${formatCount(topic.replyCount)}</span>
            <span class="topic-stat">${icon('heart')}${formatCount(topic.likeCount)}</span>
            <span class="topic-stat">${icon('eye')}${formatCount(topic.views)}</span>
          </div>
          <span class="topic-last">${topic.replyCount ? `最后回应 ${timeAgo(topic.lastActivityAt)}` : '等待第一条回应'}</span>
        </div>
      </article>
    `;
  }

  function renderLeftRail(activeSlug) {
    const total = state.categories.reduce((sum, category) => sum + Number(category.topicCount || 0), 0);
    return `
      <aside class="left-rail" aria-label="板块导航">
        <section class="rail-card">
          <div class="rail-card-title"><span>浏览板块</span><span>${state.categories.length}</span></div>
          <nav class="category-list">
            <a class="category-link${activeSlug ? '' : ' is-active'}" href="/" data-link>
              <span class="category-icon">${icon('home')}</span>
              <span>全部话题</span>
              <span class="count">${formatCount(total)}</span>
            </a>
            ${state.categories
              .map(
                (category) => `
              <a class="category-link${activeSlug === category.slug ? ' is-active' : ''}" href="/c/${encodeURIComponent(category.slug)}" data-link>
                <span class="category-icon">${categoryIcon(category)}</span>
                <span>${escapeHtml(category.name)}</span>
                <span class="count">${formatCount(category.topicCount)}</span>
              </a>`,
              )
              .join('')}
          </nav>
          <button class="btn btn-primary btn-block compose-rail" type="button" data-action="compose" style="margin-top: 14px">
            ${icon('edit')}发起新话题
          </button>
        </section>
        <section class="rail-card">
          <div class="rail-card-title">小提示</div>
          <p class="rail-hint">点击作者头像可以进入主页，也可以直接发一条私信。</p>
        </section>
      </aside>
    `;
  }

  function renderRightRail(stats) {
    const installHidden = isStandalone() ? ' hidden' : '';
    if (!stats) {
      return `
        <aside class="right-rail" aria-label="社区信息">
          <section class="rail-card">
            <div class="rail-card-title">社区概览</div>
            <div class="skeleton-line"></div>
            <div class="skeleton-line w-70"></div>
          </section>
          <button class="install-card" type="button" data-action="install" data-install-card${installHidden}>
            <span class="icon-box">${icon('install')}</span>
            <span><strong>把离岛装进口袋</strong><span>添加到主屏幕，像 App 一样打开</span></span>
          </button>
        </aside>
      `;
    }
    const activeUsers = stats.activeUsers || [];
    return `
      <aside class="right-rail" aria-label="社区信息">
        <section class="rail-card">
          <div class="rail-card-title">
            <span>社区概览</span>
            <span class="online-pill"><span class="online-dot"></span>${stats.online || 0} 在线</span>
          </div>
          <div class="stat-grid">
            <div class="stat-item"><strong>${formatCount(stats.users)}</strong><span>成员</span></div>
            <div class="stat-item"><strong>${formatCount(stats.topics)}</strong><span>话题</span></div>
            <div class="stat-item"><strong>${formatCount(stats.replies)}</strong><span>回应</span></div>
          </div>
          ${
            activeUsers.length
              ? `<div class="active-list">
                  ${activeUsers
                    .map(
                      (user) => `
                    <a class="active-person" href="/u/${encodeURIComponent(user.id)}" data-link>
                      ${avatar(user, 'xs')}
                      <span class="active-person-text">
                        <strong>${escapeHtml(user.displayName)}</strong>
                        <span>${timeAgo(user.lastActiveAt)}活跃</span>
                      </span>
                    </a>`,
                    )
                    .join('')}
                </div>`
              : ''
          }
        </section>
        <button class="install-card" type="button" data-action="install" data-install-card${installHidden}>
          <span class="icon-box">${icon('install')}</span>
          <span><strong>把离岛装进口袋</strong><span>添加到主屏幕，像 App 一样打开</span></span>
        </button>
        <div class="rail-note">
          ${icon('spark')}
          <p>不必急着得出结论。<br>先把此刻具体的感受写下来。</p>
          <small>离岛 · 社区公约</small>
        </div>
      </aside>
    `;
  }

  async function renderFeed(route, token) {
    await loadCategories();
    const category = route.categorySlug
      ? state.categories.find((item) => item.slug === route.categorySlug)
      : null;
    if (route.categorySlug && !category) {
      renderNotFound();
      return;
    }

    const params = new URLSearchParams({ sort: route.sort, pageSize: '10' });
    if (category) params.set('category', category.slug);
    const statsPromise = api('/api/stats').catch(() => ({ stats: null }));
    const [data, statsData] = await Promise.all([api(`/api/topics?${params.toString()}`), statsPromise]);
    if (isStale(token)) return;

    const stats = statsData.stats;
    const topics = data.topics || [];
    const pagination = data.pagination;

    const contentHead = category
      ? `
        <div class="page-head">
          <div class="page-head-main">
            <span class="page-icon">${categoryIcon(category)}</span>
            <div>
              <h1>${escapeHtml(category.name)}</h1>
              <p>${escapeHtml(category.description)}</p>
            </div>
          </div>
          <button class="btn btn-primary" type="button" data-action="compose">${icon('edit')}发布话题</button>
        </div>`
      : `
        <section class="hero">
          <div class="hero-content">
            <div class="eyebrow">${icon('spark')} ISLAND'S FORUM</div>
            <h1>今天，想聊点什么？</h1>
            <p>把具体的日常写下来。<br>会有人认真读完，也可能刚好遇见一个同频的人。</p>
            <div class="hero-actions">
              <button class="btn btn-lg btn-cream" type="button" data-action="compose">${icon('edit')}写下此刻</button>
              <a class="btn btn-lg btn-ghost" href="#topic-feed">随便看看</a>
            </div>
            <div class="hero-footnote">${stats ? `${formatCount(stats.users)} 位朋友在离岛，${formatCount(stats.topics)} 个话题正在被谈论。` : '一个不太着急的地方。'}</div>
          </div>
          <div class="hero-orbit" aria-hidden="true"><span></span><span></span><span>${icon('spark')}</span></div>
        </section>`;

    const sortTabs = SORTS.map(
      (sort) => `<a class="${route.sort === sort ? 'is-active' : ''}" href="${feedSortUrl(route, sort)}" data-link>${sortLabel(sort)}</a>`,
    ).join('');

    main.innerHTML = `
      <div class="feed-layout">
        ${renderLeftRail(category?.slug || '')}
        <section class="feed-column" id="topic-feed" aria-label="${category ? escapeHtml(category.name) : '话题广场'}">
          ${contentHead}
          <div class="feed-toolbar">
            <nav class="segmented" aria-label="排序方式">${sortTabs}</nav>
            <span class="feed-count">共 ${formatNumber(pagination.total)} 个话题</span>
          </div>
          <div class="topic-list" id="topic-list">
            ${
              topics.length
                ? topics.map(renderTopicCard).join('')
                : `<div class="state-card">
                    <span class="state-icon">${icon('chat')}</span>
                    <h3>这里还很安静</h3>
                    <p>${route.sort === 'unanswered' ? '所有话题都已经有人回应了。' : '成为第一个在这里说话的人吧。'}</p>
                    <button class="btn btn-primary" type="button" data-action="compose">${icon('edit')}发布第一个话题</button>
                  </div>`
            }
          </div>
          ${
            pagination.pages > 1
              ? `<div class="load-more-wrap"><button class="btn btn-ghost" type="button" id="load-more">加载更多话题</button></div>`
              : ''
          }
        </section>
        ${renderRightRail(stats)}
      </div>
    `;

    document.title =
      route.name === 'category' ? `${category.name} · Island's forum` : "Island's forum · 离岛的论坛";

    const loadMore = document.getElementById('load-more');
    if (loadMore) {
      let page = pagination.page;
      let loading = false;
      loadMore.addEventListener('click', async () => {
        if (loading) return;
        loading = true;
        loadMore.disabled = true;
        loadMore.textContent = '正在加载…';
        try {
          const nextParams = new URLSearchParams(params);
          nextParams.set('page', String(page + 1));
          const next = await api(`/api/topics?${nextParams.toString()}`);
          if (isStale(token)) return;
          const list = document.getElementById('topic-list');
          if (list) list.insertAdjacentHTML('beforeend', (next.topics || []).map(renderTopicCard).join(''));
          page = next.pagination.page;
          if (page >= next.pagination.pages) {
            loadMore.parentElement.remove();
          } else {
            loadMore.disabled = false;
            loadMore.textContent = '加载更多话题';
          }
        } catch (error) {
          if (!isStale(token)) toast(error.message || '加载失败', { type: 'error' });
          loadMore.disabled = false;
          loadMore.textContent = '加载更多话题';
        } finally {
          loading = false;
        }
      });
    }
  }

  /* ------------------------------------------------------------------------
     Topic detail
     ------------------------------------------------------------------------ */

  function renderReplyCard(reply, index) {
    const authorUrl = `/u/${encodeURIComponent(reply.author.id)}`;
    return `
      <article class="reply-card" data-reply-id="${escapeHtml(reply.id)}">
        <a href="${authorUrl}" data-link>${avatar(reply.author, 'sm')}</a>
        <div class="reply-body">
          <div class="reply-head">
            <a href="${authorUrl}" data-link><strong>${escapeHtml(reply.author.displayName)}</strong></a>
            <span>@${escapeHtml(reply.author.username)} · ${timeAgo(reply.createdAt)}</span>
            <span class="reply-number">#${index + 1}</span>
          </div>
          <div class="reply-content">${escapeHtml(reply.content)}</div>
          <div class="reply-actions">
            <button class="reply-like${reply.liked ? ' is-liked' : ''}" type="button" data-action="like-reply" data-like-id="${escapeHtml(reply.id)}" aria-pressed="${reply.liked ? 'true' : 'false'}">
              ${icon('heart')}<span data-like-count>${formatCount(reply.likeCount)}</span>
            </button>
          </div>
        </div>
      </article>
    `;
  }

  async function renderTopic(route, token) {
    const data = await api(`/api/topics/${encodeURIComponent(route.topicId)}`);
    if (isStale(token)) return;
    const { topic, replies } = data;
    const isMine = state.me?.id === topic.author.id;
    const categoryUrl = `/c/${encodeURIComponent(topic.category.slug)}`;
    const authorUrl = `/u/${encodeURIComponent(topic.author.id)}`;
    const backUrl = categoryUrl;

    main.innerHTML = `
      <div class="detail-shell">
        <a class="back-link" href="${backUrl}" data-link>${icon('arrow-left')}返回${escapeHtml(topic.category.name)}</a>
        <article class="topic-article">
          <div class="article-eyebrow">
            <a class="category-link" href="${categoryUrl}" data-link>${categoryIcon(topic.category)}${escapeHtml(topic.category.name)}</a>
            <span class="plain-meta">发布于 ${longDate(topic.createdAt)}</span>
            ${topic.isPinned ? `<span class="pin-badge">${icon('spark')}置顶</span>` : ''}
            ${topic.isLocked ? `<span class="chip">${icon('lock')}已锁定</span>` : ''}
          </div>
          <h1>${escapeHtml(topic.title)}</h1>
          <div class="article-byline">
            <a href="${authorUrl}" data-link>${avatar(topic.author, 'md')}</a>
            <div class="byline-text">
              <a href="${authorUrl}" data-link><strong>${escapeHtml(topic.author.displayName)}</strong></a>
              <span>@${escapeHtml(topic.author.username)} · ${timeAgo(topic.createdAt)}</span>
            </div>
            <span class="chip chip-green byline-role">楼主</span>
          </div>
          <div class="prose">${formatProse(topic.content)}</div>
          <div class="article-actions">
            <button class="like-button${topic.liked ? ' is-liked' : ''}" type="button" data-action="like-topic" data-like-id="${escapeHtml(topic.id)}" aria-pressed="${topic.liked ? 'true' : 'false'}">
              ${icon('heart')}赞 <span data-like-count>${formatCount(topic.likeCount)}</span>
            </button>
            ${
              !isMine
                ? `<button class="btn btn-ghost btn-sm" type="button" data-action="message-user" data-user-id="${escapeHtml(topic.author.id)}">${icon('message')}私信作者</button>`
                : ''
            }
            <button class="btn btn-ghost btn-sm" type="button" data-action="copy-link">${icon('link')}复制链接</button>
            ${
              state.me?.isAdmin
                ? `<button class="btn btn-danger btn-sm" type="button" data-action="delete-topic" data-topic-id="${escapeHtml(topic.id)}" data-topic-title="${escapeHtml(topic.title)}" data-return-url="${escapeHtml(categoryUrl)}">${icon('trash')}删除帖子</button>`
                : ''
            }
            <div class="article-meta-right">
              <span>${icon('eye')}${formatCount(topic.views)} 次阅读</span>
              <span>${icon('reply')}<b data-reply-count>${formatNumber(topic.replyCount)}</b> 条回应</span>
            </div>
          </div>
        </article>

        <section class="replies-section">
          <div class="section-heading">
            <h2>回应 <span><b data-reply-count>${formatNumber(topic.replyCount)}</b> 条</span></h2>
          </div>
          <div class="reply-list" id="reply-list">
            ${replies.map(renderReplyCard).join('')}
          </div>
          ${
            replies.length
              ? ''
              : `<div class="reply-empty" id="reply-empty">还没有回应。第一个坐下来聊聊的人，会是你吗？</div>`
          }
          ${
            topic.isLocked
              ? `<div class="locked-note">${icon('lock')}这个话题已经锁定，暂时无法继续回复。</div>`
              : state.me
                ? `<form class="reply-composer" id="reply-form" data-topic-id="${escapeHtml(topic.id)}" novalidate>
                    <div class="composer-row">
                      ${avatar(state.me, 'sm')}
                      <div class="composer-field">
                        <textarea class="textarea" name="content" maxlength="5000" placeholder="写下你的回应…" aria-label="回应内容"></textarea>
                        <p class="form-error" id="reply-error" hidden></p>
                        <div class="composer-actions">
                          <span class="composer-hint">保持具体，保持善意。</span>
                          <button class="btn btn-primary" type="submit">发布回应</button>
                        </div>
                      </div>
                    </div>
                  </form>`
                : `<div class="login-prompt">
                    <div><strong>加入这场对话</strong><p>登录后就可以回复，也可以给作者发一条私信。</p></div>
                    <button class="btn btn-primary" type="button" data-action="open-auth" data-mode="login">登录 / 注册</button>
                  </div>`
          }
        </section>
      </div>
    `;
    document.title = `${topic.title} · Island's forum`;
  }

  /* ------------------------------------------------------------------------
     Messages
     ------------------------------------------------------------------------ */

  function renderConversationItems(conversations, activeId) {
    if (!conversations.length) {
      return `
        <div class="conversation-empty">
          ${icon('message')}
          还没有私信。<br>去认识一个有趣的人吧。
          <div style="margin-top: 14px"><button class="btn btn-soft btn-sm" type="button" data-action="open-picker">发起私信</button></div>
        </div>
      `;
    }
    return conversations
      .map((conversation) => {
        const other = conversation.other;
        const preview = conversation.lastMessage
          ? `${conversation.lastMessage.mine ? '<span class="mine-prefix">你：</span>' : ''}${escapeHtml(conversation.lastMessage.content)}`
          : '<span class="faint">开始一段新的对话</span>';
        return `
          <a class="conv-item${conversation.id === activeId ? ' is-active' : ''}${conversation.unread ? ' has-unread' : ''}" href="/messages/${encodeURIComponent(conversation.id)}" data-link data-conv-id="${escapeHtml(conversation.id)}">
            ${avatar(other, 'md')}
            <span class="conv-main">
              <span class="conv-top">
                <strong>${escapeHtml(other.displayName)}</strong>
                <span class="conv-time">${shortWhen(conversation.lastMessage?.createdAt || conversation.updatedAt)}</span>
              </span>
              <span class="conv-preview">${preview}</span>
            </span>
            ${conversation.unread ? `<span class="conv-unread">${conversation.unread > 99 ? '99+' : conversation.unread}</span>` : ''}
          </a>
        `;
      })
      .join('');
  }

  function renderMessageRow(message, other) {
    const sender = message.mine ? state.me : other;
    return `
      <div class="msg-row${message.mine ? ' mine' : ''}" data-message-id="${escapeHtml(message.id)}">
        ${avatar(sender, 'sm')}
        <div class="msg-stack">
          <div class="msg-bubble">${escapeHtml(message.content)}</div>
          <div class="msg-time">${clockTime(message.createdAt)}</div>
        </div>
      </div>
    `;
  }

  function renderMessagesBody(messages, other) {
    if (!messages.length) {
      return `<div class="chat-day" data-placeholder="true">现在，打个招呼吧</div>`;
    }
    let html = '';
    let lastDay = '';
    for (const message of messages) {
      const key = dayKey(message.createdAt);
      if (key !== lastDay) {
        html += `<div class="chat-day">${dayLabel(message.createdAt)}</div>`;
        lastDay = key;
      }
      html += renderMessageRow(message, other);
    }
    return html;
  }

  function renderChatPanel(active, messages) {
    const other = active.conversation.other;
    const lastDay = messages.length ? dayKey(messages[messages.length - 1].createdAt) : '';
    return `
      <div class="chat-head">
        <a class="icon-button mobile-chat-back" href="/messages" data-link aria-label="返回私信列表">${icon('arrow-left')}</a>
        ${avatar(other, 'md')}
        <a class="chat-head-text" href="/u/${encodeURIComponent(other.id)}" data-link>
          <strong>${escapeHtml(other.displayName)}</strong>
          <span>@${escapeHtml(other.username)}</span>
        </a>
        <a class="icon-button" href="/u/${encodeURIComponent(other.id)}" data-link aria-label="查看主页" title="查看主页">${icon('user')}</a>
      </div>
      <div class="chat-messages" id="chat-messages" data-last-day="${lastDay}">
        ${renderMessagesBody(messages, other)}
      </div>
      <form class="chat-composer" id="chat-form" data-conversation-id="${escapeHtml(active.conversation.id)}" novalidate>
        <div class="chat-composer-inner">
          <textarea name="content" maxlength="2000" rows="1" placeholder="写一条私信…" aria-label="私信内容" data-chat-input></textarea>
          <button class="chat-send" type="submit" aria-label="发送">${icon('send')}</button>
        </div>
        <p class="form-error" id="chat-error" hidden></p>
        <div class="chat-composer-meta">
          <span>Enter 发送 · Shift + Enter 换行</span>
          <span data-chat-count>0 / 2000</span>
        </div>
      </form>
    `;
  }

  function renderMessagesAuthWall() {
    main.innerHTML = `
      <div class="messages-page">
        <div class="chat-auth-wall">
          <span class="state-icon">${icon('message')}</span>
          <h1>私信，是两个人的小房间</h1>
          <p>登录后可以查看会话、给感兴趣的人发消息，也可以在任何话题下继续聊。</p>
          <button class="btn btn-primary btn-lg" type="button" data-action="open-auth" data-mode="login">登录后查看私信</button>
        </div>
      </div>
    `;
    document.title = '私信 · Island\'s forum';
  }

  async function renderMessages(route, token) {
    if (!state.me) {
      renderMessagesAuthWall();
      return;
    }
    const conversationId = route.conversationId;
    const conversationsData = await api('/api/conversations');
    let active = null;
    let messages = [];
    if (conversationId) {
      try {
        const [conversationData, messageData] = await Promise.all([
          api(`/api/conversations/${encodeURIComponent(conversationId)}`),
          api(`/api/conversations/${encodeURIComponent(conversationId)}/messages`),
        ]);
        active = { conversation: conversationData.conversation, unread: conversationData.conversation.unread };
        messages = messageData.messages || [];
      } catch (error) {
        if (error.status === 404) {
          toast('这段会话不存在或已被删除', { type: 'error' });
          navigate('/messages', { replace: true });
          return;
        }
        throw error;
      }
    }
    if (isStale(token)) return;

    const conversations = conversationsData.conversations || [];
    state.activeConversationId = active?.conversation.id || null;
    state.activeOther = active?.conversation.other || null;
    if (active) document.body.classList.add('chat-mode');

    main.innerHTML = `
      <div class="messages-page">
        <div class="messages-shell${active ? ' has-active' : ''}">
          <section class="conversation-panel" aria-label="会话列表">
            <div class="conversation-head">
              <h1>私信</h1>
              <button class="icon-button" type="button" data-action="open-picker" aria-label="发起新私信" title="发起新私信">${icon('edit')}</button>
            </div>
            <label class="conversation-search">
              ${icon('search')}
              <input type="search" id="conversation-filter" placeholder="搜索会话" autocomplete="off" aria-label="搜索会话">
            </label>
            <div class="conversation-list" id="conversation-list">
              ${renderConversationItems(conversations, active?.conversation.id || null)}
            </div>
          </section>
          <section class="chat-panel" aria-label="对话内容">
            ${
              active
                ? renderChatPanel(active, messages)
                : `<div class="chat-empty">
                    <span class="chat-empty-mark">${icon('message')}</span>
                    <h2>把话说给具体的人</h2>
                    <p>从左侧选一段会话，或者发起一段新的对话。私信不必先互相关注。</p>
                    <button class="btn btn-primary" type="button" data-action="open-picker">发起一段对话</button>
                  </div>`
            }
          </section>
        </div>
      </div>
    `;
    document.title = active ? `${active.conversation.other.displayName} · 私信 · Island's forum` : '私信 · Island\'s forum';

    if (active) {
      requestAnimationFrame(() => {
        scrollChat(false);
        const textarea = document.querySelector('[data-chat-input]');
        if (textarea && !isMobileLayout()) textarea.focus({ preventScroll: true });
      });
      if (active.unread > 0) markConversationRead(active.conversation.id);
    }
  }

  async function markConversationRead(conversationId) {
    if (!state.me || !conversationId) return;
    try {
      const data = await api(`/api/conversations/${encodeURIComponent(conversationId)}/read`, {
        method: 'POST',
        body: {},
      });
      state.summary.unreadMessages = data.unreadMessages || 0;
      updateUnreadBadges();
      const item = document.querySelector(`.conv-item[data-conv-id="${conversationId}"]`);
      if (item) {
        item.classList.remove('has-unread');
        item.querySelector('.conv-unread')?.remove();
      }
    } catch (error) {
      if (error.status === 401) {
        state.me = null;
        updateChrome();
      }
    }
  }

  function scrollChat(smooth = true) {
    const list = document.getElementById('chat-messages');
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  function appendMessage(message, other) {
    const list = document.getElementById('chat-messages');
    if (!list) return;
    if (list.querySelector(`[data-message-id="${message.id}"]`)) return;
    const placeholder = list.querySelector('[data-placeholder]');
    if (placeholder) placeholder.remove();
    const key = dayKey(message.createdAt);
    if (list.dataset.lastDay !== key) {
      list.insertAdjacentHTML('beforeend', `<div class="chat-day">${dayLabel(message.createdAt)}</div>`);
      list.dataset.lastDay = key;
    }
    list.insertAdjacentHTML('beforeend', renderMessageRow(message, other));
    scrollChat(true);
  }

  async function refreshConversationList() {
    if (state.route?.name !== 'messages' || !state.me) return;
    try {
      const data = await api('/api/conversations');
      if (state.route?.name !== 'messages') return;
      const list = document.getElementById('conversation-list');
      if (!list) return;
      list.innerHTML = renderConversationItems(data.conversations || [], state.activeConversationId);
      const filter = document.getElementById('conversation-filter');
      if (filter?.value) applyConversationFilter(filter.value);
    } catch {
      // A transient failure here doesn't need to interrupt the conversation.
    }
  }

  function updateConversationPreview(conversationId, content) {
    const item = document.querySelector(`.conv-item[data-conv-id="${conversationId}"]`);
    if (!item) {
      refreshConversationList();
      return;
    }
    const preview = item.querySelector('.conv-preview');
    if (preview) {
      preview.innerHTML = `<span class="mine-prefix">你：</span>${escapeHtml(truncate(content, 48))}`;
    }
    const time = item.querySelector('.conv-time');
    if (time) time.textContent = clockTime(new Date());
    const list = item.parentElement;
    if (list && list.firstElementChild !== item) list.prepend(item);
  }

  function applyConversationFilter(query) {
    const needle = String(query || '').trim().toLowerCase();
    document.querySelectorAll('.conv-item').forEach((item) => {
      item.hidden = Boolean(needle) && !item.textContent.toLowerCase().includes(needle);
    });
  }

  function handleIncomingMessage(payload) {
    if (!state.me) return;
    const message = payload?.message;
    if (!message || !message.id) return;

    if (message.senderId === state.me.id) {
      const ownActiveId = state.route?.name === 'messages' ? state.route.conversationId : null;
      if (ownActiveId && ownActiveId === payload.conversationId && state.activeOther) {
        appendMessage({ ...message, mine: true }, state.activeOther);
      }
      refreshConversationList();
      return;
    }

    if (typeof payload.unreadMessages === 'number') {
      state.summary.unreadMessages = payload.unreadMessages;
    }
    updateUnreadBadges();

    const activeId = state.route?.name === 'messages' ? state.route.conversationId : null;
    const isActive = Boolean(activeId && activeId === payload.conversationId && state.activeOther);
    if (isActive) {
      appendMessage({ ...message, mine: false }, state.activeOther);
      refreshConversationList();
      if (document.visibilityState === 'visible') {
        markConversationRead(payload.conversationId);
      }
    } else {
      if (document.visibilityState === 'visible') {
        toast(`${message.senderDisplayName || '有人'}：${truncate(message.content, 38)}`, {
          iconName: 'message',
          duration: 4500,
        });
      }
      if (state.route?.name === 'messages') refreshConversationList();
    }
  }

  /* ------------------------------------------------------------------------
     Profile
     ------------------------------------------------------------------------ */

  async function renderProfile(route, token) {
    const data = await api(`/api/users/${encodeURIComponent(route.userId)}`);
    if (isStale(token)) return;
    const { user, isMe, stats, topics } = data;
    const topicItems = topics.length
      ? topics
          .map(
            (topic) => `
          <li class="profile-topic">
            <div class="profile-topic-main">
              <h3><a href="/t/${encodeURIComponent(topic.id)}" data-link>${escapeHtml(topic.title)}</a></h3>
              <p>${timeAgo(topic.createdAt)} · ${formatCount(topic.replyCount)} 条回应 · ${formatCount(topic.likeCount)} 个赞</p>
            </div>
            <span class="chip">${escapeHtml(topic.category.name)}</span>
          </li>`,
          )
          .join('')
      : `<li class="reply-empty">还没有发布过话题。</li>`;

    main.innerHTML = `
      <div class="profile-page">
        <div class="profile-card">
          <div class="profile-cover" aria-hidden="true"></div>
          <div class="profile-main">
            <div class="profile-avatar-row">
              ${avatar(user, 'xl')}
              <div class="profile-headline">
                <h1>${escapeHtml(user.displayName)}</h1>
                <div class="profile-handle">@${escapeHtml(user.username)}${user.isAdmin ? '<span class="admin-mark">管理员</span>' : ''}</div>
              </div>
              <div class="profile-actions">
                ${
                  isMe
                    ? `<button class="btn btn-primary" type="button" data-action="compose" aria-label="发布话题" title="发布话题">${icon('edit')}<span>发布话题</span></button>`
                    : `<button class="btn btn-primary" type="button" data-action="message-user" data-user-id="${escapeHtml(user.id)}" aria-label="发私信" title="发私信">${icon('message')}<span>发私信</span></button>`
                }
              </div>
            </div>
            <p class="profile-bio">${escapeHtml(user.bio || '这个人还没有写下自我介绍。')}</p>
            <div class="profile-meta">
              <span>${icon('spark')}${longDate(user.createdAt)}加入</span>
              ${isMe ? '<span>这是你的主页</span>' : ''}
            </div>
            <div class="profile-stats">
              <div class="profile-stat"><strong>${formatCount(stats.topics)}</strong><span>话题</span></div>
              <div class="profile-stat"><strong>${formatCount(stats.replies)}</strong><span>回应</span></div>
              <div class="profile-stat"><strong>${formatCount(stats.likesReceived)}</strong><span>收到的赞</span></div>
            </div>
          </div>
        </div>
        <div class="profile-body">
          <section class="profile-section">
            <div class="profile-section-head"><h2>最近的话题</h2><span>${formatCount(stats.topics)} 个</span></div>
            <ul class="profile-topic-list">${topicItems}</ul>
          </section>
          <aside class="about-card">
            <h2>关于 ${escapeHtml(user.displayName)}</h2>
            <p>${escapeHtml(user.bio || '这个人还没有写下自我介绍。')}</p>
            ${user.isAdmin ? '<div class="about-line"><span>身份</span><strong>管理员</strong></div>' : ''}
            <div class="about-line"><span>加入离岛</span><strong>${longDate(user.createdAt)}</strong></div>
            <div class="about-line"><span>公开话题</span><strong>${formatCount(stats.topics)}</strong></div>
            <div class="about-line"><span>参与回应</span><strong>${formatCount(stats.replies)}</strong></div>
          </aside>
        </div>
      </div>
    `;
    document.title = `${user.displayName} · Island's forum`;
  }

  /* ------------------------------------------------------------------------
     Search
     ------------------------------------------------------------------------ */

  async function renderSearch(route, token) {
    const query = route.query || '';
    let data = null;
    if (query) data = await api(`/api/topics?q=${encodeURIComponent(query)}&pageSize=30`);
    if (isStale(token)) return;
    const topics = data?.topics || [];
    const tags = ['周末', '写代码', '播客', '做饭', '专注', '海边'];

    main.innerHTML = `
      <div class="search-page">
        <section class="search-hero">
          <div class="eyebrow">${icon('search')} FIND SOMETHING</div>
          <h1>在离岛里找一找</h1>
          <p>可以搜索话题标题、正文，或者某个人的昵称。</p>
          <form class="search-form" id="search-page-form" role="search">
            ${icon('search')}
            <input type="search" name="q" value="${escapeHtml(query)}" placeholder="试试「播客」「周末」或「写代码」" autocomplete="off" aria-label="搜索话题">
            <button class="btn btn-primary" type="submit">搜索</button>
          </form>
          <div class="search-tags">
            ${tags.map((tag) => `<button type="button" data-action="search-tag" data-query="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join('')}
          </div>
        </section>
        ${
          query
            ? `<div class="search-results-head">
                <h2>“${escapeHtml(query)}”的搜索结果</h2>
                <span>${formatNumber(data?.pagination?.total || 0)} 个话题</span>
              </div>
              <div class="topic-list">
                ${
                  topics.length
                    ? topics.map(renderTopicCard).join('')
                    : `<div class="state-card search-empty">
                        <span class="state-icon">${icon('search')}</span>
                        <h3>没有找到相关话题</h3>
                        <p>换一个更短或更具体的关键词试试，或者由你开启这个话题。</p>
                        <button class="btn btn-primary" type="button" data-action="compose">${icon('edit')}发布话题</button>
                      </div>`
                }
              </div>`
            : `<div class="state-card search-empty">
                <span class="state-icon">${icon('spark')}</span>
                <h3>从一个词开始</h3>
                <p>输入关键词，找到正在聊这件事的人。也可以直接去广场看看。</p>
                <a class="btn btn-soft" href="/" data-link>去广场逛逛</a>
              </div>`
        }
      </div>
    `;
    document.title = query ? `搜索“${query}” · Island's forum` : '发现 · Island\'s forum';
  }

  /* ------------------------------------------------------------------------
     State pages
     ------------------------------------------------------------------------ */

  function renderNotFound() {
    main.innerHTML = `
      <div class="state-card" style="margin-top: 40px">
        <span class="state-icon">${icon('help')}</span>
        <h3>这一页不在离岛里</h3>
        <p>它可能被收进了抽屉，或者链接写错了。回到广场继续逛逛吧。</p>
        <a class="btn btn-primary" href="/" data-link>回到广场</a>
      </div>
    `;
    document.title = '页面不存在 · Island\'s forum';
  }

  function renderError(message) {
    main.innerHTML = `
      <div class="state-card" style="margin-top: 40px">
        <span class="state-icon">${icon('refresh')}</span>
        <h3>这一页暂时没有翻开</h3>
        <p>${escapeHtml(message || '请稍后再试。')}</p>
        <button class="btn btn-primary" type="button" data-action="retry">${icon('refresh')}再试一次</button>
      </div>
    `;
  }

  /* ------------------------------------------------------------------------
     Auth modal
     ------------------------------------------------------------------------ */

  function authModalHtml(mode) {
    const isRegister = mode === 'register';
    return `
      <button class="modal-close" type="button" data-action="close-modal" aria-label="关闭">${icon('close')}</button>
      <div class="modal-eyebrow">ISLAND'S FORUM</div>
      <h2 id="auth-title">${isRegister ? '成为离岛的一员' : '欢迎回来'}</h2>
      <p class="modal-subtitle" id="auth-subtitle">${isRegister ? '取一个喜欢的名字，从一句话开始。' : '坐下来，慢慢说。'}</p>
      <div class="auth-tabs" role="tablist" aria-label="登录或注册">
        <button class="auth-tab${isRegister ? '' : ' is-active'}" type="button" role="tab" aria-selected="${!isRegister}" data-action="auth-tab" data-mode="login">登录</button>
        <button class="auth-tab${isRegister ? ' is-active' : ''}" type="button" role="tab" aria-selected="${isRegister}" data-action="auth-tab" data-mode="register">注册</button>
      </div>
      <form id="auth-form" class="form-grid" data-mode="${mode}" novalidate>
        <div class="field" id="register-name-field"${isRegister ? '' : ' hidden'}>
          <label class="field-label" for="auth-display">昵称 <small>大家怎么称呼你</small></label>
          <input class="input" id="auth-display" name="displayName" type="text" maxlength="24" autocomplete="nickname" placeholder="例如：林间来信">
        </div>
        <div class="field">
          <label class="field-label" for="auth-username">用户名</label>
          <input class="input" id="auth-username" name="username" type="text" maxlength="20" autocomplete="username" placeholder="3–20 位中文、字母、数字或下划线">
        </div>
        <div class="field">
          <label class="field-label" for="auth-password">密码 <small>${isRegister ? '至少 8 个字符' : ''}</small></label>
          <input class="input" id="auth-password" name="password" type="password" maxlength="128" autocomplete="${isRegister ? 'new-password' : 'current-password'}" placeholder="${isRegister ? '设置一个至少 8 位的密码' : '输入密码'}">
        </div>
        <p class="form-error" id="auth-error" hidden></p>
        <div class="form-actions">
          <button class="btn btn-primary btn-lg btn-block" type="submit">${isRegister ? '创建账号' : '登录'}</button>
        </div>
      </form>
      <div class="demo-box">
        想先看看？访客 <code>linwan</code> / <code>demo1234</code>
        <button class="text-button" type="button" data-action="demo-login">一键体验 →</button>
      </div>
    `;
  }

  function openAuth(mode = 'login') {
    if (state.me) return;
    const safeMode = mode === 'register' ? 'register' : 'login';
    openModal(authModalHtml(safeMode), { label: 'auth-title' });
    setTimeout(() => {
      const form = document.getElementById('auth-form');
      const field = form?.dataset.mode === 'register' ? form.querySelector('[name="displayName"]') : form?.querySelector('[name="username"]');
      field?.focus({ preventScroll: true });
    }, 120);
  }

  function switchAuthMode(mode) {
    const form = document.getElementById('auth-form');
    if (!form) return;
    const isRegister = mode === 'register';
    form.dataset.mode = mode;
    const field = document.getElementById('register-name-field');
    if (field) field.hidden = !isRegister;
    const heading = document.getElementById('auth-title');
    const subtitle = document.getElementById('auth-subtitle');
    if (heading) heading.textContent = isRegister ? '成为离岛的一员' : '欢迎回来';
    if (subtitle) subtitle.textContent = isRegister ? '取一个喜欢的名字，从一句话开始。' : '坐下来，慢慢说。';
    form.querySelector('.form-actions .btn').textContent = isRegister ? '创建账号' : '登录';
    const password = form.querySelector('[name="password"]');
    if (password) {
      password.autocomplete = isRegister ? 'new-password' : 'current-password';
      password.placeholder = isRegister ? '设置一个至少 8 位的密码' : '输入密码';
      const hint = password.closest('.field')?.querySelector('.field-label small');
      if (hint) hint.textContent = isRegister ? '至少 8 个字符' : '';
    }
    const modal = form.closest('.modal') || document;
    modal.querySelectorAll('.auth-tab').forEach((tab) => {
      const active = tab.dataset.mode === mode;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    clearFormError(form);
    const focusTarget = isRegister ? form.querySelector('[name="displayName"]') : form.querySelector('[name="username"]');
    focusTarget?.focus({ preventScroll: true });
  }

  async function submitAuth(form) {
    const mode = form.dataset.mode === 'register' ? 'register' : 'login';
    const submit = form.querySelector('[type="submit"]');
    const values = new FormData(form);
    clearFormError(form);
    setBusy(submit, true, mode === 'register' ? '正在创建…' : '正在登录…');
    try {
      const body =
        mode === 'register'
          ? {
              displayName: String(values.get('displayName') || '').trim(),
              username: String(values.get('username') || '').trim(),
              password: String(values.get('password') || ''),
            }
          : {
              username: String(values.get('username') || '').trim(),
              password: String(values.get('password') || ''),
            };
      const data = await api(`/api/auth/${mode === 'register' ? 'register' : 'login'}`, {
        method: 'POST',
        body,
      });
      await completeAuth(data, mode === 'register' ? '欢迎加入离岛' : `欢迎回来，${data.user.displayName}`);
    } catch (error) {
      showFormError(form, error.message || '登录失败，请稍后再试');
      if (error.status === 401) {
        form.querySelector('[name="password"]')?.focus();
      }
    } finally {
      setBusy(submit, false);
    }
  }

  async function demoLogin(button) {
    setBusy(button, true, '正在进入…');
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: { username: 'linwan', password: 'demo1234' },
      });
      await completeAuth(data, '已进入访客账号：林晚');
    } catch (error) {
      const form = document.getElementById('auth-form');
      if (form) showFormError(form, error.message || '访客账号暂时不可用');
    } finally {
      setBusy(button, false);
    }
  }

  async function completeAuth(data, message) {
    state.me = data.user;
    state.summary = data.summary || { unreadMessages: 0 };
    updateChrome();
    connectSSE();
    closeModal();
    toast(message);
    const pending = state.pendingAction;
    state.pendingAction = null;
    await renderRoute({ keepScroll: true });
    if (pending === 'compose') setTimeout(openCompose, 50);
  }

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST', body: {} });
    } catch {
      // Clear the local state even if the network call failed.
    }
    disconnectSSE();
    state.me = null;
    state.summary = { unreadMessages: 0 };
    updateChrome();
    toast('已经退出登录');
    if (['messages', 'profile'].includes(state.route?.name)) navigate('/', { replace: true });
    else await renderRoute({ keepScroll: true });
  }

  /* ------------------------------------------------------------------------
     Compose modal and drafts
     ------------------------------------------------------------------------ */

  function draftKey() {
    return `${DRAFT_KEY_PREFIX}.${state.me?.id || 'guest'}`;
  }

  function readDraft() {
    try {
      const value = JSON.parse(localStorage.getItem(draftKey()) || 'null');
      return value && typeof value === 'object' ? value : null;
    } catch {
      return null;
    }
  }

  function saveDraft(form) {
    try {
      const values = new FormData(form);
      const draft = {
        title: String(values.get('title') || ''),
        content: String(values.get('content') || ''),
        categoryId: String(values.get('categoryId') || ''),
      };
      if (draft.title || draft.content) localStorage.setItem(draftKey(), JSON.stringify(draft));
    } catch {
      // Storage may be unavailable in private mode.
    }
  }

  function clearDraft() {
    try {
      localStorage.removeItem(draftKey());
    } catch {
      // Ignore.
    }
  }

  async function openCompose() {
    if (!ensureAuth()) {
      state.pendingAction = 'compose';
      return;
    }
    await loadCategories();
    if (!state.categories.length) {
      toast('板块信息加载失败，请稍后再试', { type: 'error' });
      return;
    }
    const draft = readDraft();
    const route = state.route;
    const routeCategory = route?.name === 'category' ? state.categories.find((item) => item.slug === route.categorySlug) : null;
    const defaultCategory = state.categories.find((item) => item.slug === 'general') || state.categories[0];
    const selectedCategory = draft?.categoryId || routeCategory?.id || defaultCategory.id;
    const options = state.categories
      .map((category) => `<option value="${escapeHtml(category.id)}"${category.id === selectedCategory ? ' selected' : ''}>${escapeHtml(category.name)} — ${escapeHtml(category.description)}</option>`)
      .join('');

    openModal(
      `
      <button class="modal-close" type="button" data-action="close-modal" aria-label="关闭">${icon('close')}</button>
      <div class="modal-eyebrow">NEW TOPIC</div>
      <h2 id="compose-title">写下此刻</h2>
      <p class="modal-subtitle">不必完整，先开个头。发布后会出现在广场，也会有人认真读完。</p>
      <div class="compose-intro">${avatar(state.me, 'sm')}<span>以 <strong>${escapeHtml(state.me.displayName)}</strong> 的身份发布</span></div>
      <form id="compose-form" class="form-grid" novalidate>
        <div class="field">
          <label class="field-label" for="compose-category">选择板块</label>
          <select class="select" id="compose-category" name="categoryId">${options}</select>
        </div>
        <div class="field">
          <label class="field-label" for="compose-topic-title">标题 <small><span data-compose-count="title">0</span> / 80</small></label>
          <input class="input" id="compose-topic-title" name="title" type="text" maxlength="80" autocomplete="off" placeholder="一句话，让人想点进来">
        </div>
        <div class="field">
          <label class="field-label" for="compose-content">正文 <small><span data-compose-count="content">0</span> / 12000</small></label>
          <textarea class="textarea" id="compose-content" name="content" maxlength="12000" placeholder="发生了什么？你在想什么？越具体越好。"></textarea>
        </div>
        <p class="form-error" id="compose-error" hidden></p>
        <div class="form-actions">
          <button class="btn btn-ghost" type="button" data-action="close-modal">取消</button>
          <button class="btn btn-primary" type="submit">${icon('send')}发布话题</button>
        </div>
      </form>
      `,
      { wide: true, label: 'compose-title' },
    );

    const form = document.getElementById('compose-form');
    if (draft) {
      form.elements.title.value = draft.title || '';
      form.elements.content.value = draft.content || '';
      if (draft.categoryId && state.categories.some((category) => category.id === draft.categoryId)) {
        form.elements.categoryId.value = draft.categoryId;
      }
      if (draft.title || draft.content) {
        toast('已恢复上次未发布的草稿', { iconName: 'edit' });
      }
    }
    updateComposeCounts(form);
    setTimeout(() => form.elements.title.focus({ preventScroll: true }), 120);
  }

  function updateComposeCounts(form) {
    const title = form.elements.title?.value || '';
    const content = form.elements.content?.value || '';
    const titleCount = form.querySelector('[data-compose-count="title"]');
    const contentCount = form.querySelector('[data-compose-count="content"]');
    if (titleCount) titleCount.textContent = String(Array.from(title).length);
    if (contentCount) contentCount.textContent = String(Array.from(content).length);
  }

  async function submitCompose(form) {
    const submit = form.querySelector('[type="submit"]');
    const values = new FormData(form);
    const title = String(values.get('title') || '').trim();
    const content = String(values.get('content') || '').trim();
    const categoryId = String(values.get('categoryId') || '');
    clearFormError(form);
    if (Array.from(title).length < 4) {
      showFormError(form, '标题至少需要 4 个字符');
      form.elements.title.focus();
      return;
    }
    if (Array.from(content).length < 4) {
      showFormError(form, '正文至少需要 4 个字符');
      form.elements.content.focus();
      return;
    }
    setBusy(submit, true, '正在发布…');
    try {
      const data = await api('/api/topics', {
        method: 'POST',
        body: { categoryId, title, content },
      });
      clearDraft();
      closeModal();
      toast('话题已发布');
      navigate(`/t/${data.topic.id}`);
    } catch (error) {
      if (error.status === 401) {
        state.me = null;
        updateChrome();
        closeModal();
        openAuth('login');
        state.pendingAction = 'compose';
        return;
      }
      showFormError(form, error.message || '发布失败，请稍后再试');
    } finally {
      setBusy(submit, false);
    }
  }

  /* ------------------------------------------------------------------------
     User picker
     ------------------------------------------------------------------------ */

  function openUserPicker() {
    if (!ensureAuth()) return;
    openModal(
      `
      <button class="modal-close" type="button" data-action="close-modal" aria-label="关闭">${icon('close')}</button>
      <div class="modal-eyebrow">NEW MESSAGE</div>
      <h2 id="picker-title">发起一段对话</h2>
      <p class="modal-subtitle">找到想聊的人，直接说你好。不需要先互相关注。</p>
      <label class="picker-search">
        ${icon('search')}
        <input type="search" id="picker-search" placeholder="搜索昵称或用户名" autocomplete="off" aria-label="搜索用户">
      </label>
      <div class="user-picker-list" id="picker-list">
        <div class="conversation-empty">正在找这里的人…</div>
      </div>
      `,
      { label: 'picker-title' },
    );
    loadPickerUsers('');
    setTimeout(() => document.getElementById('picker-search')?.focus({ preventScroll: true }), 120);
  }

  async function loadPickerUsers(query) {
    const list = document.getElementById('picker-list');
    if (!list) return;
    const token = ++state.pickerToken;
    try {
      const data = await api(`/api/users?q=${encodeURIComponent(query || '')}`);
      if (token !== state.pickerToken || !document.getElementById('picker-list')) return;
      const users = data.users || [];
      if (!users.length) {
        list.innerHTML = `<div class="conversation-empty">没有找到这个人。</div>`;
        return;
      }
      list.innerHTML = users
        .map(
          (user) => `
        <button class="user-picker-item" type="button" data-action="start-conversation" data-user-id="${escapeHtml(user.id)}">
          ${avatar(user, 'md')}
          <span class="user-picker-text">
            <strong>${escapeHtml(user.displayName)}${user.isAdmin ? '<span class="admin-mark">管理员</span>' : ''}</strong>
            <span>@${escapeHtml(user.username)} · ${escapeHtml(truncate(user.bio || '还没有自我介绍', 36))}</span>
          </span>
          ${icon('message')}
        </button>`,
        )
        .join('');
    } catch (error) {
      if (token === state.pickerToken) {
        list.innerHTML = `<div class="conversation-empty">${escapeHtml(error.message || '加载失败')}</div>`;
      }
    }
  }

  async function startConversation(button) {
    if (!ensureAuth()) return;
    const userId = button.dataset.userId;
    if (!userId) return;
    button.disabled = true;
    try {
      const data = await api('/api/conversations', { method: 'POST', body: { userId } });
      closeModal();
      navigate(`/messages/${data.conversation.id}`);
    } catch (error) {
      button.disabled = false;
      toast(error.message || '暂时无法发起私信', { type: 'error' });
    }
  }

  /* ------------------------------------------------------------------------
     Admin actions
     ------------------------------------------------------------------------ */

  function openDeleteTopicModal(button) {
    if (!state.me?.isAdmin) {
      toast('只有管理员可以删除帖子', { type: 'error' });
      return;
    }
    const topicId = button.dataset.topicId;
    const topicTitle = button.dataset.topicTitle || '这个话题';
    const returnUrl = button.dataset.returnUrl || '/';
    openModal(
      `
      <button class="modal-close" type="button" data-action="close-modal" aria-label="关闭">${icon('close')}</button>
      <div class="modal-eyebrow">ADMIN ACTION</div>
      <h2 id="delete-topic-title">删除这个话题？</h2>
      <p class="modal-subtitle">《${escapeHtml(topicTitle)}》以及它下面的全部回应会被永久删除，无法恢复。</p>
      <div class="delete-warning">${icon('trash')}<span>这是管理员操作，删除后会立即从广场和搜索结果中消失。</span></div>
      <p class="form-error" id="delete-error" hidden></p>
      <div class="form-actions">
        <button class="btn btn-ghost" type="button" data-action="close-modal">取消</button>
        <button class="btn btn-danger" type="button" data-action="confirm-delete-topic" data-topic-id="${escapeHtml(topicId)}" data-return-url="${escapeHtml(returnUrl)}">${icon('trash')}确认删除</button>
      </div>
      `,
      { label: 'delete-topic-title' },
    );
  }

  async function confirmDeleteTopic(button) {
    if (!state.me?.isAdmin) {
      toast('只有管理员可以删除帖子', { type: 'error' });
      return;
    }
    const topicId = button.dataset.topicId;
    const returnUrl = button.dataset.returnUrl || '/';
    const errorBox = document.getElementById('delete-error');
    setBusy(button, true, '正在删除…');
    try {
      await api(`/api/topics/${encodeURIComponent(topicId)}/delete`, { method: 'POST', body: {} });
      closeModal();
      toast('帖子已删除');
      navigate(returnUrl);
    } catch (error) {
      if (error.status === 401) {
        state.me = null;
        state.summary = { unreadMessages: 0 };
        updateChrome();
        closeModal();
        openAuth('login');
        return;
      }
      if (errorBox) {
        errorBox.textContent = error.message || '删除失败，请稍后再试';
        errorBox.hidden = false;
      } else {
        toast(error.message || '删除失败，请稍后再试', { type: 'error' });
      }
    } finally {
      if (button.isConnected) setBusy(button, false);
    }
  }

  /* ------------------------------------------------------------------------
     Interactions
     ------------------------------------------------------------------------ */

  async function handleLike(button, type) {
    if (!ensureAuth()) return;
    if (button.dataset.busy === '1') return;
    button.dataset.busy = '1';
    try {
      const id = button.dataset.likeId;
      const data = await api(`/api/${type === 'topic' ? 'topics' : 'replies'}/${encodeURIComponent(id)}/like`, {
        method: 'POST',
        body: {},
      });
      button.classList.toggle('is-liked', Boolean(data.liked));
      button.setAttribute('aria-pressed', String(Boolean(data.liked)));
      const count = button.querySelector('[data-like-count]');
      if (count) count.textContent = formatCount(data.likeCount);
    } catch (error) {
      if (error.status === 401) {
        state.me = null;
        updateChrome();
        openAuth('login');
      } else {
        toast(error.message || '操作失败，请稍后再试', { type: 'error' });
      }
    } finally {
      delete button.dataset.busy;
    }
  }

  async function messageUser(button) {
    if (!ensureAuth()) return;
    const userId = button.dataset.userId;
    if (!userId) return;
    setBusy(button, true, '正在打开…');
    try {
      const data = await api('/api/conversations', { method: 'POST', body: { userId } });
      closeModal();
      navigate(`/messages/${data.conversation.id}`);
    } catch (error) {
      if (error.status === 401) {
        state.me = null;
        updateChrome();
        openAuth('login');
      } else {
        toast(error.message || '暂时无法发起私信', { type: 'error' });
      }
    } finally {
      if (button.isConnected) setBusy(button, false);
    }
  }

  async function copyCurrentLink() {
    const url = location.href;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
      } else {
        throw new Error('fallback');
      }
      toast('链接已复制');
    } catch {
      try {
        const input = document.createElement('textarea');
        input.value = url;
        input.setAttribute('readonly', '');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        input.remove();
        toast('链接已复制');
      } catch {
        toast('复制失败，请手动复制地址栏链接', { type: 'error' });
      }
    }
  }

  async function submitReply(form) {
    if (!ensureAuth()) return;
    const submit = form.querySelector('[type="submit"]');
    const textarea = form.querySelector('textarea');
    const content = textarea.value.trim();
    clearFormError(form);
    if (!content) {
      showFormError(form, '写点什么再发布吧');
      textarea.focus();
      return;
    }
    setBusy(submit, true, '正在发布…');
    try {
      const data = await api(`/api/topics/${encodeURIComponent(form.dataset.topicId)}/replies`, {
        method: 'POST',
        body: { content },
      });
      const list = document.getElementById('reply-list');
      const empty = document.getElementById('reply-empty');
      if (empty) empty.remove();
      if (list) {
        const index = list.querySelectorAll('.reply-card').length;
        list.insertAdjacentHTML('beforeend', renderReplyCard(data.reply, index));
        const card = list.lastElementChild;
        card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      document.querySelectorAll('[data-reply-count]').forEach((el) => {
        const current = Number(String(el.textContent).replace(/[^\d]/g, '')) || 0;
        el.textContent = formatNumber(current + 1);
      });
      textarea.value = '';
      toast('回应已发布');
    } catch (error) {
      if (error.status === 401) {
        state.me = null;
        updateChrome();
        openAuth('login');
      } else {
        showFormError(form, error.message || '发布失败，请稍后再试');
      }
    } finally {
      setBusy(submit, false);
    }
  }

  async function submitChat(form) {
    if (!ensureAuth()) return;
    const textarea = form.querySelector('textarea');
    const send = form.querySelector('[type="submit"]');
    const content = textarea.value.trim();
    clearFormError(form);
    if (!content) return;
    send.disabled = true;
    try {
      const data = await api(`/api/conversations/${encodeURIComponent(form.dataset.conversationId)}/messages`, {
        method: 'POST',
        body: { content },
      });
      textarea.value = '';
      resizeTextarea(textarea);
      const counter = document.querySelector('[data-chat-count]');
      if (counter) counter.textContent = '0 / 2000';
      appendMessage({ ...data.message, mine: true }, state.activeOther);
      updateConversationPreview(form.dataset.conversationId, content);
      textarea.focus({ preventScroll: true });
    } catch (error) {
      if (error.status === 401) {
        state.me = null;
        updateChrome();
        openAuth('login');
      } else {
        showFormError(form, error.message || '发送失败，请稍后再试');
      }
    } finally {
      send.disabled = false;
    }
  }

  /* ------------------------------------------------------------------------
     SSE
     ------------------------------------------------------------------------ */

  function connectSSE() {
    if (!state.me) return;
    disconnectSSE();
    try {
      const source = new EventSource('/api/events');
      source.addEventListener('message:new', (event) => {
        try {
          handleIncomingMessage(JSON.parse(event.data));
        } catch {
          // Ignore malformed events.
        }
      });
      source.addEventListener('error', () => {
        // EventSource reconnects on its own; keep the interface quiet.
      });
      state.eventSource = source;
    } catch {
      state.eventSource = null;
    }
  }

  function disconnectSSE() {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
  }

  /* ------------------------------------------------------------------------
     Modal management
     ------------------------------------------------------------------------ */

  function openModal(html, { wide = false, label = '' } = {}) {
    if (state.modalCloseTimer) {
      clearTimeout(state.modalCloseTimer);
      state.modalCloseTimer = null;
    }
    if (state.modalKeyHandler) {
      document.removeEventListener('keydown', state.modalKeyHandler);
      state.modalKeyHandler = null;
    }
    state.lastFocused = document.activeElement;
    modalRoot.innerHTML = `
      <div class="modal-backdrop" data-modal-backdrop="true">
        <div class="modal${wide ? ' modal-wide' : ''}" role="dialog" aria-modal="true"${label ? ` aria-labelledby="${label}"` : ''}>
          ${html}
        </div>
      </div>
    `;
    const backdrop = modalRoot.querySelector('.modal-backdrop');
    const modal = modalRoot.querySelector('.modal');
    document.body.classList.add('modal-open');
    requestAnimationFrame(() => backdrop?.classList.add('is-open'));

    state.modalKeyHandler = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeModal();
        return;
      }
      if (event.key !== 'Tab' || !modal) return;
      const focusable = Array.from(
        modal.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', state.modalKeyHandler);
  }

  function closeModal() {
    const backdrop = modalRoot.querySelector('.modal-backdrop');
    if (!backdrop) return;
    backdrop.classList.remove('is-open');
    document.body.classList.remove('modal-open');
    if (state.modalKeyHandler) {
      document.removeEventListener('keydown', state.modalKeyHandler);
      state.modalKeyHandler = null;
    }
    const previous = state.lastFocused;
    if (previous && typeof previous.focus === 'function') {
      try {
        previous.focus({ preventScroll: true });
      } catch {
        // The trigger may no longer be in the document.
      }
    }
    state.lastFocused = null;
    if (state.modalCloseTimer) clearTimeout(state.modalCloseTimer);
    state.modalCloseTimer = setTimeout(() => {
      modalRoot.innerHTML = '';
      state.modalCloseTimer = null;
    }, 190);
  }

  /* ------------------------------------------------------------------------
     Toasts and helpers
     ------------------------------------------------------------------------ */

  function toast(message, { type = 'success', iconName = 'check', duration = 3400 } = {}) {
    const element = document.createElement('div');
    element.className = `toast${type === 'error' ? ' is-error' : ''}`;
    element.innerHTML = `${icon(type === 'error' ? 'help' : iconName)}<span>${escapeHtml(message)}</span>`;
    toastRoot.appendChild(element);
    while (toastRoot.children.length > 4) toastRoot.firstElementChild?.remove();
    const remove = () => {
      if (!element.isConnected) return;
      element.classList.add('is-leaving');
      setTimeout(() => element.remove(), 220);
    };
    const timer = setTimeout(remove, duration);
    element.addEventListener('click', () => {
      clearTimeout(timer);
      remove();
    });
  }

  function setBusy(element, busy, text = '') {
    if (!element) return;
    if (busy) {
      if (!element.dataset.idleHtml) element.dataset.idleHtml = element.innerHTML;
      element.disabled = true;
      element.setAttribute('aria-busy', 'true');
      element.innerHTML = `<span class="spinner"></span>${text ? `<span>${escapeHtml(text)}</span>` : ''}`;
    } else {
      element.disabled = false;
      element.removeAttribute('aria-busy');
      if (element.dataset.idleHtml) {
        element.innerHTML = element.dataset.idleHtml;
        delete element.dataset.idleHtml;
      }
    }
  }

  function showFormError(form, message) {
    const error = form?.querySelector('.form-error');
    if (!error) {
      toast(message, { type: 'error' });
      return;
    }
    error.textContent = message;
    error.hidden = false;
  }

  function clearFormError(form) {
    const error = form?.querySelector('.form-error');
    if (!error) return;
    error.hidden = true;
    error.textContent = '';
  }

  function resizeTextarea(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 130)}px`;
  }

  /* ------------------------------------------------------------------------
     Theme
     ------------------------------------------------------------------------ */

  function readTheme() {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === 'light' || stored === 'dark') return stored;
    } catch {
      // Ignore.
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    const safeTheme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = safeTheme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = safeTheme === 'dark' ? '#0b0b0b' : '#f2f2f2';
    const toggle = document.querySelector('.theme-toggle');
    if (toggle) {
      toggle.setAttribute('aria-label', safeTheme === 'dark' ? '切换到浅色模式' : '切换到深色模式');
      toggle.title = safeTheme === 'dark' ? '切换到浅色模式' : '切换到深色模式';
    }
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Ignore.
    }
  }

  /* ------------------------------------------------------------------------
     PWA install
     ------------------------------------------------------------------------ */

  function isStandalone() {
    return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  }

  function updateInstallUI() {
    const standalone = isStandalone();
    const headerButton = document.querySelector('.install-button');
    if (headerButton) headerButton.hidden = !state.installPrompt || standalone;
    document.querySelectorAll('[data-install-card]').forEach((element) => {
      element.hidden = standalone;
    });
  }

  async function promptInstall() {
    if (!state.installPrompt) {
      toast('在浏览器菜单中选择「安装到主屏幕」或「添加到主屏幕」即可');
      return;
    }
    const promptEvent = state.installPrompt;
    state.installPrompt = null;
    updateInstallUI();
    promptEvent.prompt();
    try {
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === 'accepted') toast('正在把离岛装进口袋');
    } catch {
      // Ignore a dismissed prompt.
    }
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Offline support is a progressive enhancement.
    });
  }

  /* ------------------------------------------------------------------------
     Global event wiring
     ------------------------------------------------------------------------ */

  function bindEvents() {
    document.addEventListener('click', (event) => {
      if (event.defaultPrevented) return;

      if (event.target.closest('[data-modal-backdrop]') === event.target) {
        closeModal();
        return;
      }

      const link = event.target.closest('a[data-link]');
      if (link) {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const href = link.getAttribute('href');
        if (!href || href.startsWith('#') || link.target === '_blank') return;
        event.preventDefault();
        navigate(href);
        return;
      }

      if (!event.target.closest('.user-menu-wrap')) closeUserMenu();

      const actionElement = event.target.closest('[data-action]');
      if (!actionElement) return;
      const action = actionElement.dataset.action;
      if (action === 'modal-backdrop') {
        closeModal();
        return;
      }
      if (action !== 'toggle-user-menu') closeUserMenu();

      Promise.resolve(handleAction(action, actionElement, event)).catch((error) => {
        console.error(error);
        toast(error.message || '操作失败', { type: 'error' });
      });
    });

    document.addEventListener('submit', (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      if (form.id === 'header-search') {
        event.preventDefault();
        const query = String(new FormData(form).get('q') || '').trim();
        navigate(searchUrl(query));
        form.reset();
        return;
      }
      if (form.id === 'search-page-form') {
        event.preventDefault();
        const query = String(new FormData(form).get('q') || '').trim();
        navigate(searchUrl(query));
        return;
      }
      if (form.id === 'auth-form') {
        event.preventDefault();
        submitAuth(form);
        return;
      }
      if (form.id === 'compose-form') {
        event.preventDefault();
        submitCompose(form);
        return;
      }
      if (form.id === 'reply-form') {
        event.preventDefault();
        submitReply(form);
        return;
      }
      if (form.id === 'chat-form') {
        event.preventDefault();
        submitChat(form);
      }
    });

    document.addEventListener('input', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      if (target.closest('#compose-form')) {
        const form = target.closest('#compose-form');
        updateComposeCounts(form);
        if (state.draftTimer) clearTimeout(state.draftTimer);
        state.draftTimer = setTimeout(() => saveDraft(form), 450);
      }

      if (target.matches('[data-chat-input]')) {
        resizeTextarea(target);
        const counter = document.querySelector('[data-chat-count]');
        if (counter) counter.textContent = `${Array.from(target.value).length} / 2000`;
      }

      if (target.id === 'conversation-filter') {
        applyConversationFilter(target.value);
      }

      if (target.id === 'picker-search') {
        if (state.pickerTimer) clearTimeout(state.pickerTimer);
        state.pickerTimer = setTimeout(() => loadPickerUsers(target.value.trim()), 260);
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeUserMenu();
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.matches('[data-chat-input]') && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        target.closest('form')?.requestSubmit();
      }
      if (target.closest('#compose-form') && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        target.closest('form')?.requestSubmit();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !state.me) return;
      if (state.route?.name === 'messages' && state.route.conversationId) {
        markConversationRead(state.route.conversationId);
      }
    });

    window.addEventListener('popstate', () => {
      if (modalRoot.querySelector('.modal-backdrop')) closeModal();
      renderRoute();
    });

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      state.installPrompt = event;
      updateInstallUI();
    });

    window.addEventListener('appinstalled', () => {
      state.installPrompt = null;
      updateInstallUI();
      toast('离岛已添加到你的设备');
    });

    window.addEventListener('offline', () => toast('网络好像断开了，请检查连接', { type: 'error' }));
    window.addEventListener('online', () => toast('网络已恢复'));
  }

  async function handleAction(action, element) {
    switch (action) {
      case 'toggle-theme':
        toggleTheme();
        break;
      case 'install':
        await promptInstall();
        break;
      case 'open-auth':
        state.pendingAction = element.dataset.pending || null;
        openAuth(element.dataset.mode || 'login');
        break;
      case 'toggle-user-menu':
        toggleUserMenu();
        break;
      case 'logout':
        await logout();
        break;
      case 'compose':
        await openCompose();
        break;
      case 'my-profile':
        if (!ensureAuth()) return;
        navigate(`/u/${state.me.id}`);
        break;
      case 'close-modal':
        closeModal();
        break;
      case 'auth-tab':
        switchAuthMode(element.dataset.mode);
        break;
      case 'demo-login':
        await demoLogin(element);
        break;
      case 'like-topic':
        await handleLike(element, 'topic');
        break;
      case 'like-reply':
        await handleLike(element, 'reply');
        break;
      case 'message-user':
        await messageUser(element);
        break;
      case 'copy-link':
        await copyCurrentLink();
        break;
      case 'delete-topic':
        openDeleteTopicModal(element);
        break;
      case 'confirm-delete-topic':
        await confirmDeleteTopic(element);
        break;
      case 'open-picker':
        openUserPicker();
        break;
      case 'start-conversation':
        await startConversation(element);
        break;
      case 'search-tag':
        navigate(searchUrl(element.dataset.query));
        break;
      case 'retry':
        await renderRoute({ keepScroll: true });
        break;
      default:
        break;
    }
  }
})();

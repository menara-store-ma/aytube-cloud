/**
 * AYTube v3 Client
 * Custom HTML5 player, real YouTube data/comments, on-demand caption translation,
 * Google-style local account chooser and optional real Google OAuth.
 */
'use strict';

/* ============================================================
 * Helpers
 * ============================================================ */
const $ = (id) => document.getElementById(id);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function escapeHtml(value) {
  const str = String(value == null ? '' : value);
  return str.replace(/[&<>'"]/g, (tag) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}

function getFallbackAvatar(name) {
  const clean = String(name || 'Y').trim() || 'Y';
  const initial = clean.charAt(0).toUpperCase();
  const colors = [
    '#e53935', '#d81b60', '#8e24aa', '#5e35b1',
    '#3949ab', '#1e88e5', '#039be5', '#00acc1',
    '#00897b', '#43a047', '#fb8c00', '#f4511e'
  ];
  let hash = 0;
  for (let i = 0; i < clean.length; i += 1) {
    hash = clean.charCodeAt(i) + ((hash << 5) - hash);
  }
  const color = colors[Math.abs(hash) % colors.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><circle cx="48" cy="48" r="48" fill="${color}"/><text x="50%" y="55%" font-family="Arial,Cairo,sans-serif" font-size="42" font-weight="bold" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${escapeHtml(initial)}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function avatarSource(name, picture) {
  if (picture && /^https?:\/\//i.test(picture)) return picture;
  return getFallbackAvatar(name || 'U');
}

function initialOf(name) {
  return (String(name || 'U').trim().charAt(0) || 'U').toUpperCase();
}

function compactNumber(value) {
  const num = Number(value) || 0;
  const format = (n) => {
    const rounded = n >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
    return String(rounded).replace(/\.0$/, '');
  };
  if (num >= 1e9) return `${format(num / 1e9)} مليار`;
  if (num >= 1e6) return `${format(num / 1e6)} مليون`;
  if (num >= 1e3) return `${format(num / 1e3)} ألف`;
  return String(num);
}

function formatViews(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string' && !/^\d+$/.test(value.replace(/,/g, ''))) return value;
  const num = Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(num)) return String(value);
  return `${compactNumber(num)} مشاهدة`;
}

function formatDuration(value) {
  if (typeof value === 'string') return value;
  let total = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(total / 3600);
  total %= 3600;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatWatchDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  try {
    return date.toLocaleDateString('ar-MA', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return date.toLocaleDateString();
  }
}

function parseHumanNumber(text) {
  if (text == null) return 0;
  let cleaned = String(text)
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/,/g, '')
    .trim();
  if (!cleaned) return 0;
  const match = cleaned.match(/([\d.]+)\s*(ألف|مليون|مليار|K|M|B)?/i);
  if (!match) return 0;
  const base = Number(match[1]) || 0;
  const suffix = (match[2] || '').toLowerCase();
  if (suffix === 'k' || suffix === 'ألف') return Math.round(base * 1e3);
  if (suffix === 'm' || suffix === 'مليون') return Math.round(base * 1e6);
  if (suffix === 'b' || suffix === 'مليار') return Math.round(base * 1e9);
  return Math.round(base);
}

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function debounce(fn, delay = 220) {
  let timer = null;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

let globalToastTimer = null;
function showToast(message, duration = 2600) {
  if (!message) return;
  let toast = $('ayGlobalToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'ayGlobalToast';
    toast.className = 'ay-global-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(globalToastTimer);
  globalToastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

function extractVideoId(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(text)) return text;
  const match = text.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName ? target.tagName.toLowerCase() : '';
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

function setHidden(element, hidden) {
  if (!element) return;
  element.style.display = hidden ? 'none' : '';
}

function showModal(element) {
  if (element) element.classList.add('active');
}

function hideModal(element) {
  if (element) element.classList.remove('active');
}

/* ============================================================
 * State
 * ============================================================ */
const DEFAULT_QUERY = 'الكل';
const APP_VERSION = '3.0.0';

const savedAccounts = readJSON('ay_google_accounts', []);
const accounts = Array.isArray(savedAccounts)
  ? savedAccounts.filter((account) => account && account.email).map((account) => ({
    id: account.id || String(account.email).toLowerCase(),
    name: account.name || String(account.email).split('@')[0],
    email: account.email,
    picture: account.picture || '',
    provider: account.provider || 'local'
  }))
  : [];

const savedUser = readJSON('ay_google_user', null);
let currentUser = savedUser && savedUser.email ? {
  id: savedUser.id || String(savedUser.email).toLowerCase(),
  name: savedUser.name || String(savedUser.email).split('@')[0],
  email: savedUser.email,
  picture: savedUser.picture || '',
  provider: savedUser.provider || 'local'
} : null;

if (currentUser && !accounts.some((account) => account.email === currentUser.email)) {
  accounts.unshift({ ...currentUser });
}

const rawLikes = readJSON('pb_likes', {});
const likes = {};
if (Array.isArray(rawLikes)) {
  rawLikes.forEach((id) => { if (id) likes[id] = 'like'; });
} else if (rawLikes && typeof rawLikes === 'object') {
  Object.entries(rawLikes).forEach(([id, value]) => {
    if (value === 'like' || value === 'dislike') likes[id] = value;
  });
}

const historyItems = readJSON('pb_history', []);
const favoriteItems = readJSON('pb_favorites', []);
const localComments = readJSON('ay_local_comments', {});
const cachedFeed = readJSON('ay_cached_feed', []);

const state = {
  isPro: !!localStorage.getItem('ay_pro_token'),
  proToken: localStorage.getItem('ay_pro_token') || '',
  proPendingAction: null,
  theme: localStorage.getItem('pb_theme') === 'light' ? 'light' : 'dark',
  desktop: localStorage.getItem('pb_desktop') === 'true',
  volume: clamp(Number(localStorage.getItem('pb_volume') || 1), 0, 1),
  muted: localStorage.getItem('pb_muted') === 'true',
  autoplay: localStorage.getItem('pb_autoplay') !== 'false',
  prefQuality: localStorage.getItem('pb_pref_quality') || 'auto',
  accounts,
  currentUser,
  authConfig: { googleOAuth: false, provider: 'local' },
  authMode: 'register',
  wantsAuthAfterLogin: false,
  subscriptions: Array.isArray(readJSON('pb_subs', []))
    ? readJSON('pb_subs', []).map((entry) => (
      typeof entry === 'string'
        ? { channelId: '', channelName: entry, channelAvatar: '' }
        : { channelId: entry?.channelId || '', channelName: entry?.channelName || entry?.name || '', channelAvatar: entry?.channelAvatar || '' }
    )).filter((entry) => entry.channelName || entry.channelId)
    : [],
  videoState: {},
  communityComments: [],
  communityCommentsLoadedFor: null,
  communityCommentsRequestId: 0,
  replyTarget: null,
  expandedCommentThreads: new Set(),
  likes,
  history: Array.isArray(historyItems) ? historyItems.filter((v) => v && v.id) : [],
  favorites: Array.isArray(favoriteItems) ? favoriteItems.filter((v) => v && v.id) : [],
  localComments: localComments && typeof localComments === 'object' ? localComments : {},
  cachedFeed: Array.isArray(cachedFeed) ? cachedFeed.filter((v) => v && v.id) : [],
  currentQuery: DEFAULT_QUERY,
  activeChip: 'الكل',
  activeVideo: null,
  playerData: null,
  playerRequestId: 0,
  playerAbort: null,
  qualities: [],
  selectedQualityItag: null,
  autoQuality: true,
  duration: 0,
  isPlaying: false,
  isLooping: false,
  speed: 1,
  captions: { cues: [], active: false, key: '', name: '', mode: '' },
  captionAbort: null,
  captionsLoading: false,
  comments: [],
  commentsCursor: null,
  commentsSort: 'top',
  commentsAvailable: false,
  commentsLoading: false,
  commentsLoadedFor: null,
  isFloating: false,
  allowExternalPip: false,
  isBackground: false,
  wasPlayingBeforeBackground: false,
  shellHome: null,
  sleepTimerId: null,
  sleepMinutes: 0,
  theater: false,
  controlsHideTimer: null,
  captionLookupCache: { cues: null, index: 0 },
  suggestedIndex: -1,
  suggestionItems: [],
  pendingQualityTime: 0,
  pendingQualityPlay: false,
  playerLoadToken: 0,
  lastCommentInputWasGated: false,
  commentSubmitting: false
};

/* ============================================================
 * DOM references
 * ============================================================ */
const el = {
  // Header
  brandHome: $('brandHome'),
  searchInput: $('searchInput'),
  searchBtn: $('searchBtn'),
  clearSearchBtn: $('clearSearchBtn'),
  autocompleteList: $('autocompleteList'),
  toggleThemeBtn: $('toggleThemeBtn'),
  openSettingsBtn: $('openSettingsBtn'),
  openAuthModalBtn: $('openAuthModalBtn'),
  chipsBar: $('chipsBar'),
  accountArea: $('accountArea'),

  // Profile dropdown
  profileMenu: $('profileMenu'),
  profileMenuAvatar: $('profileMenuAvatar'),
  profileMenuName: $('profileMenuName'),
  profileMenuEmail: $('profileMenuEmail'),
  profileSwitchBtn: $('profileSwitchBtn'),
  profileMyVideosBtn: $('profileMyVideosBtn'),
  profileHistoryBtn: $('profileHistoryBtn'),
  profileSignOutBtn: $('profileSignOutBtn'),

  // Feed
  feedView: $('feedView'),
  videosContainer: $('videosContainer'),

  // Watch view
  watchView: $('watchView'),
  watchLayout: document.querySelector('.watch-layout'),
  watchTitle: $('watchTitle'),
  watchViews: $('watchViews'),
  watchDate: $('watchDate'),
  watchCategory: $('watchCategory'),
  watchChannelAvatar: $('watchChannelAvatar'),
  watchChannel: $('watchChannel'),
  watchChannelAvatar: $('watchChannelAvatar'),
  watchSubs: $('watchSubs'),
  subBtn: $('subBtn'),
  likeBtn: $('likeBtn'),
  dislikeBtn: $('dislikeBtn'),
  likeCount: $('likeCount'),
  quickShareBtn: $('quickShareBtn'),
  quickDownloadBtn: $('quickDownloadBtn'),
  theaterBtn: $('theaterBtn'),
  watchDescriptionBox: $('watchDescriptionBox'),
  descStats: $('descStats'),
  watchDescription: $('watchDescription'),
  descToggleBtn: $('descToggleBtn'),
  relatedList: $('relatedList'),

  // Player
  playerShell: $('playerShell'),
  videoEl: $('videoEl'),
  audioEl: $('audioEl'),
  playerPoster: $('playerPoster'),
  playerLoading: $('playerLoading'),
  playerError: $('playerError'),
  playerErrorTitle: $('playerErrorTitle'),
  playerErrorSub: $('playerErrorSub'),
  playerRetryBtn: $('playerRetryBtn'),
  bigPlayBtn: $('bigPlayBtn'),
  miniFloatBar: $('miniFloatBar'),
  miniFloatTitle: $('miniFloatTitle'),
  miniFloatExpandBtn: $('miniFloatExpandBtn'),
  miniFloatCloseBtn: $('miniFloatCloseBtn'),
  captionsOverlay: $('captionsOverlay'),
  playerToast: $('playerToast'),
  playerControls: $('playerControls'),
  progressWrap: $('progressWrap'),
  seekBar: $('seekBar'),
  seekPreviewBubble: $('seekPreviewBubble'),
  seekPreviewVideo: $('seekPreviewVideo'),
  seekPreviewTime: $('seekPreviewTime'),
  bufferedBar: $('bufferedBar'),
  playPauseBtn: $('playPauseBtn'),
  playPauseSvg: $('playPauseSvg'),
  muteBtn: $('muteBtn'),
  muteSvg: $('muteSvg'),
  volumeBar: $('volumeBar'),
  timeDisplay: $('timeDisplay'),
  ccBtn: $('ccBtn'),
  settingsBtn: $('settingsBtn'),
  pipBtn: $('pipBtn'),
  fullscreenBtn: $('fullscreenBtn'),
  fullscreenSvg: $('fullscreenSvg'),
  ccMenu: $('ccMenu'),
  ccMenuClose: $('ccMenuClose'),
  ccLanguageList: $('ccLanguageList'),
  ccTrackList: $('ccTrackList'),
  ccTrackSectionTitle: $('ccTrackSectionTitle'),
  ccOffBtn: $('ccOffBtn'),
  ccNote: document.querySelector('#ccMenu .cc-note'),
  settingsMenu: $('settingsMenu'),
  settingsMenuClose: $('settingsMenuClose'),
  qualityList: $('qualityList'),
  speedList: $('speedList'),

  // Comments
  commentsSection: $('commentsSection'),
  commentsPreviewCard: $('commentsPreviewCard'),
  commentsPreviewCount: $('commentsPreviewCount'),
  commentsPreviewAvatar: $('commentsPreviewAvatar'),
  commentsPreviewText: $('commentsPreviewText'),
  commentsExpandedPanel: $('commentsExpandedPanel'),
  closeCommentsPanelBtn: $('closeCommentsPanelBtn'),
  commentsCount: $('commentsCount'),
  commentsSortTop: $('commentsSortTop'),
  commentsSortNew: $('commentsSortNew'),
  commentUserAvatar: $('commentUserAvatar'),
  newCommentInput: $('newCommentInput'),
  commentReplyBanner: $('commentReplyBanner'),
  commentReplyText: $('commentReplyText'),
  cancelReplyBtn: $('cancelReplyBtn'),
  commentButtonsRow: $('commentButtonsRow'),
  cancelCommentBtn: $('cancelCommentBtn'),
  submitCommentBtn: $('submitCommentBtn'),
  commentsList: $('commentsList'),
  loadMoreCommentsBtn: $('loadMoreCommentsBtn'),

  // Floating player
  floatingPlayer: $('floatingPlayer'),
  floatingHeader: $('floatingHeader'),
  floatingTitle: $('floatingTitle'),
  floatingVideoContainer: $('floatingVideoContainer'),
  fpExpandBtn: $('fpExpandBtn'),
  fpCloseBtn: $('fpCloseBtn'),

  // Background audio
  bgNotificationBar: $('bgNotificationBar'),
  bgNotifTitle: $('bgNotifTitle'),
  bgReturnBtn: $('bgReturnBtn'),
  bgStopBtn: $('bgStopBtn'),

  // Options
  optHome: $('optHome'),
  optBackground: $('optBackground'),
  optPip: $('optPip'),
  optDesktop: $('optDesktop'),
  desktopModeCheckbox: $('desktopModeCheckbox'),
  optFavorite: $('optFavorite'),
  favStarSvg: $('favStarSvg'),
  favTitleText: $('favTitleText'),
  optShare: $('optShare'),
  optDownload: $('optDownload'),
  optLoop: $('optLoop'),
  loopTitleText: $('loopTitleText'),
  optSleep: $('optSleep'),
  sleepTitleText: $('sleepTitleText'),

  // Share modal
  shareModal: $('shareModal'),
  closeShareModalBtn: $('closeShareModalBtn'),
  shareWhatsappBtn: $('shareWhatsappBtn'),
  shareFacebookBtn: $('shareFacebookBtn'),
  shareTelegramBtn: $('shareTelegramBtn'),
  shareTwitterBtn: $('shareTwitterBtn'),
  shareEmailBtn: $('shareEmailBtn'),
  shareUrlInput: $('shareUrlInput'),
  doCopyLinkBtn: $('doCopyLinkBtn'),
  copySuccessMsg: $('copySuccessMsg'),

  // Download modal
  downloadModal: $('downloadModal'),
  closeDownloadBtn: $('closeDownloadBtn'),
  downloadVideoTitle: $('downloadVideoTitle'),
  downloadAudioBtn: $('downloadAudioBtn'),
  downloadVideoBtn: $('downloadVideoBtn'),
  downloadStatusMsg: $('downloadStatusMsg'),

  // Sleep modal
  sleepModal: $('sleepModal'),
  closeSleepBtn: $('closeSleepBtn'),
  cancelSleepTimerBtn: $('cancelSleepTimerBtn'),
  sleepStatusMsg: $('sleepStatusMsg'),

  // PRO modal & header
  headerProBtn: $('headerProBtn'),
  headerProText: $('headerProText'),
  proModal: $('proModal'),
  closeProModalBtn: $('closeProModalBtn'),
  proModalPrompt: $('proModalPrompt'),
  proCodeInput: $('proCodeInput'),
  proActivateBtn: $('proActivateBtn'),
  proModalStatus: $('proModalStatus'),
  extraOptionsSummary: $('extraOptionsSummary'),

  // Shorts view & controls
  shortsView: $('shortsView'),
  shortsBackBtn: $('shortsBackBtn'),
  shortsCardFrame: $('shortsCardFrame'),
  shortsVideoEl: $('shortsVideoEl'),
  shortsAudioEl: $('shortsAudioEl'),
  shortsPlayBtn: $('shortsPlayBtn'),
  shortsPlaySvg: $('shortsPlaySvg'),
  shortsMuteBtn: $('shortsMuteBtn'),
  shortsMuteSvg: $('shortsMuteSvg'),
  shortsLoading: $('shortsLoading'),
  shortsCenterStatus: $('shortsCenterStatus'),
  appFooter: $('appFooter'),
  shortsChannelAvatar: $('shortsChannelAvatar'),
  shortsChannelName: $('shortsChannelName'),
  shortsSubBtn: $('shortsSubBtn'),
  shortsTitle: $('shortsTitle'),
  shortsProgressFill: $('shortsProgressFill'),
  shortsSeekBar: $('shortsSeekBar'),
  shortsLikeBtn: $('shortsLikeBtn'),
  shortsLikeCount: $('shortsLikeCount'),
  shortsDislikeBtn: $('shortsDislikeBtn'),
  shortsCommentsBtn: $('shortsCommentsBtn'),
  shortsCommentsCount: $('shortsCommentsCount'),
  shortsShareBtn: $('shortsShareBtn'),
  shortsDownloadBtn: $('shortsDownloadBtn'),
  shortsSoundThumbBtn: $('shortsSoundThumbBtn'),
  shortsSoundThumbImg: $('shortsSoundThumbImg'),
  shortsPrevBtn: $('shortsPrevBtn'),
  shortsNextBtn: $('shortsNextBtn'),
  shortsCommentsDrawer: $('shortsCommentsDrawer'),
  shortsCloseDrawerBtn: $('shortsCloseDrawerBtn'),
  shortsDrawerList: $('shortsDrawerList'),

  // Settings modal
  settingsModal: $('settingsModal'),
  closeSettingsBtn: $('closeSettingsBtn'),
  settingThemeBtn: $('settingThemeBtn'),
  settingAutoplayToggle: $('settingAutoplayToggle'),
  settingQualitySelect: $('settingQualitySelect'),
  apkServerSettingsRow: $('apkServerSettingsRow'),
  clearHistoryRow: $('clearHistoryRow'),

  // Auth modal
  googleAuthModal: $('googleAuthModal'),
  gaChooseView: $('gaChooseView'),
  gaFormView: $('gaFormView'),
  googleAccountsList: $('googleAccountsList'),
  gaUseAnotherBtn: $('gaUseAnotherBtn'),
  gaOAuthSection: $('gaOAuthSection'),
  gaRealGoogleBtn: $('gaRealGoogleBtn'),
  gaCreateAccountBtn: $('gaCreateAccountBtn'),
  gaBackToAccountsBtn: $('gaBackToAccountsBtn'),
  gaNameInput: $('gaNameInput'),
  gaNameField: $('gaNameField'),
  gaEmailInput: $('gaEmailInput'),
  gaPasswordInput: $('gaPasswordInput'),
  gaFormError: $('gaFormError'),
  gaAddAccountBtn: $('gaAddAccountBtn'),
  gaModeRegisterBtn: $('gaModeRegisterBtn'),
  gaModeLoginBtn: $('gaModeLoginBtn'),
  closeGoogleAuthBtn: $('closeGoogleAuthBtn'),
  authStatusMsg: $('authStatusMsg')
};

const signedOutAuthMarkup = el.openAuthModalBtn ? el.openAuthModalBtn.innerHTML : '';

/* ============================================================
 * Boot
 * ============================================================ */
async function init() {
  // Auto-detect phone / device dark mode
  const savedTheme = localStorage.getItem('pb_theme');
  if (savedTheme === 'light' || savedTheme === 'dark') {
    applyTheme(savedTheme);
  } else {
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(prefersDark ? 'dark' : 'light');
  }
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem('pb_theme')) {
        applyTheme(e.matches ? 'dark' : 'light');
      }
    });
  }
  if (el.volumeBar) el.volumeBar.value = String(state.volume);
  if (el.settingAutoplayToggle) el.settingAutoplayToggle.checked = state.autoplay;
  if (el.settingQualitySelect) el.settingQualitySelect.value = state.prefQuality;
  if (el.desktopModeCheckbox) el.desktopModeCheckbox.checked = state.desktop;
  state.theater = state.desktop;
  if (el.watchLayout) el.watchLayout.classList.toggle('theater-mode', state.theater);
  updateTheaterButton();
  updateVolumeUI();

  setupAuthUI();
  setupSearch();
  setupChips();
  setupPlayer();
  setupShortsPlayer();
  setupComments();
  setupOptions();
  setupModals();
  setupFloatingPlayer();
  setupBackgroundMode();
  setupKeyboardShortcuts();
  renderAuthState();
  updateProUI();

  // Check server PRO token validity immediately (revokes all devices if master code changed)
  verifyProStatus({ silent: true, force: true });
  window.addEventListener('focus', () => verifyProStatus({ silent: false, force: true }));
  window.addEventListener('online', () => verifyProStatus({ silent: false, force: true }));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) verifyProStatus({ silent: false, force: true });
  });
  setInterval(() => verifyProStatus({ silent: false }), 25000);

  const params = new URLSearchParams(location.search);
  const authStatus = params.get('auth');
  if (authStatus === 'success' || authStatus === 'error') {
    await handleAuthReturn(authStatus).catch(() => {});
  }

  window.handleAndroidBack = () => {
    const openModal = document.querySelector('.modal-overlay.active');
    if (openModal) {
      hideModal(openModal);
      if (openModal === el.proModal) state.proPendingAction = null;
      return true;
    }
    if (shortsState.active) {
      showFeedView({ pause: true });
      pushAppRoute({});
      return true;
    }
    if (el.watchView && el.watchView.style.display !== 'none' && !state.isFloating && !state.isBackground) {
      startFloatingPlayer({ silentToast: true });
      pushAppRoute({});
      return true;
    }
    if (document.querySelector('#feedGrid .ch-page') || (state.currentQuery && state.currentQuery !== DEFAULT_QUERY)) {
      setActiveChip('الكل');
      if (el.searchInput) el.searchInput.value = '';
      updateClearSearchButton();
      loadFeed(DEFAULT_QUERY, { cache: true });
      pushAppRoute({});
      return true;
    }
    return false;
  };

  window.addEventListener('popstate', () => {
    routeFromUrl({ skipPush: true, fromPopstate: true });
  });

  // Start rendering Home / URL route immediately without blocking behind auth checks
  const routePromise = routeFromUrl({ skipPush: true });

  // Sync auth & history in parallel
  Promise.allSettled([loadAuthConfig(), restoreServerSession(true)]).then(() => {
    renderAuthState();
  });

  fetch('/api/history')
    .then(r => r.json())
    .then(d => {
      if (d && d.success && Array.isArray(d.history) && d.history.length) {
        state.history = d.history;
        saveHistory();
      }
    })
    .catch(() => {});

  await routePromise;
}

function pushAppRoute(paramsMap = {}) {
  try {
    const sp = new URLSearchParams();
    Object.entries(paramsMap).forEach(([k, v]) => {
      if (v != null && String(v).trim() !== '') sp.set(k, String(v));
    });
    const qs = sp.toString();
    const targetUrl = qs ? `${location.pathname}?${qs}` : location.pathname;
    const currentUrl = `${location.pathname}${location.search}`;
    if (currentUrl !== targetUrl) {
      history.pushState(paramsMap, '', targetUrl);
    }
  } catch {}
}

async function routeFromUrl(options = {}) {
  const skipPush = !!options.skipPush;
  const params = new URLSearchParams(location.search);

  const shortId = extractVideoId(params.get('shorts') || '');
  const directId = extractVideoId(params.get('v') || '');

  // When pressing Back out of Watch View, keep the active video floating smoothly inside the app instead of cutting off!
  const wasWatching = el.watchView && el.watchView.style.display !== 'none'
    && !state.isBackground && !state.isFloating
    && !!(state.playerData && el.videoEl?.getAttribute('src'));
  if (options.fromPopstate && wasWatching && !directId && !shortId) {
    startFloatingPlayer({ silentToast: true });
  }

  if (shortId) {
    await openShortsView({ id: shortId, title: '', isShort: true }, [], null, { skipPush });
    return;
  }

  if (directId) {
    await openWatchView({ id: directId, title: '' }, { skipPush });
    return;
  }

  const chName = params.get('channel') || '';
  const chId = params.get('cid') || '';
  const chTab = params.get('tab') || 'home';
  if (chName || chId) {
    await openChannelPage(chName, '', chId, chTab, { skipPush });
    return;
  }

  const searchQ = params.get('search') || '';
  if (searchQ) {
    if (el.searchInput) el.searchInput.value = searchQ;
    updateClearSearchButton();
    await performSearch(searchQ, { skipPush });
    return;
  }

  const chipQ = params.get('chip') || '';
  if (chipQ && chipQ !== 'الكل') {
    await handleChip(chipQ, { skipPush });
    return;
  }

  setActiveChip('الكل');
  if (el.searchInput) el.searchInput.value = '';
  updateClearSearchButton();
  const hasWarmFeed = state.cachedFeed.length > 0;
  if (hasWarmFeed) renderVideoFeed(state.cachedFeed);
  await loadFeed('الكل', { cache: true, keepExisting: hasWarmFeed });
}

document.addEventListener('DOMContentLoaded', init);

/* ============================================================
 * Theme + subscription helpers
 * ============================================================ */
function applyTheme(theme) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  document.body.setAttribute('data-theme', state.theme);
  try { localStorage.setItem('pb_theme', state.theme); } catch { /* ignore */ }
  if (el.settingThemeBtn) el.settingThemeBtn.textContent = state.theme === 'dark' ? 'داكن' : 'فاتح';
  if (el.toggleThemeBtn) {
    el.toggleThemeBtn.title = state.theme === 'dark' ? 'التبديل إلى الوضع الفاتح' : 'التبديل إلى الوضع الداكن';
  }
}

function toggleTheme() {
  applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  showToast(state.theme === 'dark' ? 'تم تفعيل الوضع الداكن' : 'تم تفعيل الوضع الفاتح');
}

function saveSubscriptions() {
  writeJSON('pb_subs', state.subscriptions);
}

function isSubscribed(channelName, channelId = '') {
  if (!channelName && !channelId) return false;
  return state.subscriptions.some((entry) => {
    if (channelId && entry.channelId && entry.channelId === channelId) return true;
    return channelName && String(entry.channelName || '').toLowerCase() === String(channelName).toLowerCase();
  });
}

async function refreshUserInteractions() {
  if (!state.currentUser) {
    resetUserInteractions();
    return;
  }

  try {
    const response = await fetch('/api/subscriptions', { cache: 'no-store' });
    const data = await response.json().catch(() => null);
    if (response.ok && data?.success && Array.isArray(data.subscriptions)) {
      state.subscriptions = data.subscriptions;
      saveSubscriptions();
    }
  } catch {
    /* non-critical */
  }

  try {
    const response = await fetch('/api/history', { cache: 'no-store' });
    const data = await response.json().catch(() => null);
    if (response.ok && data?.success && Array.isArray(data.history)) {
      state.history = data.history.filter((video) => video && video.id);
      saveHistory();
    }
  } catch {
    /* non-critical */
  }

  updateSubscribeUI();
  updateLikeUI();

  const videoId = state.activeVideo?.id;
  if (videoId) {
    await Promise.allSettled([
      loadVideoState(videoId),
      loadCommunityComments(videoId)
    ]);
  }
}

function resetUserInteractions() {
  state.videoState = {};
  Object.keys(state.likes).forEach((videoId) => { delete state.likes[videoId]; });
  state.subscriptions = [];
  saveSubscriptions();

  if (state.activeVideo?.id) {
    loadCommunityComments(state.activeVideo.id, { skipMigration: true });
  }

  updateLikeUI();
  updateSubscribeUI();
}

function saveHistory() {
  state.history = state.history.slice(0, 100);
  writeJSON('pb_history', state.history);
}

function addToHistory(video) {
  if (!video || !video.id) return;
  const item = normalizeVideoCard(video);
  state.history = state.history.filter((entry) => entry.id !== item.id);
  state.history.unshift(item);
  saveHistory();

  // Cloud sync to user Google account / server so it appears across other phones & devices
  try {
    fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video: item })
    }).catch(() => {});
  } catch {}
}

function saveFavorites() {
  writeJSON('pb_favorites', state.favorites);
}

function isFavorite(videoId) {
  return state.favorites.some((video) => video.id === videoId);
}

const NO_THUMB_SVG = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#141418"/><circle cx="160" cy="90" r="26" fill="rgba(255,0,51,0.88)"/><polygon points="152,77 174,90 152,103" fill="#ffffff"/></svg>'
)}`;

function normalizeThumbUrl(url, videoId) {
  const clean = String(url || '').trim();
  if (!clean || /no_thumbnail/i.test(clean) || /maxresdefault\.jpg/i.test(clean)) {
    return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : NO_THUMB_SVG;
  }
  return clean;
}

function attachSafeThumbnail(imgEl, videoId, initialUrl = '') {
  if (!imgEl) return;
  const candidates = [];
  const addCandidate = (u) => {
    if (u && !candidates.includes(u)) candidates.push(u);
  };
  const primary = normalizeThumbUrl(initialUrl, videoId);
  addCandidate(primary);
  if (videoId) {
    addCandidate(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);
    addCandidate(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`);
    addCandidate(`https://i.ytimg.com/vi/${videoId}/sddefault.jpg`);
    addCandidate(`/api/image-proxy?url=${encodeURIComponent(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`)}`);
  }

  let step = 0;
  const tryNext = () => {
    step += 1;
    if (step < candidates.length) {
      imgEl.src = candidates[step];
    } else {
      imgEl.src = NO_THUMB_SVG;
    }
  };

  imgEl.referrerPolicy = 'no-referrer';
  imgEl.addEventListener('error', tryNext);
  imgEl.addEventListener('load', () => {
    // YouTube returns a 120x90 grey "..." placeholder whenever a thumbnail size doesn't exist
    if (imgEl.naturalWidth > 0 && imgEl.naturalWidth <= 120 && step < candidates.length - 1) {
      tryNext();
      return;
    }
    if (imgEl.naturalHeight > imgEl.naturalWidth && imgEl.parentElement) {
      imgEl.style.objectFit = 'contain';
      imgEl.parentElement.style.background = '#0a0a0a';
    }
  });
  imgEl.src = candidates[0] || NO_THUMB_SVG;
}

function normalizeVideoCard(video) {
  return {
    id: video.id,
    title: video.title || '',
    channel: video.channel || '',
    channelId: video.channelId || '',
    channelAvatar: video.channelAvatar || '',
    duration: video.duration || (video.lengthSeconds ? formatDuration(video.lengthSeconds) : ''),
    isShort: !!(video.isShort || /\/shorts\//i.test(video.url || '') || /#shorts/i.test(video.title || '') || String(video.duration || '').toLowerCase() === 'shorts'),
    views: video.views || (video.viewCount != null ? formatViews(video.viewCount) : ''),
    publishedTime: video.publishedTime || (video.publishDate ? formatWatchDate(video.publishDate) : ''),
    thumbnail: normalizeThumbUrl(video.thumbnail, video.id),
    url: video.url || `https://www.youtube.com/watch?v=${video.id}`
  };
}

/* ============================================================
 * Authentication — local Google-style accounts + optional OAuth
 * ============================================================ */
function setupAuthUI() {
  if (el.openAuthModalBtn) {
    el.openAuthModalBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (state.currentUser) {
        toggleProfileMenu();
      } else {
        openAuthModal();
      }
    });
  }

  el.profileSwitchBtn?.addEventListener('click', () => {
    closeProfileMenu();
    openAuthModal(false);
  });

  el.profileSignOutBtn?.addEventListener('click', async () => {
    closeProfileMenu();
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
    localStorage.removeItem('ay_current_user');
    window.location.reload();
    return;

    closeProfileMenu();
    signOut();
  });

  el.profileHistoryBtn?.addEventListener('click', () => {
    closeProfileMenu();
    activateChipByName('سجل المشاهدة');
    showFeedView();
    renderCollection(state.history, 'لم تشاهد أي فيديو بعد. سيظهر سجل المشاهدة هنا.');
  });

  el.profileMyVideosBtn?.addEventListener('click', () => {
    closeProfileMenu();
    if (state.authConfig.googleOAuth) {
      openAuthModal(false);
      startGoogleOAuth();
    } else {
      showToast('هذه نسخة محلية — فعّل Google OAuth في الخادم لعرض قناتك الحقيقية.');
    }
  });

  el.closeGoogleAuthBtn?.addEventListener('click', closeAuthModal);
  el.googleAuthModal?.addEventListener('click', (event) => {
    if (event.target === el.googleAuthModal) closeAuthModal();
  });

  el.gaUseAnotherBtn?.addEventListener('click', () => showFormView(true, 'register'));
  el.gaCreateAccountBtn?.addEventListener('click', () => showFormView(true, 'register'));
  el.gaBackToAccountsBtn?.addEventListener('click', () => showChooseView());
  el.gaAddAccountBtn?.addEventListener('click', addAccountFromForm);
  el.gaRealGoogleBtn?.addEventListener('click', startGoogleOAuth);
  el.gaModeRegisterBtn?.addEventListener('click', () => setAuthMode('register'));
  el.gaModeLoginBtn?.addEventListener('click', () => setAuthMode('login'));

  [el.gaNameInput, el.gaEmailInput, el.gaPasswordInput].forEach((input) => {
    if (!input) return;
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addAccountFromForm();
      }
    });
  });

  el.googleAccountsList?.addEventListener('click', (event) => {
    const card = event.target.closest('.google-acc-card');
    if (!card) return;
    const email = card.getAttribute('data-email');
    const account = state.accounts.find((entry) => entry.email === email);
    if (account) selectAccount(account);
  });

  document.addEventListener('click', (event) => {
    if (el.accountArea && !el.accountArea.contains(event.target)) closeProfileMenu();
  });

  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin) return;
    if (event.data && event.data.type === 'ay-auth-success') {
      restoreServerSession(true, true).then((user) => {
        if (user) {
          closeAuthModal();
          showToast(`مرحباً ${getFirstName(state.currentUser.name)}`);
          state.wantsAuthAfterLogin = false;
        }
      });
    } else if (event.data && event.data.type === 'ay-auth-error') {
      showToast('تعذر إكمال تسجيل الدخول عبر Google');
    }
  });
}

async function loadAuthConfig() {
  try {
    const response = await fetch('/api/auth/config');
    const data = await response.json();
    if (data && data.success) {
      state.authConfig = {
        googleOAuth: !!data.googleOAuth,
        googleClientId: data.googleClientId || '496823523744-s13qgm44idrlpe0ootkj32h1df7in24o.apps.googleusercontent.com',
        provider: data.provider || 'local'
      };
    }
  } catch {
    state.authConfig = {
      googleOAuth: false,
      googleClientId: '496823523744-s13qgm44idrlpe0ootkj32h1df7in24o.apps.googleusercontent.com',
      provider: 'local'
    };
  }
  if (el.gaOAuthSection) el.gaOAuthSection.style.display = 'block';
  initGoogleIdentityServices();
}

function initGoogleIdentityServices() {
  const clientId = state.authConfig.googleClientId || '496823523744-s13qgm44idrlpe0ootkj32h1df7in24o.apps.googleusercontent.com';
  if (!window.google?.accounts?.id || !clientId) {
    setTimeout(initGoogleIdentityServices, 600);
    return;
  }

  try {
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: handleGoogleGsiResponse,
      auto_select: false,
      cancel_on_tap_outside: true
    });

    const container = document.getElementById('gsiButtonContainer');
    if (container) {
      container.innerHTML = '';
      window.google.accounts.id.renderButton(container, {
        type: 'standard',
        theme: 'filled_blue',
        size: 'large',
        text: 'signin_with',
        shape: 'pill',
        locale: 'ar',
        logo_alignment: 'left',
        width: 320
      });
    }
  } catch (err) {
    console.warn('GIS init:', err);
  }
}

async function handleGoogleGsiResponse(response) {
  if (!response?.credential) return;
  if (el.authStatusMsg) el.authStatusMsg.textContent = 'جاري التحقق من حساب Google...';
  try {
    const res = await fetch('/api/auth/google-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential })
    });
    const data = await res.json();
    if (data && data.success && data.user) {
      applyCurrentUser({
        name: data.user.name,
        email: data.user.email,
        picture: data.user.picture || '',
        provider: 'google'
      }, { addAccount: true });
      await refreshUserInteractions();
      closeAuthModal();
      showToast(`مرحباً ${getFirstName(data.user.name)}! تم تسجيل الدخول بنجاح`);
      setTimeout(() => window.location.reload(), 600);
    } else {
      if (el.authStatusMsg) el.authStatusMsg.textContent = data.error || 'فشل تسجيل الدخول بحساب Google';
    }
  } catch {
    if (el.authStatusMsg) el.authStatusMsg.textContent = 'تعذر الاتصال بالخادم';
  }
}

async function restoreServerSession(silent = false, force = false) {
  try {
    const response = await fetch('/api/auth/me', { cache: 'no-store' });
    const data = await response.json();
    if (data && data.success && data.user && data.user.email) {
      const current = state.currentUser;
      const differentLocalAccount = current
        && current.provider === 'local'
        && String(current.email).toLowerCase() !== String(data.user.email).toLowerCase();
      if (differentLocalAccount && !force) return false;

      applyCurrentUser({ ...data.user, provider: data.user.provider || 'google' }, { addAccount: true, silent: true });
      await refreshUserInteractions();
      return true;
    }
  } catch {
    /* ignore */
  }
  if (!silent && state.currentUser) showToast('تعذر تحديث جلسة الحساب');
  return false;
}

function getFirstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'صديقنا';
}

function saveAccounts() {
  writeJSON('ay_google_accounts', state.accounts);
}

function applyCurrentUser(user, options = {}) {
  if (!user || !user.email) return;
  const normalized = {
    id: user.id || String(user.email).toLowerCase(),
    name: String(user.name || '').trim() || String(user.email).split('@')[0],
    email: String(user.email).trim(),
    picture: user.picture || '',
    provider: user.provider || 'local'
  };

  const existing = state.accounts.find((account) => account.email.toLowerCase() === normalized.email.toLowerCase());
  if (existing && !normalized.picture) normalized.picture = existing.picture || '';

  state.currentUser = normalized;
  currentUser = normalized;
  writeJSON('ay_google_user', normalized);

  if (options.addAccount !== false) {
    const index = state.accounts.findIndex((account) => account.email.toLowerCase() === normalized.email.toLowerCase());
    if (index >= 0) {
      state.accounts[index] = { ...state.accounts[index], ...normalized };
    } else {
      state.accounts.unshift(normalized);
    }
    saveAccounts();
  }

  renderAuthState();
  if (!options.silent) {
    showToast(`مرحباً ${getFirstName(normalized.name)} 👋`);
  }
}

function renderAuthState() {
  const user = state.currentUser;

  if (el.openAuthModalBtn) {
    if (user) {
      el.openAuthModalBtn.classList.add('has-user');
      el.openAuthModalBtn.title = user.email;
      el.openAuthModalBtn.innerHTML = `<img src="${escapeHtml(avatarSource(user.name, user.picture))}" alt="" referrerpolicy="no-referrer" style="width:27px;height:27px;border-radius:50%;object-fit:cover;background:#333;flex-shrink:0;"><span id="loginBtnLabel">${escapeHtml(getFirstName(user.name))}</span>`;
    } else {
      el.openAuthModalBtn.classList.remove('has-user');
      el.openAuthModalBtn.title = 'تسجيل الدخول إلى حساب Google';
      el.openAuthModalBtn.innerHTML = signedOutAuthMarkup;
    }
  }

  if (el.profileMenuName) el.profileMenuName.textContent = user ? user.name : 'حسابي';
  if (el.profileMenuEmail) el.profileMenuEmail.textContent = user ? user.email : 'user@gmail.com';

  if (el.profileMenuAvatar) {
    if (user && user.picture) {
      el.profileMenuAvatar.textContent = '';
      el.profileMenuAvatar.style.backgroundImage = `url("${user.picture}")`;
      el.profileMenuAvatar.style.backgroundSize = 'cover';
      el.profileMenuAvatar.style.backgroundPosition = 'center';
    } else {
      el.profileMenuAvatar.style.backgroundImage = '';
      el.profileMenuAvatar.textContent = user ? initialOf(user.name) : 'م';
    }
  }

  if (el.commentUserAvatar) {
    if (user && user.picture) {
      el.commentUserAvatar.textContent = '';
      el.commentUserAvatar.style.backgroundImage = `url("${user.picture}")`;
      el.commentUserAvatar.style.backgroundSize = 'cover';
      el.commentUserAvatar.style.backgroundPosition = 'center';
    } else {
      el.commentUserAvatar.style.backgroundImage = '';
      el.commentUserAvatar.textContent = user ? initialOf(user.name) : 'م';
      el.commentUserAvatar.style.background = user ? '' : '#444';
    }
  }

  if (el.newCommentInput) {
    updateCommentComposerPlaceholder();
  }

  if (user && state.wantsAuthAfterLogin) {
    state.wantsAuthAfterLogin = false;
    setTimeout(() => el.newCommentInput?.focus(), 250);
  }
}

function openAuthModal() {
  if (!el.googleAuthModal) return;
  if (el.authStatusMsg) el.authStatusMsg.textContent = '';
  if (el.gaFormError) el.gaFormError.textContent = '';
  showChooseView();
  showModal(el.googleAuthModal);
  if (window.google?.accounts?.id) {
    initGoogleIdentityServices();
  }
}

function closeAuthModal() {
  hideModal(el.googleAuthModal);
  if (el.gaFormError) el.gaFormError.textContent = '';
  if (el.authStatusMsg) el.authStatusMsg.textContent = '';
}

function showChooseView() {
  renderAccountPicker();
  if (el.gaChooseView) el.gaChooseView.style.display = 'block';
  if (el.gaFormView) el.gaFormView.style.display = 'none';
}

function setAuthMode(mode) {
  state.authMode = mode === 'login' ? 'login' : 'register';
  const login = state.authMode === 'login';

  el.gaModeRegisterBtn?.classList.toggle('active', !login);
  el.gaModeLoginBtn?.classList.toggle('active', login);
  if (el.gaNameField) el.gaNameField.style.display = login ? 'none' : '';
  if (el.gaAddAccountBtn) el.gaAddAccountBtn.textContent = login ? 'تسجيل الدخول' : 'إنشاء الحساب';
  if (el.gaPasswordInput) {
    el.gaPasswordInput.autocomplete = login ? 'current-password' : 'new-password';
    el.gaPasswordInput.placeholder = login ? 'أدخل كلمة المرور' : '6 أحرف على الأقل';
  }
  if (el.gaFormError) el.gaFormError.textContent = '';
}

function showFormView(clearFields = true, mode = state.authMode) {
  if (el.gaChooseView) el.gaChooseView.style.display = 'none';
  if (el.gaFormView) el.gaFormView.style.display = 'block';
  if (el.gaBackToAccountsBtn) el.gaBackToAccountsBtn.style.display = state.accounts.length ? '' : 'none';
  if (el.gaFormError) el.gaFormError.textContent = '';
  if (clearFields) {
    if (el.gaNameInput) el.gaNameInput.value = '';
    if (el.gaEmailInput) el.gaEmailInput.value = '';
    if (el.gaPasswordInput) el.gaPasswordInput.value = '';
  }
  setAuthMode(mode);
  setTimeout(() => {
    if (state.authMode === 'login') el.gaEmailInput?.focus();
    else el.gaNameInput?.focus();
  }, 120);
}

function renderAccountPicker() {
  if (!el.googleAccountsList) return;
  el.googleAccountsList.innerHTML = '';
  state.accounts.forEach((account) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'google-acc-card';
    button.setAttribute('data-email', account.email);

    if (account.picture) {
      const image = document.createElement('img');
      image.className = 'google-acc-avatar';
      image.src = account.picture;
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      image.style.objectFit = 'cover';
      button.appendChild(image);
    } else {
      const avatar = document.createElement('div');
      avatar.className = 'google-acc-avatar';
      avatar.textContent = initialOf(account.name);
      button.appendChild(avatar);
    }

    const details = document.createElement('div');
    details.className = 'google-acc-details';
    const name = document.createElement('div');
    name.className = 'google-acc-name';
    name.textContent = account.name;
    const email = document.createElement('div');
    email.className = 'google-acc-email';
    email.textContent = account.email;
    details.appendChild(name);
    details.appendChild(email);
    button.appendChild(details);

    if (state.currentUser && state.currentUser.email === account.email) {
      const check = document.createElement('span');
      check.textContent = '✓';
      check.style.marginInlineStart = 'auto';
      check.style.color = '#1a73e8';
      check.style.fontWeight = '900';
      button.appendChild(check);
    }

    el.googleAccountsList.appendChild(button);
  });
}

function selectAccount(account) {
  if (!account?.email) return;
  applyCurrentUser(account, { addAccount: true });
  closeAuthModal();
  showToast(`مرحباً بك مجدداً ${getFirstName(account.name)}!`);
  setTimeout(() => window.location.reload(), 500);
}

async function addAccountFromForm() {
  const login = state.authMode === 'login';
  const name = (el.gaNameInput?.value || '').trim();
  const email = (el.gaEmailInput?.value || '').trim();
  const password = el.gaPasswordInput?.value || '';

  const fail = (message) => {
    if (el.gaFormError) el.gaFormError.textContent = message;
    return false;
  };

  if (!login && name.length < 2) return fail('اكتب اسماً صحيحاً (حرفان على الأقل).');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail('اكتب بريداً إلكترونياً صحيحاً.');
  if (password.length < 6) return fail('كلمة المرور يجب أن تكون 6 أحرف على الأقل.');

  const originalText = el.gaAddAccountBtn?.textContent || '';
  if (el.gaAddAccountBtn) {
    el.gaAddAccountBtn.disabled = true;
    el.gaAddAccountBtn.textContent = login ? 'جارٍ تسجيل الدخول...' : 'جارٍ إنشاء الحساب...';
  }
  if (el.gaFormError) el.gaFormError.textContent = '';

  try {
    const response = await fetch(login ? '/api/auth/login' : '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(login ? { email, password } : { name, email, password })
    });
    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.success || !data.user) {
      if (response.status === 409) {
        setAuthMode('login');
        return fail(data?.error || 'هذا البريد مسجّل بالفعل. سجّل الدخول.');
      }
      return fail(data?.error || 'تعذر إكمال العملية. تحقق من البيانات وحاول مجدداً.');
    }

    applyCurrentUser({ ...data.user, provider: data.user.provider || 'local' }, { addAccount: true, silent: true });
    if (el.gaPasswordInput) el.gaPasswordInput.value = '';
    closeAuthModal();
    showToast(`مرحباً ${getFirstName(state.currentUser.name)} 👋`);
    state.wantsAuthAfterLogin = false;
    await refreshUserInteractions();
    return true;
  } catch (error) {
    return fail('تعذر الاتصال بالخادم. تحقق من التشغيل ثم حاول مجدداً.');
  } finally {
    if (el.gaAddAccountBtn) {
      el.gaAddAccountBtn.disabled = false;
      el.gaAddAccountBtn.textContent = state.authMode === 'login' ? 'تسجيل الدخول' : 'إنشاء الحساب';
      if (!originalText) el.gaAddAccountBtn.textContent = el.gaAddAccountBtn.textContent;
    }
  }
}

function startGoogleOAuth() {
  if (!state.authConfig.googleOAuth) {
    if (window.google?.accounts?.id) {
      window.google.accounts.id.prompt();
      if (el.authStatusMsg) el.authStatusMsg.textContent = 'اختر حساب Google من النافذة المنبثقة للمتابعة...';
      return;
    }
    if (el.authStatusMsg) el.authStatusMsg.textContent = 'أدخل الرمز السري للعميل Client Secret لإكمال الربط الرسمي.';
    return;
  }

  const popup = window.open(
    '/api/auth/google',
    'ay_google_oauth',
    'width=520,height=700,menubar=no,toolbar=no,resizable=yes,scrollbars=yes'
  );

  if (!popup) {
    if (el.authStatusMsg) el.authStatusMsg.textContent = 'المتصفح منع النافذة المنبثقة. اسمح بها ثم حاول مجدداً.';
    return;
  }

  if (el.authStatusMsg) el.authStatusMsg.textContent = 'أكمل تسجيل الدخول في نافذة Google، وسيعود التطبيق تلقائياً...';

  const timer = setInterval(async () => {
    if (popup.closed) {
      clearInterval(timer);
      const user = await restoreServerSession(true, true);
      if (user) {
        closeAuthModal();
        showToast(`مرحباً ${getFirstName(state.currentUser.name)}`);
      } else if (el.authStatusMsg) {
        el.authStatusMsg.textContent = 'لم يكتمل تسجيل الدخول. حاول مرة أخرى.';
      }
    }
  }, 900);
}

async function signOut() {
  try {
    await fetch('/api/auth/logout', { method: 'GET' });
  } catch {
    /* local sign-out still works */
  }
  state.currentUser = null;
  currentUser = null;
  try { localStorage.removeItem('ay_google_user'); } catch { /* ignore */ }
  resetUserInteractions();
  closeProfileMenu();
  renderAuthState();
  showToast('تم تسجيل الخروج من AYTube');
}

function toggleProfileMenu(force) {
  if (!el.profileMenu) return;
  if (!state.currentUser) {
    openAuthModal();
    return;
  }
  const shouldOpen = typeof force === 'boolean' ? force : !el.profileMenu.classList.contains('active');
  el.profileMenu.classList.toggle('active', shouldOpen);
}

function closeProfileMenu() {
  el.profileMenu?.classList.remove('active');
}

async function handleAuthReturn(status) {
  const params = new URLSearchParams(location.search);
  params.delete('auth');
  const clean = `${location.pathname}${params.toString() ? `?${params.toString()}` : ''}`;
  try { history.replaceState({}, '', clean); } catch { /* ignore */ }

  if (window.opener && window.opener !== window) {
    window.opener.postMessage(
      { type: status === 'success' ? 'ay-auth-success' : 'ay-auth-error' },
      location.origin
    );
    setTimeout(() => window.close(), 350);
    return;
  }

  if (status === 'success') {
    const user = await restoreServerSession(true, true);
    renderAuthState();
    if (user) {
      closeAuthModal();
      showToast(`تم تسجيل الدخول: ${state.currentUser.email}`);
    } else {
      showToast('تم التفويض لكن تعذر قراءة جلسة Google. حاول مرة أخرى.');
    }
  } else {
    showToast('تعذر تسجيل الدخول عبر Google. حاول مرة أخرى.');
  }
}

/* ============================================================
 * Home feed, search and collections
 * ============================================================ */
function setupChips() {
  if (!el.chipsBar) return;
  el.chipsBar.addEventListener('click', (event) => {
    const chip = event.target.closest('.yt-chip');
    if (!chip) return;
    handleChip(chip.getAttribute('data-query') || 'الكل');
  });
}

function setActiveChip(query) {
  state.activeChip = query || null;
  $$('.yt-chip', el.chipsBar || document).forEach((chip) => {
    chip.classList.toggle('active', chip.getAttribute('data-query') === query);
  });
}

function activateChipByName(name) {
  setActiveChip(name);
}

async function handleChip(query, options = {}) {
  setActiveChip(query);
  hideSuggestions();

  if (!options.skipPush) {
    pushAppRoute(query === 'الكل' ? {} : { chip: query });
  }

  if (query === 'الكل') {
    if (el.searchInput) el.searchInput.value = '';
    updateClearSearchButton();
    await loadFeed('الكل', { cache: true });
    return;
  }

  if (query === 'سجل المشاهدة') {
    showFeedView({ pause: true });
    // Fetch cloud-synced history from Google account / server
    try {
      const res = await fetch('/api/history');
      const data = await res.json();
      if (data && data.success && Array.isArray(data.history) && data.history.length) {
        state.history = data.history;
        saveHistory();
      }
    } catch {}
    renderCollection(state.history, 'لم تشاهد أي فيديو بعد. سيظهر سجل المشاهدة هنا.');
    return;
  }

  if (query === 'المفضلة') {
    showFeedView({ pause: true });
    renderCollection(state.favorites, 'لا توجد فيديوهات في المفضلة بعد. اضغط ⭐ في أي فيديو لإضافته.');
    return;
  }

  if (query === 'اشتراكاتي') {
    await showSubscriptionsFeed();
    return;
  }

  if (el.searchInput) el.searchInput.value = query;
  updateClearSearchButton();
  await loadFeed(query);
}

async function showSubscriptionsFeed() {
  showFeedView({ pause: true });

  if (!state.currentUser) {
    renderVideoFeed([], 'سجّل الدخول لعرض فيديوهات القنوات التي تشترك فيها.');
    return;
  }

  try {
    const response = await fetch('/api/subscription-feed', { cache: 'no-store' });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) throw new Error(data?.error || 'تعذر تحميل الاشتراكات');

    if (Array.isArray(data.subscriptions)) {
      state.subscriptions = data.subscriptions;
      saveSubscriptions();
    }

    const videos = Array.isArray(data.videos) ? data.videos.filter((video) => video && video.id) : [];
    if (videos.length) {
      renderVideoFeed(videos);
      return;
    }

    if (!state.subscriptions.length) {
      renderVideoFeed([], 'لا توجد اشتراكات بعد. افتح أي فيديو واضغط «اشتراك» لتظهر فيديوهات قناتك هنا.');
      return;
    }

    renderVideoFeed([], 'لا توجد فيديوهات حديثة من قنواتك المشترك بها حالياً. حاول مرة أخرى بعد قليل.');
  } catch (error) {
    const subscribed = new Set(
      state.subscriptions
        .map((channel) => (typeof channel === 'string' ? channel : channel?.channelName || channel?.name))
        .filter(Boolean)
        .map((channel) => String(channel).toLowerCase())
    );
    const pool = dedupeVideos([...state.cachedFeed, ...state.favorites, ...state.history]);
    const matches = pool.filter((video) => subscribed.has(String(video.channel || '').toLowerCase()));
    if (matches.length) {
      renderVideoFeed(matches);
    } else {
      renderVideoFeed([], error.message || 'تعذر تحميل فيديوهات الاشتراكات. حاول مرة أخرى.');
    }
  }
}

function setupSearch() {
  if (el.searchBtn) {
    el.searchBtn.addEventListener('click', () => performSearch());
  }

  if (el.searchInput) {
    el.searchInput.addEventListener('input', () => {
      updateClearSearchButton();
      state.suggestedIndex = -1;
      scheduleSuggestions(el.searchInput.value);
    });

    el.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (state.suggestionItems.length && state.suggestedIndex >= 0) {
          chooseSuggestion(state.suggestionItems[state.suggestedIndex]);
        } else {
          performSearch();
        }
      } else if (event.key === 'ArrowDown') {
        if (!state.suggestionItems.length) return;
        event.preventDefault();
        highlightSuggestion((state.suggestedIndex + 1) % state.suggestionItems.length);
      } else if (event.key === 'ArrowUp') {
        if (!state.suggestionItems.length) return;
        event.preventDefault();
        highlightSuggestion(state.suggestedIndex <= 0 ? state.suggestionItems.length - 1 : state.suggestedIndex - 1);
      } else if (event.key === 'Escape') {
        hideSuggestions();
      }
    });

    el.searchInput.addEventListener('focus', () => {
      if (state.suggestionItems.length) el.autocompleteList.style.display = 'block';
    });
  }

  el.clearSearchBtn?.addEventListener('click', () => {
    if (el.searchInput) {
      el.searchInput.value = '';
      el.searchInput.focus();
    }
    updateClearSearchButton();
    hideSuggestions();
    setActiveChip('الكل');
    loadFeed(DEFAULT_QUERY, { cache: true });
  });

  el.brandHome?.addEventListener('click', (event) => {
    event.preventDefault();
    showFeedView({ pause: true });
    pushAppRoute({});
    setActiveChip('الكل');
    if (el.searchInput) el.searchInput.value = '';
    updateClearSearchButton();
    loadFeed(DEFAULT_QUERY, { cache: true });
  });

  document.addEventListener('click', (event) => {
    if (!el.searchInput || !el.autocompleteList) return;
    if (event.target !== el.searchInput && !el.autocompleteList.contains(event.target)) {
      hideSuggestions();
    }
  });
}

function updateClearSearchButton() {
  if (!el.clearSearchBtn || !el.searchInput) return;
  el.clearSearchBtn.style.display = el.searchInput.value ? 'block' : 'none';
}

const scheduleSuggestions = debounce((query) => loadSuggestions(query), 230);

async function loadSuggestions(query) {
  const q = String(query || '').trim();
  if (q.length < 2) {
    hideSuggestions();
    return;
  }

  const requestId = (state.suggestRequestId || 0) + 1;
  state.suggestRequestId = requestId;

  try {
    const response = await fetch(`/api/suggest?q=${encodeURIComponent(q)}`);
    const data = await response.json();
    if (requestId !== state.suggestRequestId) return;
    if (!el.searchInput || el.searchInput.value.trim() !== q) return;
    state.suggestionItems = Array.isArray(data.suggestions) ? data.suggestions.slice(0, 8) : [];
    state.suggestedIndex = -1;
    renderSuggestions();
  } catch {
    if (requestId === state.suggestRequestId) hideSuggestions();
  }
}

function renderSuggestions() {
  if (!el.autocompleteList) return;
  el.autocompleteList.innerHTML = '';

  if (!state.suggestionItems.length) {
    hideSuggestions();
    return;
  }

  state.suggestionItems.forEach((suggestion, index) => {
    const item = document.createElement('li');
    item.className = 'autocomplete-item';
    item.setAttribute('data-index', String(index));
    const icon = document.createElement('span');
    icon.textContent = '🔍';
    icon.style.opacity = '0.6';
    const label = document.createElement('span');
    label.textContent = suggestion;
    item.appendChild(icon);
    item.appendChild(label);
    item.addEventListener('click', () => chooseSuggestion(suggestion));
    el.autocompleteList.appendChild(item);
  });

  el.autocompleteList.style.display = 'block';
}

function highlightSuggestion(index) {
  if (!el.autocompleteList) return;
  const items = $$('.autocomplete-item', el.autocompleteList);
  items.forEach((item, itemIndex) => {
    item.style.background = itemIndex === index ? 'var(--bg-card-hover)' : '';
  });
  state.suggestedIndex = index;
  items[index]?.scrollIntoView({ block: 'nearest' });
}

function hideSuggestions() {
  state.suggestionItems = [];
  state.suggestedIndex = -1;
  if (el.autocompleteList) {
    el.autocompleteList.style.display = 'none';
    el.autocompleteList.innerHTML = '';
  }
}

function chooseSuggestion(value) {
  if (!value) return;
  if (el.searchInput) el.searchInput.value = value;
  updateClearSearchButton();
  hideSuggestions();
  performSearch(value);
}

function performSearch(override, options = {}) {
  const query = String(override != null ? override : (el.searchInput?.value || '')).trim();
  if (!query) {
    if (el.searchInput) el.searchInput.focus();
    return;
  }

  if (el.searchInput) el.searchInput.value = query;
  updateClearSearchButton();
  hideSuggestions();

  const matchingChip = $$('.yt-chip', el.chipsBar || document)
    .map((chip) => chip.getAttribute('data-query'))
    .find((value) => value === query);
  setActiveChip(matchingChip || null);

  if (!options.skipPush) {
    pushAppRoute({ search: query });
  }

  return loadFeed(query);
}

async function loadFeed(query, options = {}) {
  const q = String(query || '').trim();
  if (!q) return;

  state.currentQuery = q;
  showFeedView({ pause: true });
  if (!options.keepExisting) {
    renderSkeletons();
  }

  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data || !data.success) throw new Error(data?.error || 'تعذر جلب نتائج البحث');

    const videos = Array.isArray(data.results) ? data.results.filter((video) => video && video.id) : [];
    if (options.cache) {
      state.cachedFeed = videos;
      writeJSON('ay_cached_feed', videos);
    }

    renderVideoFeed(videos, 'لا توجد نتائج لهذا البحث. جرّب كلمات أخرى أو أحد التصنيفات.');
    // Quietly prefetch top 3 videos in client cache for instant click-to-play
    videos.slice(0, 3).forEach((v) => prefetchPlayer(v.id));
  } catch (error) {
    console.error('Feed error:', error);
    if (options.cache && state.cachedFeed.length) {
      renderVideoFeed(state.cachedFeed);
      showToast('تعذر تحديث الصفحة الرئيسية — يتم عرض آخر نتائج محفوظة.');
    } else if (!options.keepExisting) {
      renderVideoFeed([], 'تعذر تحميل الفيديوهات حالياً. تحقق من اتصال الإنترنت ثم حاول مرة أخرى.');
    }
  }
}

function renderSkeletons() {
  if (!el.videosContainer) return;
  el.videosContainer.className = 'videos-grid yt-feed-grid';
  const markup = Array.from({ length: 8 }).map(() => `
    <div class="video-card skeleton-card">
      <div class="thumb-wrap skeleton-box"></div>
      <div class="video-meta">
        <div class="card-channel-avatar skeleton-circle"></div>
        <div class="card-info">
          <div class="skeleton-line" style="width: 85%;"></div>
          <div class="skeleton-line" style="width: 50%; margin-top: 6px;"></div>
        </div>
      </div>
    </div>
  `).join('');
  el.videosContainer.innerHTML = markup;
}

function renderVideoFeed(videos, emptyMessage = 'لا توجد فيديوهات لعرضها حالياً.') {
  if (!el.videosContainer) return;
  el.videosContainer.className = 'videos-grid yt-feed-grid';
  el.videosContainer.innerHTML = '';

  const list = dedupeVideos(Array.isArray(videos) ? videos.filter((video) => video && video.id) : []);
  if (!list.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'grid-column:1 / -1;text-align:center;padding:56px 20px;color:var(--text-secondary);';
    const icon = document.createElement('div');
    icon.style.cssText = 'font-size:3rem;margin-bottom:12px;';
    icon.textContent = '📺';
    const title = document.createElement('div');
    title.style.cssText = 'font-size:1.15rem;font-weight:800;color:var(--text-primary);margin-bottom:6px;';
    title.textContent = 'لا يوجد محتوى هنا بعد';
    const subtitle = document.createElement('div');
    subtitle.style.fontSize = '0.9rem';
    subtitle.textContent = emptyMessage;
    empty.appendChild(icon);
    empty.appendChild(title);
    empty.appendChild(subtitle);
    el.videosContainer.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  list.forEach((video) => fragment.appendChild(createVideoCard(video)));
  el.videosContainer.appendChild(fragment);
}

function createVideoCard(video) {
  const normalized = normalizeVideoCard(video);
  const card = document.createElement('div');
  card.className = 'video-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', normalized.title || 'فيديو');

  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'thumb-wrap';

  const image = document.createElement('img');
  image.className = 'video-thumb';
  image.loading = 'lazy';
  image.alt = normalized.title || '';
  attachSafeThumbnail(image, normalized.id, normalized.thumbnail);
  thumbWrap.appendChild(image);

  if (normalized.isShort) {
    const shortTag = document.createElement('span');
    shortTag.className = 'duration-tag';
    shortTag.style.background = '#ff0033';
    shortTag.textContent = 'Shorts';
    thumbWrap.appendChild(shortTag);
  } else if (normalized.duration) {
    const duration = document.createElement('span');
    duration.className = 'duration-tag';
    duration.textContent = normalized.duration;
    thumbWrap.appendChild(duration);
  }

  const meta = document.createElement('div');
  meta.className = 'video-meta';

  const avatar = document.createElement('img');
  avatar.className = 'card-channel-avatar';
  avatar.loading = 'lazy';
  avatar.referrerPolicy = 'no-referrer';
  avatar.alt = normalized.channel || '';
  avatar.src = avatarSource(normalized.channel, normalized.channelAvatar);
  avatar.addEventListener('error', () => {
    if (normalized.channelAvatar && !avatar.src.includes('/api/image-proxy')) {
      avatar.src = `/api/image-proxy?url=${encodeURIComponent(normalized.channelAvatar)}`;
    } else {
      avatar.src = getFallbackAvatar(normalized.channel);
    }
  });

  avatar.style.cursor = 'pointer';
  avatar.title = `زيارة قناة ${normalized.channel || ''}`;
  avatar.addEventListener('click', (e) => {
    e.stopPropagation();
    openChannelPage(normalized.channel, normalized.channelAvatar, normalized.channelId);
  });

  const info = document.createElement('div');
  info.className = 'card-info';

  const title = document.createElement('div');
  title.className = 'video-title';
  title.title = normalized.title || '';
  title.textContent = normalized.title || 'بدون عنوان';

  const channel = document.createElement('div');
  channel.className = 'video-channel';
  channel.textContent = normalized.channel || '';
  channel.style.cursor = 'pointer';
  channel.title = `زيارة قناة ${normalized.channel || ''}`;
  channel.addEventListener('click', (e) => {
    e.stopPropagation();
    openChannelPage(normalized.channel, normalized.channelAvatar, normalized.channelId);
  });

  const stats = document.createElement('div');
  stats.className = 'video-stats';
  const viewText = normalized.views ? formatViews(normalized.views) : '';
  stats.textContent = [viewText, normalized.publishedTime].filter(Boolean).join(' • ');

  info.appendChild(title);
  info.appendChild(channel);
  info.appendChild(stats);
  meta.appendChild(avatar);
  meta.appendChild(info);

  card.appendChild(thumbWrap);
  card.appendChild(meta);

  const open = () => normalized.isShort ? openShortsView(normalized) : openWatchView(normalized);
  card.addEventListener('pointerenter', () => prefetchPlayer(normalized.id), { passive: true });
  card.addEventListener('click', open);
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });

  return card;
}

function renderCollection(items, emptyMessage) {
  showFeedView({ pause: true });
  renderVideoFeed(dedupeVideos(items), emptyMessage);
}

function dedupeVideos(videos) {
  const seen = new Set();
  const output = [];
  (Array.isArray(videos) ? videos : []).forEach((video) => {
    if (!video || !video.id || seen.has(video.id)) return;
    seen.add(video.id);
    output.push(video);
  });
  return output;
}

function showFeedView(options = {}) {
  if (options.pause && !state.isBackground && !state.isFloating) {
    pauseMedia();
  }
  stopShortsPlayer();
  if (el.feedView) el.feedView.style.display = '';
  if (el.watchView) el.watchView.style.display = 'none';
  if (el.shortsView) el.shortsView.style.display = 'none';
  if (el.appFooter) el.appFooter.style.display = '';
  document.title = 'AYTube';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function switchToWatchView() {
  stopShortsPlayer();
  if (el.feedView) el.feedView.style.display = 'none';
  if (el.shortsView) el.shortsView.style.display = 'none';
  if (el.watchView) el.watchView.style.display = 'block';
  if (el.appFooter) el.appFooter.style.display = '';
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/* ============================================================
 * Custom player — core
 * ============================================================ */
const ICON_PLAY = 'M8 5v14l11-7z';
const ICON_PAUSE = 'M6 19h4V5H6v14zm8-14v14h4V5h-4z';
const FULLSCREEN_ENTER = 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z';
const FULLSCREEN_EXIT = 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z';
const VOLUME_PATH = 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.47 4.47 0 0 0 2.5-4zM14 3.23v2.06a6.99 6.99 0 0 1 0 13.42v2.06A9 9 0 0 0 14 3.23z';
const MUTED_PATH = 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z';

let playerToastTimer = null;

function setupPlayer() {
  if (!el.videoEl || !el.audioEl) return;

  el.videoEl.muted = true;
  el.videoEl.playsInline = true;
  el.audioEl.volume = state.volume;
  el.audioEl.muted = state.muted;
  if (el.volumeBar) el.volumeBar.value = String(state.volume);
  updateVolumeUI();

  el.playPauseBtn?.addEventListener('click', togglePlay);
  el.bigPlayBtn?.addEventListener('click', () => playMedia());
  el.watchChannel?.addEventListener('click', openActiveChannelPage);
  el.watchChannelAvatar?.addEventListener('click', openActiveChannelPage);
  el.videoEl.addEventListener('click', () => {
    closePlayerMenus();
    togglePlay();
  });
  el.videoEl.addEventListener('dblclick', (event) => {
    event.preventDefault();
    toggleFullscreen();
  });

  el.videoEl.addEventListener('loadedmetadata', onVideoMetadata);
  el.videoEl.addEventListener('timeupdate', onVideoTimeUpdate);
  el.videoEl.addEventListener('progress', updateBufferedBar);
  el.videoEl.addEventListener('play', onVideoPlay);
  el.videoEl.addEventListener('pause', onVideoPause);
  el.videoEl.addEventListener('playing', onVideoPlaying);
  el.videoEl.addEventListener('canplay', onVideoCanPlay);
  el.videoEl.addEventListener('waiting', onVideoWaiting);
  el.videoEl.addEventListener('ended', onVideoEnded);
  el.videoEl.addEventListener('seeked', () => {
    if (el.audioEl) el.audioEl.currentTime = el.videoEl.currentTime;
    updateTimeDisplay(el.videoEl.currentTime);
  });
  el.videoEl.addEventListener('error', onVideoError);

  el.audioEl.addEventListener('loadedmetadata', onAudioLoadedMetadata);
  el.audioEl.addEventListener('error', onAudioError);

  el.seekBar?.addEventListener('pointerdown', () => { state.seeking = true; });
  el.seekBar?.addEventListener('pointerup', () => { state.seeking = false; });
  el.seekBar?.addEventListener('input', onSeekInput);
  el.seekBar?.addEventListener('change', () => {
    state.seeking = false;
    if (state.isPlaying) playMedia();
  });

  el.volumeBar?.addEventListener('input', () => setVolume(Number(el.volumeBar.value)));
  el.muteBtn?.addEventListener('click', toggleMute);

  el.fullscreenBtn?.addEventListener('click', toggleFullscreen);
  el.pipBtn?.addEventListener('click', () => requirePro('المشغل العائم', activateExternalFloatingPlayer));
  document.addEventListener('fullscreenchange', updateFullscreenUI);

  el.ccBtn?.addEventListener('click', () => requirePro('الترجمة الفورية الذكية (CC)', toggleCCMenu));
  el.ccMenuClose?.addEventListener('click', closeCCMenu);
  el.settingsBtn?.addEventListener('click', toggleSettingsMenu);
  el.settingsMenuClose?.addEventListener('click', closeSettingsMenu);
  el.ccOffBtn?.addEventListener('click', disableCaptions);

  el.playerRetryBtn?.addEventListener('click', () => {
    if (state.activeVideo?.id) loadPlayer(state.activeVideo.id);
  });

  el.playerShell?.addEventListener('mousemove', showControls);
  el.playerShell?.addEventListener('touchstart', showControls, { passive: true });
  el.playerShell?.addEventListener('mouseleave', () => {
    if (state.isPlaying && !isAnyPlayerMenuOpen()) scheduleControlsHide(900);
  });

  el.speedList?.addEventListener('click', (event) => {
    const item = event.target.closest('.pc-item');
    if (!item) return;
    const value = Number(item.getAttribute('data-speed'));
    if (Number.isFinite(value)) setPlaybackSpeed(value);
  });

  el.qualityList?.addEventListener('click', (event) => {
    const item = event.target.closest('.pc-item');
    if (!item) return;
    const itag = item.getAttribute('data-itag');
    if (!itag) return;
    if (itag === 'auto') {
      selectAutoQuality();
    } else {
      const quality = state.qualities.find((entry) => String(entry.itag) === String(itag));
      if (quality) setQuality(quality, { auto: false });
    }
  });

  el.subBtn?.addEventListener('click', toggleSubscription);
  el.likeBtn?.addEventListener('click', () => setReaction('like'));
  el.dislikeBtn?.addEventListener('click', () => setReaction('dislike'));
  el.quickShareBtn?.addEventListener('click', openShareModal);
  el.quickDownloadBtn?.addEventListener('click', () => requirePro('تنزيل الفيديوهات والمقاطع', openDownloadModal));
  el.descToggleBtn?.addEventListener('click', toggleDescription);
  el.theaterBtn?.addEventListener('click', () => setTheater(!state.theater));

  setupMediaSession();
  setupSeekPreview();

  setInterval(() => {
    if (!state.playerData || !el.videoEl) return;
    if (state.isBackground) return;
    if (!el.videoEl.paused) {
      syncAudioClock(false);
      updateCaptionOverlay(el.videoEl.currentTime);
    }
  }, 500);
}

function setupSeekPreview() {
  if (!el.progressWrap || !el.seekBar || !el.seekPreviewBubble || !el.seekPreviewVideo) return;

  let isHovering = false;
  let seekPreviewThrottle = null;

  const updatePreviewAt = (clientX) => {
    if (el.seekPreviewVideo && el.seekPreviewVideo.dataset.pendingSrc && el.seekPreviewVideo.getAttribute('src') !== el.seekPreviewVideo.dataset.pendingSrc) {
      el.seekPreviewVideo.src = el.seekPreviewVideo.dataset.pendingSrc;
      el.seekPreviewVideo.preload = 'auto';
      el.seekPreviewVideo.load();
    }
    const rect = el.seekBar.getBoundingClientRect();
    if (!rect.width || !state.duration) return;
    const offsetX = clamp(clientX - rect.left, 0, rect.width);
    const ratio = offsetX / rect.width;
    const targetTime = ratio * state.duration;

    if (el.seekPreviewTime) {
      el.seekPreviewTime.textContent = formatDuration(targetTime);
    }

    if (!seekPreviewThrottle) {
      seekPreviewThrottle = setTimeout(() => {
        seekPreviewThrottle = null;
        if (el.seekPreviewVideo && el.seekPreviewVideo.readyState >= 1) {
          el.seekPreviewVideo.currentTime = targetTime;
        }
      }, 45);
    }

    const parentRect = el.progressWrap.getBoundingClientRect();
    const bubbleX = clamp(clientX - parentRect.left, 105, Math.max(105, parentRect.width - 105));
    el.seekPreviewBubble.style.left = `${bubbleX}px`;
    el.seekPreviewBubble.style.display = 'flex';
  };

  el.progressWrap.addEventListener('pointerenter', (e) => {
    if (!state.playerData) return;
    isHovering = true;
    updatePreviewAt(e.clientX);
  });

  el.progressWrap.addEventListener('pointermove', (e) => {
    if (!state.playerData) return;
    isHovering = true;
    updatePreviewAt(e.clientX);
  });

  el.progressWrap.addEventListener('pointerleave', () => {
    isHovering = false;
    if (!state.seeking && el.seekPreviewBubble) {
      el.seekPreviewBubble.style.display = 'none';
    }
  });

  el.seekBar.addEventListener('input', () => {
    const ratio = Number(el.seekBar.value) / 1000;
    const rect = el.seekBar.getBoundingClientRect();
    const clientX = rect.left + ratio * rect.width;
    updatePreviewAt(clientX);
  });

  document.addEventListener('pointerup', () => {
    if (!isHovering && el.seekPreviewBubble) {
      el.seekPreviewBubble.style.display = 'none';
    }
  });
}

async function openWatchView(video, options = {}) {
  const id = extractVideoId(video?.id || video?.url);
  if (!id) {
    showToast('رابط الفيديو غير صالح');
    return;
  }

  if (state.isBackground) stopBackgroundMode({ pause: true, silent: true });
  if (state.isFloating) closeFloatingPlayer({ pause: false, showFeed: false });

  state.playerAbort?.abort();
  state.activeVideo = { ...(video || {}), id };
  state.comments = [];
  state.commentsCursor = null;
  state.commentsLoadedFor = null;
  state.commentsSort = 'top';
  state.commentsAvailable = false;
  state.commentsLoading = false;

  el.commentsSortTop?.classList.add('active');
  el.commentsSortNew?.classList.remove('active');

  resetPlayerUI();
  populateWatchPlaceholder(state.activeVideo);
  renderRelatedSkeleton();
  resetCommentsUI(id);
  switchToWatchView();

  if (!options.skipPush) {
    pushAppRoute({ v: id });
  }
  addToHistory(state.activeVideo);
  loadComments(id, 'top', null, false);
  loadCommunityComments(id);
  loadPlayer(id, options);
}

function resetPlayerUI() {
  pauseMedia();
  state.playerData = null;
  state.qualities = [];
  state.selectedQualityItag = null;
  state.autoQuality = true;
  state.duration = 0;
  state.isPlaying = false;
  state.pendingAutoplay = false;
  state.pendingQualityTime = 0;
  state.pendingQualityPlay = false;
  state.qualitySwitchPending = false;
  state.switchingQuality = false;
  state.captionLookupCache = { cues: null, index: 0 };
  state.captions = { cues: [], active: false, key: '', name: '', mode: '' };

  closePlayerMenus();
  hidePlayerError();

  if (el.videoEl) {
    el.videoEl.pause();
    el.videoEl.removeAttribute('src');
    el.videoEl.poster = '';
    el.videoEl.load();
  }
  if (el.audioEl) {
    el.audioEl.pause();
    el.audioEl.removeAttribute('src');
    el.audioEl.load();
  }

  if (el.playerShell) {
    el.playerShell.classList.remove('is-playing', 'controls-hidden');
    el.playerShell.style.aspectRatio = '16 / 9';
    el.playerShell.style.maxHeight = '';
    el.playerShell.style.width = '100%';
    el.playerShell.style.margin = '';
  }
  if (el.seekPreviewVideo) {
    delete el.seekPreviewVideo.dataset.pendingSrc;
    el.seekPreviewVideo.removeAttribute('src');
    el.seekPreviewVideo.load();
  }
  if (el.bigPlayBtn) el.bigPlayBtn.classList.remove('visible');
  if (el.captionsOverlay) el.captionsOverlay.textContent = '';
  if (el.ccBtn) el.ccBtn.classList.remove('active');
  if (el.ccLanguageList) el.ccLanguageList.innerHTML = '';
  if (el.ccTrackList) el.ccTrackList.innerHTML = '';
  if (el.ccTrackSectionTitle) el.ccTrackSectionTitle.style.display = 'none';
  if (el.qualityList) el.qualityList.innerHTML = '';
  if (el.speedList) el.speedList.innerHTML = '';
  if (el.playerPoster) el.playerPoster.style.display = 'none';
  if (el.seekBar) el.seekBar.value = '0';
  if (el.bufferedBar) el.bufferedBar.style.width = '0%';
  if (el.timeDisplay) el.timeDisplay.textContent = '0:00 / 0:00';
  if (el.ccNote) el.ccNote.textContent = 'اختر لغة الترجمة، وستظهر أثناء التشغيل. الترجمة لا تعمل تلقائياً.';
  updatePlayPauseUI();
}

function openActiveChannelPage() {
  const name = state.playerData?.channel?.name || state.activeVideo?.channel || '';
  const channelId = state.playerData?.channel?.id || state.activeVideo?.channelId || '';
  const avatar = state.playerData?.channel?.avatar || state.activeVideo?.channelAvatar || '';
  if (!name && !channelId) return;
  openChannelPage(name, avatar, channelId);
}

function populateWatchPlaceholder(video) {  const title = video.title || 'جاري تحميل الفيديو...';
  if (el.watchTitle) el.watchTitle.textContent = title;
  if (el.watchViews) el.watchViews.textContent = video.views ? formatViews(video.views) : '';
  if (el.watchDate) el.watchDate.textContent = video.publishedTime || '';
  if (el.watchCategory) el.watchCategory.textContent = '';
  if (el.watchChannel) el.watchChannel.textContent = video.channel || '';
  if (el.watchSubs) el.watchSubs.textContent = '';
  if (el.watchChannelAvatar) {
    el.watchChannelAvatar.onerror = () => {
      if (video.channelAvatar && !el.watchChannelAvatar.src.includes('/api/image-proxy')) {
        el.watchChannelAvatar.src = `/api/image-proxy?url=${encodeURIComponent(video.channelAvatar)}`;
      } else {
        el.watchChannelAvatar.src = getFallbackAvatar(video.channel);
      }
    };
    el.watchChannelAvatar.src = avatarSource(video.channel, video.channelAvatar);
  }
  if (el.descStats) el.descStats.textContent = '';
  if (el.watchDescription) {
    el.watchDescription.textContent = video.description || '';
    el.watchDescription.classList.add('collapsed');
  }
  if (el.descToggleBtn) el.descToggleBtn.style.display = 'none';
  if (el.likeCount) el.likeCount.textContent = '0';
  el.likeBtn?.classList.remove('active');
  el.dislikeBtn?.classList.remove('active');
  document.title = `${title} - AYTube`;
  updateFavoriteUI();
}

const clientPlayerCache = new Map();
const clientPlayerInflight = new Map();
const CLIENT_PLAYER_TTL = 8 * 60 * 1000;

function getCachedPlayerPayload(videoId) {
  const hit = clientPlayerCache.get(videoId);
  if (hit && Date.now() - hit.at < CLIENT_PLAYER_TTL) return hit.data;
  return null;
}

async function fetchPlayerPayload(videoId, { refresh = false, signal } = {}) {
  if (!refresh) {
    const hit = getCachedPlayerPayload(videoId);
    if (hit) return hit;
    if (clientPlayerInflight.has(videoId)) return clientPlayerInflight.get(videoId);
  }

  const query = new URLSearchParams({ v: videoId });
  if (refresh) query.set('refresh', '1');
  const job = fetch(`/api/player?${query.toString()}`, signal ? { signal } : undefined)
    .then(async (res) => {
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.success || !data.video) {
        throw new Error(data?.error || `تعذر جلب بيانات الفيديو (HTTP ${res.status})`);
      }
      if (clientPlayerCache.size > 40) {
        const oldest = clientPlayerCache.keys().next().value;
        clientPlayerCache.delete(oldest);
      }
      clientPlayerCache.set(videoId, { data, at: Date.now() });
      return data;
    });

  if (!signal) {
    clientPlayerInflight.set(videoId, job);
    job.finally(() => clientPlayerInflight.delete(videoId)).catch(() => {});
  }
  return job;
}

function prefetchPlayer(videoId) {
  if (!videoId || getCachedPlayerPayload(videoId) || clientPlayerInflight.has(videoId)) return;
  fetchPlayerPayload(videoId).catch(() => {});
}

async function loadPlayer(videoId, options = {}) {
  const requestId = ++state.playerRequestId;
  state.playerAbort?.abort();
  const controller = new AbortController();
  state.playerAbort = controller;
  if (!options.refresh) state.streamRetryCount = 0;

  hidePlayerError();

  try {
    const cached = !options.refresh ? getCachedPlayerPayload(videoId) : null;
    const data = cached || await fetchPlayerPayload(videoId, { refresh: !!options.refresh, signal: controller.signal });

    if (requestId !== state.playerRequestId) return;

    const card = normalizeVideoCard({
      ...data.video,
      channel: data.channel?.name || '',
      channelAvatar: data.channel?.avatar || '',
      views: data.video.viewCount,
      publishedTime: formatWatchDate(data.video.publishDate || data.video.uploadDate),
      thumbnail: data.video.thumbnail,
      duration: formatDuration(data.video.lengthSeconds)
    });
    state.activeVideo = { ...card, description: data.video.description || '' };

    // Auto-launch YouTube-style Vertical Shorts Player for portrait Shorts videos (<= 3m)
    if (!options.forceNormalPlayer && ((data.video.isPortrait && data.video.lengthSeconds > 0 && data.video.lengthSeconds <= 180) || card.isShort)) {
      openShortsView(state.activeVideo, [state.activeVideo, ...(data.related || []).slice(0, 15)], data);
      return;
    }

    state.playerData = data;
    state.qualities = data.qualities || [];
    state.duration = Number(data.video.lengthSeconds) || 0;

    populateWatchDetails(data);
    setupQualityList();
    setupSpeedList();
    renderCaptionMenus();
    renderRelated(data.related || []);
    updateMediaSession();

    // المشغل المباشر HTML5 هو المشغل الرئيسي والوحيد
    switchToDirectStreamPlayer(data);

    if (data.comments?.countText && el.commentsCount) {
      state.commentsCountText = data.comments.countText;
      updateCommentsCount();
    }

    addToHistory(state.activeVideo);
    document.title = `${data.video.title} - AYTube`;
    updateFavoriteUI();
    updateSubscribeUI();
    updateLikeUI();
    loadVideoState(data.video.id);
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (requestId !== state.playerRequestId) return;
    console.error('Player load error:', error);
    showPlayerError(
      'تعذر تشغيل هذا الفيديو',
      String(error.message || 'حدث خطأ غير متوقع أثناء تجهيز الفيديو.').slice(0, 220)
    );
  } finally {
    if (requestId === state.playerRequestId) state.playerAbort = null;
  }
}

function switchToDirectStreamPlayer(data) {
  state.activePlayerType = 'stream';
  if (el.videoEl) {
    el.videoEl.style.display = 'block';
  }
  if (el.playerControls) {
    el.playerControls.style.display = 'block';
  }
  const quality = chooseInitialQuality(data);
  if (quality) {
    applyMediaSources(data, quality, { autoplay: state.autoplay });
  } else {
    showPlayerError('تعذر العثور على جودة مناسبة لهذا الفيديو', 'يرجى المحاولة لاحقاً');
  }
}

function chooseInitialQuality(data) {
  const qualities = Array.isArray(data?.qualities) ? data.qualities : [];
  if (!qualities.length) return null;

  if (state.prefQuality !== 'auto') {
    const preferred = qualities.find((quality) => String(quality.height) === String(state.prefQuality));
    if (preferred) return preferred;
  }

  return qualities.find((quality) => String(quality.itag) === String(data.defaultQualityItag))
    || qualities.find((quality) => Number(quality.height) === 720)
    || [...qualities].reverse().find((quality) => Number(quality.height) <= 1080)
    || qualities[qualities.length - 1];
}

function applyMediaSources(data, quality, options = {}) {
  if (!el.videoEl || !quality) return;

  state.pendingAutoplay = !!options.autoplay;
  state.qualitySwitchPending = false;
  state.switchingQuality = false;
  state.selectedQualityItag = quality.itag;

  el.videoEl.pause();
  el.videoEl.muted = true;
  el.videoEl.controls = false;
  el.videoEl.preload = 'auto';
  el.videoEl.setAttribute('poster', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
  if (el.playerPoster) {
    const poster = options.autoplay === false ? (data.video?.thumbnail || state.activeVideo?.thumbnail || '') : '';
    el.playerPoster.style.backgroundImage = poster ? `url("${poster}")` : '';
    el.playerPoster.style.display = poster ? 'block' : 'none';
  }
  el.videoEl.src = quality.url;
  el.videoEl.load();

  if (data.audio?.url) {
    el.audioEl.src = data.audio.url;
    el.audioEl.volume = state.volume;
    el.audioEl.muted = state.muted;
    el.audioEl.playbackRate = state.speed;
    el.audioEl.preload = 'auto';
    el.audioEl.load();
  } else {
    el.audioEl.removeAttribute('src');
    el.audioEl.load();
    showPlayerToast('هذا الفيديو لا يحتوي على مسار صوتي منفصل');
  }

  // Defer seek preview loading so it never steals initial bandwidth from main video/audio
  if (el.seekPreviewVideo) {
    const previewQ = (data.qualities || []).find(q => q.height <= 360) || quality;
    if (previewQ && previewQ.url) {
      el.seekPreviewVideo.dataset.pendingSrc = previewQ.url;
    }
  }

  el.videoEl.playbackRate = state.speed;
  if (el.seekBar) el.seekBar.value = '0';
  if (el.bufferedBar) el.bufferedBar.style.width = '0%';
  updateTimeDisplay(0);
  updateQualityList();

  if (options.autoplay !== false) {
    let started = false;
    const startPlayback = () => {
      if (started) return;
      started = true;
      if (el.playerPoster) el.playerPoster.style.display = 'none';
      playMedia().catch(() => {});
    };
    if (el.videoEl.readyState >= 2) {
      startPlayback();
    } else {
      el.videoEl.addEventListener('loadeddata', startPlayback, { once: true });
      el.videoEl.addEventListener('canplay', startPlayback, { once: true });
    }
  }
}

async function playMedia() {
  if (!el.videoEl || !state.playerData) return;
  if (state.isBackground) return;

  if (el.videoEl.ended || (state.duration && el.videoEl.currentTime >= state.duration - 0.15)) {
    el.videoEl.currentTime = 0;
    if (el.audioEl) el.audioEl.currentTime = 0;
  }

  try {
    await el.videoEl.play();
  } catch (error) {
    if (error && error.name === 'NotAllowedError') {
      showPlayerToast('اضغط على الشاشة لبدء تشغيل الفيديو');
    } else if (error && error.name !== 'AbortError') {
      console.warn('Video play error:', error);
    }
    updatePlayPauseUI();
    return;
  }

  if (el.audioEl && el.audioEl.getAttribute('src')) {
    try {
      el.audioEl.muted = state.muted;
      el.audioEl.volume = state.volume;
      await el.audioEl.play();
    } catch (error) {
      if (error && error.name === 'NotAllowedError') {
        const resumeAudio = () => {
          if (!state.playerData || !el.audioEl?.getAttribute('src')) return;
          el.audioEl.muted = state.muted;
          el.audioEl.volume = state.volume;
          el.audioEl.play().catch(() => {});
        };
        document.addEventListener('pointerdown', resumeAudio, { once: true });
      }
    }
  }

  syncAudioClock(true);
  showControls();
}

function pauseMedia() {
  if (el.videoEl) el.videoEl.pause();
  if (el.audioEl) el.audioEl.pause();
  updatePlayPauseUI();
}

function togglePlay() {
  if (!state.playerData) return;
  if (el.videoEl && !el.videoEl.paused) {
    pauseMedia();
  } else {
    playMedia();
  }
}

function onVideoMetadata() {
  if (!state.playerData || !el.videoEl) return;
  state.switchingQuality = false;

  const vw = el.videoEl.videoWidth || 0;
  const vh = el.videoEl.videoHeight || 0;
  const duration = Number(el.videoEl.duration);
  if (Number.isFinite(duration) && duration > 0) state.duration = duration;

  if (vw > 0 && vh > vw) {
    if (state.duration > 0 && state.duration <= 180) {
      const vData = state.playerData;
      const vCard = state.activeVideo || { id: vData.video?.id, isShort: true };
      openShortsView(vCard, [vCard, ...(vData.related || []).slice(0, 15)], vData, { skipPush: false });
      return;
    } else if (el.playerShell) {
      el.playerShell.style.aspectRatio = `${vw} / ${vh}`;
      el.playerShell.style.maxHeight = '80vh';
      el.playerShell.style.width = 'auto';
      el.playerShell.style.margin = '0 auto';
    }
  } else if (el.playerShell) {
    el.playerShell.style.aspectRatio = '16 / 9';
    el.playerShell.style.maxHeight = '';
    el.playerShell.style.width = '100%';
    el.playerShell.style.margin = '';
  }

  updateTimeDisplay(el.videoEl.currentTime);
  updateSeekBar(el.videoEl.currentTime);

  if (state.qualitySwitchPending) {
    const target = Number(state.pendingQualityTime) || 0;
    const shouldPlay = !!state.pendingQualityPlay;
    seekTo(target);
    state.qualitySwitchPending = false;
    state.pendingQualityPlay = false;
    if (shouldPlay) playMedia();
    return;
  }

  updatePlayPauseUI();
}

function onAudioLoadedMetadata() {
  if (!el.audioEl || !el.videoEl || !state.playerData) return;
  if (state.qualitySwitchPending || state.isBackground) return;
  if (Math.abs(el.audioEl.currentTime - el.videoEl.currentTime) > 0.5) {
    el.audioEl.currentTime = el.videoEl.currentTime;
  }
}

function onVideoTimeUpdate() {
  if (!el.videoEl) return;
  const current = el.videoEl.currentTime || 0;
  updateTimeDisplay(current);
  if (!state.seeking) updateSeekBar(current);
  updateBufferedBar();
  updateCaptionOverlay(current);
  syncAudioClock(false);
}

function syncNativePlaybackMeta(playing) {
  try {
    if (!window.AYTubeNative?.syncPlaybackState) return;
    const vid = state.activeVideo?.id || '';
    const title = state.activeVideo?.title || 'AYTube';
    const ch = state.playerData?.channel?.name || state.activeVideo?.channel || 'AYTube';
    const durMs = Math.round((state.duration || 0) * 1000);
    const posEl = state.isBackground ? el.audioEl : el.videoEl;
    const posMs = Math.round(((posEl && posEl.currentTime) || 0) * 1000);
    window.AYTubeNative.syncPlaybackState(!!isProActive(), !!state.isBackground, !!state.allowExternalPip, !!playing, title, ch, vid, posMs, durMs);
  } catch {}
}

function onVideoPlay() {
  state.isPlaying = true;
  if (el.playerShell) el.playerShell.classList.add('is-playing');
  if (el.playerPoster) el.playerPoster.style.display = 'none';
  hidePlayerLoading();
  updatePlayPauseUI();
  if (!state.isBackground && !state.switchingQuality) syncAudioClock(true);
  showControls();
  scheduleControlsHide();
  syncNativePlaybackMeta(true);
}

function onVideoPause() {
  state.isPlaying = false;
  if (!state.switchingQuality && !state.isBackground) {
    el.audioEl?.pause();
  }
  updatePlayPauseUI();
  showControls();
  syncNativePlaybackMeta(false);
}

function onVideoPlaying() {
  hidePlayerLoading();
  state.isPlaying = true;
  if (el.playerShell) el.playerShell.classList.add('is-playing');
  if (el.playerPoster) el.playerPoster.style.display = 'none';
  updatePlayPauseUI();
  syncAudioClock(true);
  // Lazy-load seek preview stream gently after main playback is underway
  if (el.seekPreviewVideo && el.seekPreviewVideo.dataset.pendingSrc && !el.seekPreviewVideo.getAttribute('src')) {
    const srcUrl = el.seekPreviewVideo.dataset.pendingSrc;
    setTimeout(() => {
      if (state.isPlaying && el.seekPreviewVideo && el.seekPreviewVideo.dataset.pendingSrc === srcUrl && !el.seekPreviewVideo.getAttribute('src')) {
        el.seekPreviewVideo.src = srcUrl;
        el.seekPreviewVideo.preload = 'metadata';
        el.seekPreviewVideo.load();
      }
    }, 900);
  }
}

function onVideoCanPlay() {
  hidePlayerLoading();
  updatePlayPauseUI();
}

function onVideoWaiting() {
  // Silent smooth buffering without blocking overlay
}

function onVideoEnded() {
  if (state.isLooping && el.videoEl) {
    seekTo(0);
    playMedia();
    return;
  }
  state.isPlaying = false;
  updatePlayPauseUI();
  showControls();
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.playbackState = 'paused'; } catch { /* ignore */ }
  }
}

function onVideoError() {
  if (!state.playerData || !el.videoEl) return;
  if (!el.videoEl.currentSrc && !el.videoEl.getAttribute('src')) return;

  // YouTube stream URLs expire. Refresh the player payload once automatically.
  if (state.activeVideo?.id && (state.streamRetryCount || 0) < 1) {
    state.streamRetryCount = 1;
    showPlayerLoading(true, 'انتهت صلاحية الرابط، جارٍ تحديث الفيديو...');
    loadPlayer(state.activeVideo.id, { refresh: true, autoplay: true });
    return;
  }

  showPlayerError(
    'تعذر تشغيل هذا الفيديو',
    'قد يكون رابط الفيديو منتهي الصلاحية أو الصيغة غير مدعومة. اضغط إعادة المحاولة أو اختر جودة أخرى.'
  );
}

function onAudioError() {
  if (!state.playerData || !el.audioEl) return;
  if (!el.audioEl.getAttribute('src')) return;
  showPlayerToast('تعذر تحميل المسار الصوتي. جرّب إعادة المحاولة أو جودة أخرى.');
}

let seekDebounceTimer = null;
function onSeekInput() {
  if (!el.seekBar) return;
  state.seeking = true;
  const ratio = Number(el.seekBar.value) / 1000;
  const target = ratio * (state.duration || 0);
  const pct = (ratio * 100).toFixed(2);
  el.seekBar.style.background = `linear-gradient(to right, #ff0000 0%, #ff0000 ${pct}%, rgba(255, 255, 255, 0.28) ${pct}%, rgba(255, 255, 255, 0.28) 100%)`;
  updateTimeDisplay(target);

  if (seekDebounceTimer) clearTimeout(seekDebounceTimer);
  seekDebounceTimer = setTimeout(() => {
    seekTo(target, { updateSlider: false });
    state.seeking = false;
  }, 75);
}

function seekTo(time, options = {}) {
  const duration = state.duration || Number(el.videoEl?.duration) || 0;
  const target = clamp(Number(time) || 0, 0, Math.max(0, duration - 0.05));
  if (el.videoEl) el.videoEl.currentTime = target;
  if (el.audioEl) el.audioEl.currentTime = target;
  if (options.updateSlider !== false) updateSeekBar(target);
  updateTimeDisplay(target);
}

function updateTimeDisplay(current) {
  if (!el.timeDisplay) return;
  const currentTime = Number.isFinite(Number(current))
    ? Number(current)
    : (el.videoEl?.currentTime || 0);
  const duration = state.duration || Number(el.videoEl?.duration) || 0;
  el.timeDisplay.textContent = `${formatDuration(currentTime)} / ${formatDuration(duration)}`;
}

function updateSeekBar(current) {
  if (!el.seekBar) return;
  const duration = state.duration || 0;
  if (!duration) {
    el.seekBar.value = '0';
    el.seekBar.style.background = 'rgba(255, 255, 255, 0.28)';
    return;
  }
  const ratio = clamp(current / duration, 0, 1);
  const pct = (ratio * 100).toFixed(2);
  el.seekBar.value = String(Math.round(ratio * 1000));
  el.seekBar.style.background = `linear-gradient(to right, #ff0000 0%, #ff0000 ${pct}%, rgba(255, 255, 255, 0.28) ${pct}%, rgba(255, 255, 255, 0.28) 100%)`;
}

function updateBufferedBar() {
  if (!el.bufferedBar || !el.videoEl) return;
  const duration = state.duration || el.videoEl.duration || 0;
  if (!duration || !el.videoEl.buffered.length) {
    el.bufferedBar.style.width = '0%';
    return;
  }
  const end = el.videoEl.buffered.end(el.videoEl.buffered.length - 1);
  el.bufferedBar.style.width = `${clamp((end / duration) * 100, 0, 100)}%`;
}

function syncAudioClock(force) {
  if (!el.videoEl || !el.audioEl || !state.playerData || state.isBackground) return;
  if (!el.audioEl.getAttribute('src') || el.videoEl.paused) return;

  const vTime = el.videoEl.currentTime || 0;
  // Prevent jarring seeks during the first 2 seconds of playback to eliminate stutter
  if (!force && vTime < 2.0) {
    if (el.audioEl.paused) el.audioEl.play().catch(() => {});
    return;
  }

  if (el.audioEl.readyState >= 2) {
    const drift = Math.abs(el.audioEl.currentTime - vTime);
    if (force || drift > 0.8) {
      el.audioEl.currentTime = vTime;
      el.audioEl.playbackRate = state.speed;
    } else if (drift > 0.15) {
      // Gentle micro-adjustment via speed modulation instead of buffer flush
      const audioBehind = el.audioEl.currentTime < vTime;
      el.audioEl.playbackRate = state.speed * (audioBehind ? 1.04 : 0.96);
    } else {
      el.audioEl.playbackRate = state.speed;
    }
  }

  if (el.audioEl.paused) {
    el.audioEl.play().catch(() => { /* autoplay policy */ });
  }
}

function setVolume(value) {
  const volume = clamp(Number(value) || 0, 0, 1);
  state.volume = volume;
  if (el.audioEl) {
    el.audioEl.volume = volume;
    el.audioEl.muted = volume === 0 ? true : state.muted;
  }
  if (el.videoEl) el.videoEl.volume = 0;
  if (volume > 0 && state.muted) {
    state.muted = false;
    if (el.audioEl) el.audioEl.muted = false;
    try { localStorage.setItem('pb_muted', 'false'); } catch { /* ignore */ }
  }
  try { localStorage.setItem('pb_volume', String(volume)); } catch { /* ignore */ }
  if (el.volumeBar) el.volumeBar.value = String(volume);
  updateVolumeUI();
}

function toggleMute() {
  state.muted = !state.muted;
  if (el.audioEl) el.audioEl.muted = state.muted;
  try { localStorage.setItem('pb_muted', String(state.muted)); } catch { /* ignore */ }
  updateVolumeUI();
}

function updateVolumeUI() {
  const vol = state.muted ? 0 : state.volume;
  const pct = Math.round(vol * 100);
  if (el.volumeBar) {
    el.volumeBar.value = String(state.volume);
    el.volumeBar.style.background = `linear-gradient(to right, #ffffff 0%, #ffffff ${pct}%, rgba(255, 255, 255, 0.28) ${pct}%, rgba(255, 255, 255, 0.28) 100%)`;
  }
  const silent = state.muted || state.volume === 0;
  if (el.muteSvg) {
    const path = el.muteSvg.querySelector('path') || el.muteSvg;
    path.setAttribute('d', silent ? MUTED_PATH : VOLUME_PATH);
  }
  if (el.muteBtn) el.muteBtn.title = silent ? 'إلغاء كتم الصوت' : 'كتم الصوت';
}

function updatePlayPauseUI() {
  const playing = !!el.videoEl && !el.videoEl.paused && !el.videoEl.ended;
  state.isPlaying = playing;
  if (el.playerShell) el.playerShell.classList.toggle('is-playing', playing);

  if (el.playPauseSvg) {
    const path = el.playPauseSvg.querySelector('path');
    if (path) path.setAttribute('d', playing ? ICON_PAUSE : ICON_PLAY);
    else el.playPauseSvg.innerHTML = `<path d="${playing ? ICON_PAUSE : ICON_PLAY}"/>`;
  }

  const errorVisible = el.playerError && el.playerError.style.display !== 'none';
  if (el.bigPlayBtn) {
    el.bigPlayBtn.classList.toggle('visible', !!state.playerData && !playing && !errorVisible);
  }

  if (playing) {
    scheduleControlsHide();
  } else {
    clearTimeout(state.controlsHideTimer);
    el.playerShell?.classList.remove('controls-hidden');
  }

  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch { /* ignore */ }
  }
}

function showControls() {
  el.playerShell?.classList.remove('controls-hidden');
  clearTimeout(state.controlsHideTimer);
  if (state.isPlaying && !isAnyPlayerMenuOpen()) scheduleControlsHide();
}

function scheduleControlsHide(delay = 2800) {
  clearTimeout(state.controlsHideTimer);
  state.controlsHideTimer = setTimeout(() => {
    if (state.isPlaying && !isAnyPlayerMenuOpen()) {
      el.playerShell?.classList.add('controls-hidden');
    }
  }, delay);
}

function isAnyPlayerMenuOpen() {
  return (el.ccMenu && el.ccMenu.style.display === 'block')
    || (el.settingsMenu && el.settingsMenu.style.display === 'block');
}

function toggleCCMenu() {
  if (!el.ccMenu) return;
  const opening = el.ccMenu.style.display !== 'block';
  closeSettingsMenu();
  el.ccMenu.style.display = opening ? 'block' : 'none';
  if (opening) {
    renderCaptionMenus();
    showControls();
  }
}

function closeCCMenu() {
  if (el.ccMenu) el.ccMenu.style.display = 'none';
  showControls();
}

function toggleSettingsMenu() {
  if (!el.settingsMenu) return;
  const opening = el.settingsMenu.style.display !== 'block';
  closeCCMenu();
  el.settingsMenu.style.display = opening ? 'block' : 'none';
  if (opening) {
    setupQualityList();
    setupSpeedList();
    showControls();
  }
}

function closeSettingsMenu() {
  if (el.settingsMenu) el.settingsMenu.style.display = 'none';
  showControls();
}

function closePlayerMenus() {
  if (el.ccMenu) el.ccMenu.style.display = 'none';
  if (el.settingsMenu) el.settingsMenu.style.display = 'none';
}

function showPlayerLoading(show, text) {
  if (!el.playerLoading) return;
  const label = el.playerLoading.querySelector('span');
  if (text && label) label.textContent = text;
  el.playerLoading.style.display = show ? 'flex' : 'none';
  el.playerLoading.classList.toggle('hidden', !show);
}

function hidePlayerLoading() {
  showPlayerLoading(false);
}

function showPlayerError(title, subtitle) {
  if (el.playerErrorTitle) el.playerErrorTitle.textContent = title || 'تعذر تشغيل هذا الفيديو';
  if (el.playerErrorSub) el.playerErrorSub.textContent = subtitle || 'حاول مرة أخرى أو اختر فيديو آخر.';
  if (el.playerError) el.playerError.style.display = 'flex';
  hidePlayerLoading();
  if (el.bigPlayBtn) el.bigPlayBtn.classList.remove('visible');
  updatePlayPauseUI();
}

function hidePlayerError() {
  if (el.playerError) el.playerError.style.display = 'none';
}

function showPlayerToast(message, duration = 2400) {
  if (!el.playerToast) return;
  el.playerToast.textContent = message;
  el.playerToast.classList.add('show');
  clearTimeout(playerToastTimer);
  playerToastTimer = setTimeout(() => el.playerToast.classList.remove('show'), duration);
}

async function toggleFullscreen() {
  if (!el.playerShell) return;
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (el.playerShell.requestFullscreen) {
      await el.playerShell.requestFullscreen();
    } else if (el.playerShell.webkitRequestFullscreen) {
      el.playerShell.webkitRequestFullscreen();
    }
  } catch {
    showPlayerToast('تعذر تفعيل ملء الشاشة');
  }
}

function updateFullscreenUI() {
  const fullscreen = !!document.fullscreenElement;
  if (el.fullscreenSvg) {
    const path = el.fullscreenSvg.querySelector('path');
    if (path) path.setAttribute('d', fullscreen ? FULLSCREEN_EXIT : FULLSCREEN_ENTER);
  }
  if (el.fullscreenBtn) {
    el.fullscreenBtn.title = fullscreen ? 'الخروج من ملء الشاشة' : 'ملء الشاشة';
  }
}

/* ============================================================
 * Watch details and actions
 * ============================================================ */
function populateWatchDetails(data) {
  const video = data.video || {};
  const channel = data.channel || {};
  const dateText = formatWatchDate(video.publishDate || video.uploadDate);

  if (el.watchTitle) el.watchTitle.textContent = video.title || 'بدون عنوان';
  if (el.watchViews) el.watchViews.textContent = video.viewCount ? formatViews(video.viewCount) : '';
  if (el.watchDate) el.watchDate.textContent = dateText;
  if (el.watchCategory) el.watchCategory.textContent = video.category || '';

  if (el.watchChannel) {
    el.watchChannel.textContent = channel.name || '';
    if (channel.verified) {
      const badge = document.createElement('span');
      badge.className = 'verified-badge';
      badge.textContent = '✔︎';
      badge.title = 'قناة موثقة';
      el.watchChannel.appendChild(badge);
    }
  }

  if (el.watchChannelAvatar) {
    el.watchChannelAvatar.onerror = () => {
      if (channel.avatar && !el.watchChannelAvatar.src.includes('/api/image-proxy')) {
        el.watchChannelAvatar.src = `/api/image-proxy?url=${encodeURIComponent(channel.avatar)}`;
      } else {
        el.watchChannelAvatar.src = getFallbackAvatar(channel.name);
      }
    };
    el.watchChannelAvatar.src = avatarSource(channel.name, channel.avatar);
    el.watchChannelAvatar.alt = channel.name || 'شعار القناة';
  }

  if (el.watchSubs) {
    el.watchSubs.textContent = channel.subscribers
      ? `${compactNumber(channel.subscribers)} مشترك`
      : 'قناة على YouTube';
  }

  if (el.descStats) {
    el.descStats.textContent = [
      video.viewCount ? formatViews(video.viewCount) : '',
      dateText,
      video.category || ''
    ].filter(Boolean).join(' • ');
  }

  if (el.watchDescription) {
    el.watchDescription.textContent = video.description || 'لا يوجد وصف لهذا الفيديو.';
    el.watchDescription.classList.add('collapsed');
  }

  if (el.descToggleBtn) {
    const longDescription = String(video.description || '').length > 220;
    el.descToggleBtn.style.display = longDescription ? '' : 'none';
    el.descToggleBtn.textContent = 'عرض المزيد';
  }

  updateSubscribeUI();
  updateLikeUI();
  updateFavoriteUI();
}

function updateLikeUI() {
  const id = state.activeVideo?.id;
  const serverState = id ? state.videoState[id] : null;
  const reaction = serverState?.reaction || (id ? state.likes[id] : null) || null;
  el.likeBtn?.classList.toggle('active', reaction === 'like');
  el.dislikeBtn?.classList.toggle('active', reaction === 'dislike');

  if (el.likeCount) {
    const base = Number(state.playerData?.video?.likes) || 0;
    const localLikes = Number(serverState?.likes) || 0;
    const value = base + localLikes;
    el.likeCount.textContent = value > 0 ? compactNumber(value) : (reaction === 'like' ? '1' : '0');
  }
}

async function loadVideoState(videoId) {
  if (!videoId) return;
  const channelId = state.playerData?.channel?.id || '';
  const channelName = state.playerData?.channel?.name || state.activeVideo?.channel || '';
  try {
    const params = new URLSearchParams({ v: videoId });
    if (channelId) params.set('channelId', channelId);
    if (channelName) params.set('channelName', channelName);
    const response = await fetch(`/api/video-state?${params.toString()}`, { cache: 'no-store' });
    const data = await response.json().catch(() => null);
    if (state.activeVideo?.id !== videoId) return;
    if (!response.ok || !data?.success) return;

    state.videoState[videoId] = data;
    if (data.reaction) state.likes[videoId] = data.reaction;
    else delete state.likes[videoId];
    updateLikeUI();
    updateSubscribeUI();
  } catch {
    /* non-critical */
  }
}

async function setReaction(mode) {
  if (!state.activeVideo?.id) return;
  if (!state.currentUser) {
    showToast('سجّل الدخول لتتمكن من الإعجاب بالفيديوهات');
    openAuthModal();
    return;
  }

  const id = state.activeVideo.id;
  const previous = state.videoState[id] || {};
  const current = previous.reaction || state.likes[id] || null;
  const next = current === mode ? null : mode;

  // Optimistic UI
  state.videoState[id] = {
    ...previous,
    reaction: next,
    likes: Math.max(0, (Number(previous.likes) || 0) + (next === 'like' ? 1 : 0) - (current === 'like' ? 1 : 0)),
    dislikes: Math.max(0, (Number(previous.dislikes) || 0) + (next === 'dislike' ? 1 : 0) - (current === 'dislike' ? 1 : 0))
  };
  if (next) state.likes[id] = next;
  else delete state.likes[id];
  updateLikeUI();

  try {
    const response = await fetch('/api/video-react', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: id, reaction: next })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) throw new Error(data?.error || 'تعذر حفظ الإعجاب');
    state.videoState[id] = {
      ...(state.videoState[id] || {}),
      reaction: data.reaction,
      likes: Number(data.likes) || 0,
      dislikes: Number(data.dislikes) || 0
    };
    if (data.reaction) state.likes[id] = data.reaction;
    else delete state.likes[id];
  } catch (error) {
    state.videoState[id] = previous;
    showToast(error.message || 'تعذر حفظ الإعجاب');
  }
  updateLikeUI();
}

function updateSubscribeUI() {
  const channel = state.playerData?.channel?.name || state.activeVideo?.channel || '';
  const channelId = state.playerData?.channel?.id || '';
  const subscribed = isSubscribed(channel, channelId);
  if (el.subBtn) {
    el.subBtn.classList.toggle('subscribed', subscribed);
    el.subBtn.textContent = subscribed ? 'مشترك' : 'اشتراك';
    el.subBtn.disabled = false;
  }
  if (el.watchSubs && state.playerData?.channel?.subscribers) {
    const delta = Number(state.videoState[state.activeVideo?.id]?.subscriberDelta) || 0;
    el.watchSubs.textContent = `${compactNumber(Number(state.playerData.channel.subscribers) + delta)} مشترك`;
  }
}

async function toggleSubscription() {
  if (!state.currentUser) {
    showToast('سجّل الدخول للاشتراك في القنوات');
    openAuthModal();
    return;
  }

  const channel = state.playerData?.channel?.name || state.activeVideo?.channel;
  const channelId = state.playerData?.channel?.id || '';
  if (!channel && !channelId) return;

  if (el.subBtn) {
    el.subBtn.disabled = true;
    el.subBtn.textContent = '...';
  }

  try {
    const response = await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId,
        channelName: channel,
        channelAvatar: state.playerData?.channel?.avatar || state.activeVideo?.channelAvatar || ''
      })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) throw new Error(data?.error || 'تعذر تحديث الاشتراك');

    state.subscriptions = Array.isArray(data.subscriptions) ? data.subscriptions : state.subscriptions;
    saveSubscriptions();
    if (state.activeVideo?.id) {
      state.videoState[state.activeVideo.id] = {
        ...(state.videoState[state.activeVideo.id] || {}),
        isSubscribed: !!data.subscribed
      };
    }
    updateSubscribeUI();
    showToast(data.subscribed ? `تم الاشتراك في ${channel} 🔔` : `تم إلغاء الاشتراك من ${channel}`);
  } catch (error) {
    showToast(error.message || 'تعذر تحديث الاشتراك');
    updateSubscribeUI();
  }
}

function toggleDescription() {
  if (!el.watchDescription) return;
  const collapsed = el.watchDescription.classList.toggle('collapsed');
  if (el.descToggleBtn) el.descToggleBtn.textContent = collapsed ? 'عرض المزيد' : 'عرض أقل';
}

function updateTheaterButton() {
  if (!el.theaterBtn) return;
  el.theaterBtn.classList.toggle('active', state.theater);
  el.theaterBtn.title = state.theater ? 'الخروج من وضع المسرح' : 'وضع المسرح';
}

function setTheater(enabled) {
  state.theater = !!enabled;
  el.watchLayout?.classList.toggle('theater-mode', state.theater);
  if (el.desktopModeCheckbox) el.desktopModeCheckbox.checked = state.theater;
  state.desktop = state.theater;
  try { localStorage.setItem('pb_desktop', String(state.theater)); } catch { /* ignore */ }
  updateTheaterButton();
}

function toggleFavoriteCurrent() {
  if (!state.activeVideo?.id) return;
  const id = state.activeVideo.id;
  if (isFavorite(id)) {
    state.favorites = state.favorites.filter((video) => video.id !== id);
    showToast('تمت إزالة الفيديو من المفضلة');
  } else {
    state.favorites.unshift(normalizeVideoCard({
      ...state.activeVideo,
      views: state.playerData?.video?.viewCount,
      publishedTime: formatWatchDate(
        state.playerData?.video?.publishDate || state.playerData?.video?.uploadDate
      ),
      duration: state.playerData?.video?.lengthSeconds != null
        ? formatDuration(state.playerData.video.lengthSeconds)
        : state.activeVideo.duration
    }));
    showToast('تمت إضافة الفيديو إلى المفضلة ⭐');
  }
  saveFavorites();
  updateFavoriteUI();
}

function updateFavoriteUI() {
  const favorite = !!state.activeVideo?.id && isFavorite(state.activeVideo.id);
  if (el.favStarSvg) {
    el.favStarSvg.setAttribute('fill', favorite ? 'currentColor' : 'none');
    el.favStarSvg.style.color = favorite ? '#ffd54f' : '';
  }
  if (el.favTitleText) el.favTitleText.textContent = favorite ? 'في المفضلة' : 'مفضل';
}

/* ============================================================
 * Quality + speed
 * ============================================================ */
function setupQualityList() {
  if (!el.qualityList) return;
  el.qualityList.innerHTML = '';

  const autoItem = createPcItem({
    label: 'تلقائي',
    active: state.autoQuality,
    attrs: { 'data-itag': 'auto' },
    tag: 'موصى به'
  });
  el.qualityList.appendChild(autoItem);

  const qualities = [...(state.qualities || [])].sort((a, b) => Number(b.height) - Number(a.height));
  qualities.forEach((quality) => {
    const label = quality.label || `${quality.height}p`;
    const tag = Number(quality.height) >= 2160 ? '4K'
      : Number(quality.height) >= 1440 ? '2K'
        : Number(quality.height) >= 1080 ? 'HD'
          : quality.fps > 30 ? `${quality.fps}fps` : '';
    const item = createPcItem({
      label,
      active: !state.autoQuality && String(quality.itag) === String(state.selectedQualityItag),
      attrs: { 'data-itag': String(quality.itag) },
      tag
    });
    el.qualityList.appendChild(item);
  });
}

function setupSpeedList() {
  if (!el.speedList) return;
  el.speedList.innerHTML = '';
  [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].forEach((speed) => {
    const label = speed === 1 ? 'عادي' : `${speed}x`;
    const item = createPcItem({
      label,
      active: Math.abs(state.speed - speed) < 0.001,
      attrs: { 'data-speed': String(speed) }
    });
    el.speedList.appendChild(item);
  });
}

function createPcItem({ label, active, attrs = {}, tag = '' }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pc-item';
  Object.entries(attrs).forEach(([name, value]) => button.setAttribute(name, value));

  const check = document.createElement('span');
  check.className = 'pc-check';
  check.textContent = active ? '✓' : '';

  const text = document.createElement('span');
  text.className = 'pc-label';
  text.textContent = label;

  button.appendChild(check);
  button.appendChild(text);

  if (tag) {
    const tagElement = document.createElement('span');
    tagElement.className = 'cc-tag';
    tagElement.textContent = tag;
    button.appendChild(tagElement);
  }
  return button;
}

function selectAutoQuality() {
  if (!state.playerData) return;
  const target = state.qualities.find(
    (quality) => String(quality.itag) === String(state.playerData.defaultQualityItag)
  ) || state.qualities.find((quality) => Number(quality.height) === 720) || state.qualities[0];

  if (!target) return;
  state.autoQuality = true;
  if (String(state.selectedQualityItag) === String(target.itag)) {
    updateQualityList();
    closeSettingsMenu();
    showPlayerToast('الجودة: تلقائي');
    return;
  }
  setQuality(target, { auto: true });
}

function setQuality(quality, options = {}) {
  if (!state.playerData || !el.videoEl || !quality) return;

  state.autoQuality = !!options.auto;
  if (el.videoEl.getAttribute('src') === quality.url) {
    state.selectedQualityItag = quality.itag;
    updateQualityList();
    closeSettingsMenu();
    return;
  }

  const currentTime = el.videoEl.currentTime || 0;
  const wasPlaying = !el.videoEl.paused;
  state.selectedQualityItag = quality.itag;
  state.pendingQualityTime = currentTime;
  state.pendingQualityPlay = wasPlaying;
  state.qualitySwitchPending = true;
  state.switchingQuality = true;
  state.pendingAutoplay = false;

  showPlayerLoading(true, 'جاري تغيير الجودة...');
  el.videoEl.pause();
  el.videoEl.src = quality.url;
  el.videoEl.load();
  updateQualityList();
  closeSettingsMenu();
  showPlayerToast(`الجودة: ${quality.label || `${quality.height}p`}`);
}

function updateQualityList() {
  if (el.qualityList) setupQualityList();
}

function setPlaybackSpeed(speed) {
  const rate = clamp(Number(speed) || 1, 0.25, 2);
  state.speed = rate;
  if (el.videoEl) el.videoEl.playbackRate = rate;
  if (el.audioEl) el.audioEl.playbackRate = rate;
  setupSpeedList();
  closeSettingsMenu();
  showPlayerToast(rate === 1 ? 'السرعة: عادية' : `السرعة: ${rate}x`);
}

/* ============================================================
 * Related videos
 * ============================================================ */
function renderRelatedSkeleton() {
  if (!el.relatedList) return;
  el.relatedList.innerHTML = Array.from({ length: 6 }).map(() => `
    <div class="related-skeleton">
      <div class="rs-thumb"></div>
      <div class="rs-lines">
        <div class="rs-line" style="width:92%"></div>
        <div class="rs-line" style="width:70%"></div>
        <div class="rs-line" style="width:45%"></div>
      </div>
    </div>
  `).join('');
}

function renderRelated(videos) {
  if (!el.relatedList) return;
  el.relatedList.innerHTML = '';

  const list = Array.isArray(videos) ? videos.filter((video) => video && video.id) : [];
  if (!list.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:20px 8px;color:var(--text-secondary);font-size:0.86rem;text-align:center;';
    empty.textContent = 'لا توجد فيديوهات ذات صلة.';
    el.relatedList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  list.forEach((video) => {
    const card = document.createElement('div');
    card.className = 'related-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'related-thumb-wrap';

    const image = document.createElement('img');
    image.className = 'related-thumb';
    image.loading = 'lazy';
    image.alt = video.title || '';
    attachSafeThumbnail(image, video.id, video.thumbnail);
    thumbWrap.appendChild(image);

    const durationText = typeof video.duration === 'number'
      ? formatDuration(video.duration)
      : video.duration;
    if (durationText) {
      const duration = document.createElement('span');
      duration.className = 'related-duration';
      duration.textContent = durationText;
      thumbWrap.appendChild(duration);
    }

    const info = document.createElement('div');
    info.className = 'related-info';

    const title = document.createElement('div');
    title.className = 'related-title';
    title.textContent = video.title || '';

    const channel = document.createElement('div');
    channel.className = 'related-channel';
    channel.textContent = video.channel || '';

    const stats = document.createElement('div');
    stats.className = 'related-stats';
    stats.textContent = video.views ? formatViews(video.views) : '';

    info.appendChild(title);
    info.appendChild(channel);
    info.appendChild(stats);
    card.appendChild(thumbWrap);
    card.appendChild(info);

    const open = () => openWatchView({
      id: video.id,
      title: video.title,
      channel: video.channel,
      channelAvatar: video.channelAvatar,
      duration: durationText,
      views: video.views,
      thumbnail: video.thumbnail
    });
    card.addEventListener('pointerenter', () => prefetchPlayer(video.id), { passive: true });
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
    fragment.appendChild(card);
  });

  el.relatedList.appendChild(fragment);
}

/* ============================================================
 * Media Session
 * ============================================================ */
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const actions = {
    play: () => playMedia(),
    pause: () => pauseMedia(),
    stop: () => pauseMedia(),
    seekbackward: (details) => seekTo((el.videoEl?.currentTime || 0) - (details.seekOffset || 10)),
    seekforward: (details) => seekTo((el.videoEl?.currentTime || 0) + (details.seekOffset || 10)),
    seekto: (details) => seekTo(details.seekTime || 0)
  };
  Object.entries(actions).forEach(([action, handler]) => {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported */ }
  });
}

function updateMediaSession() {
  if (!('mediaSession' in navigator) || !state.playerData) return;
  const video = state.playerData.video || {};
  const channel = state.playerData.channel || {};
  try {
    if (typeof MediaMetadata !== 'undefined') {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: video.title || 'AYTube',
        artist: channel.name || 'AYTube',
        album: 'AYTube',
        artwork: video.thumbnail
          ? [{ src: video.thumbnail, sizes: '512x512', type: 'image/jpeg' }]
          : []
      });
    }
    navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
  } catch {
    /* ignore */
  }
}

/* ============================================================
 * Captions + on-demand translation
 * ============================================================ */
const TRANSLATION_LANGUAGES = [
  { code: 'ar', name: 'العربية' },
  { code: 'en', name: 'الإنجليزية' },
  { code: 'fr', name: 'الفرنسية' },
  { code: 'es', name: 'الإسبانية' },
  { code: 'de', name: 'الألمانية' },
  { code: 'hi', name: 'الهندية' },
  { code: 'ur', name: 'الأردية' },
  { code: 'tr', name: 'التركية' },
  { code: 'fa', name: 'الفارسية' },
  { code: 'pt', name: 'البرتغالية' },
  { code: 'ru', name: 'الروسية' },
  { code: 'it', name: 'الإيطالية' },
  { code: 'nl', name: 'الهولندية' },
  { code: 'id', name: 'الإندونيسية' },
  { code: 'ms', name: 'الماليزية' },
  { code: 'bn', name: 'البنغالية' },
  { code: 'zh-CN', name: 'الصينية (مبسطة)' },
  { code: 'zh-TW', name: 'الصينية (تقليدية)' },
  { code: 'ja', name: 'اليابانية' },
  { code: 'ko', name: 'الكورية' },
  { code: 'sw', name: 'السواحيلية' },
  { code: 'am', name: 'الأمهرية' },
  { code: 'he', name: 'العبرية' },
  { code: 'el', name: 'اليونانية' },
  { code: 'pl', name: 'البولندية' },
  { code: 'uk', name: 'الأوكرانية' },
  { code: 'ro', name: 'الرومانية' },
  { code: 'sv', name: 'السويدية' },
  { code: 'da', name: 'الدنماركية' },
  { code: 'fi', name: 'الفنلندية' },
  { code: 'cs', name: 'التشيكية' },
  { code: 'hu', name: 'الهنغارية' },
  { code: 'vi', name: 'الفيتنامية' },
  { code: 'th', name: 'التايلاندية' },
  { code: 'ta', name: 'التاميلية' },
  { code: 'te', name: 'التيلوغوية' },
  { code: 'ml', name: 'المالايالامية' },
  { code: 'mr', name: 'الماراثية' },
  { code: 'pa', name: 'البنجابية' },
  { code: 'ne', name: 'النيبالية' },
  { code: 'af', name: 'الأفريكانية' },
  { code: 'so', name: 'الصومالية' },
  { code: 'tl', name: 'الفلبينية' }
];

function renderCaptionMenus() {
  if (!el.ccLanguageList) return;

  el.ccLanguageList.innerHTML = '';
  TRANSLATION_LANGUAGES.forEach((language) => {
    const active = state.captions.active
      && state.captions.mode === 'translate'
      && state.captions.lang === language.code;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'cc-item';
    item.setAttribute('data-lang', language.code);

    const check = document.createElement('span');
    check.className = 'cc-check';
    check.textContent = active ? '✓' : '';
    const label = document.createElement('span');
    label.className = 'cc-label';
    label.textContent = language.name;
    const tag = document.createElement('span');
    tag.className = 'cc-tag';
    tag.textContent = 'ترجمة';

    item.appendChild(check);
    item.appendChild(label);
    item.appendChild(tag);
    if (active) item.style.background = 'rgba(62,166,255,0.14)';
    item.addEventListener('click', () => {
      requirePro('الترجمة الفورية الذكية', () => {
        activateTranslation(language);
        closePlayerMenus();
      });
    });
    el.ccLanguageList.appendChild(item);
  });

  if (el.ccTrackList) el.ccTrackList.innerHTML = '';
  const tracks = Array.isArray(state.playerData?.captions) ? state.playerData.captions : [];
  if (el.ccTrackSectionTitle) el.ccTrackSectionTitle.style.display = tracks.length ? '' : 'none';

  tracks.forEach((track) => {
    const key = `${track.code}:${track.auto ? 'auto' : 'manual'}`;
    const active = state.captions.active && state.captions.mode === 'track' && state.captions.key === key;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'cc-item';

    const check = document.createElement('span');
    check.className = 'cc-check';
    check.textContent = active ? '✓' : '';
    const label = document.createElement('span');
    label.className = 'cc-label';
    label.textContent = track.name || track.code;
    item.appendChild(check);
    item.appendChild(label);

    if (track.auto) {
      const tag = document.createElement('span');
      tag.className = 'cc-tag';
      tag.textContent = 'تلقائي';
      item.appendChild(tag);
    }
    if (active) item.style.background = 'rgba(62,166,255,0.14)';
    item.addEventListener('click', () => {
      requirePro('الترجمة الفورية الذكية', () => {
        activateTrack(track);
        closePlayerMenus();
      });
    });
    el.ccTrackList.appendChild(item);
  });

  el.ccBtn?.classList.toggle('active', !!state.captions.active);
  updateCaptionNote();
}

function updateCaptionNote() {
  if (!el.ccNote) return;
  if (state.captionsLoading) {
    el.ccNote.textContent = 'جاري تجهيز الترجمة... قد يستغرق الأمر لحظات.';
  } else if (state.captions.active) {
    el.ccNote.textContent = `مفعّل الآن: ${state.captions.name || state.captions.lang || 'الترجمة'}`;
  } else {
    el.ccNote.textContent = 'اختر لغة الترجمة، وستظهر أثناء التشغيل. الترجمة لا تعمل تلقائياً.';
  }
}

function activateTranslation(language) {
  if (!language) return;
  fetchCaptionTrack({
    lang: language.code,
    translate: language.code,
    name: language.name,
    mode: 'translate',
    key: `translate:${language.code}`
  });
}

function activateTrack(track) {
  if (!track) return;
  fetchCaptionTrack({
    lang: track.code,
    auto: !!track.auto,
    translate: '',
    name: track.name || track.code,
    mode: 'track',
    key: `${track.code}:${track.auto ? 'auto' : 'manual'}`
  });
}

async function fetchCaptionTrack(options) {
  const videoId = state.activeVideo?.id;
  if (!videoId) return;

  const requestId = (state.captionRequestId || 0) + 1;
  state.captionRequestId = requestId;
  state.captionAbort?.abort();
  const controller = new AbortController();
  state.captionAbort = controller;
  state.captionsLoading = true;
  updateCaptionNote();

  const params = new URLSearchParams({ v: videoId });
  if (options.lang) params.set('lang', options.lang);
  if (options.auto) params.set('auto', '1');
  if (options.translate) params.set('translate', options.translate);

  try {
    const response = await fetch(`/api/captions?${params.toString()}`, { signal: controller.signal });
    const data = await response.json().catch(() => null);

    if (requestId !== state.captionRequestId) return;
    if (!response.ok || !data || !data.success) {
      throw new Error(data?.error || 'تعذر جلب الترجمة');
    }
    if (!data.available || !Array.isArray(data.cues) || !data.cues.length) {
      state.captionsLoading = false;
      updateCaptionNote();
      showPlayerToast('لا تتوفر تسميات توضيحية لهذا الفيديو');
      if (el.ccNote) el.ccNote.textContent = 'لا تتوفر تسميات توضيحية أو ترجمة لهذا الفيديو.';
      return;
    }

    state.captions = {
      cues: data.cues,
      active: true,
      key: options.key,
      name: options.name,
      mode: options.mode,
      lang: options.lang || data.language || '',
      translatedTo: data.translatedTo || null
    };
    state.captionLookupCache = { cues: data.cues, index: 0 };
    updateCaptionOverlay(el.videoEl?.currentTime || 0);
    renderCaptionMenus();
    closeCCMenu();
    showPlayerToast(`تم تفعيل: ${options.name}`);
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (requestId !== state.captionRequestId) return;
    console.error('Caption error:', error);
    showPlayerToast('تعذر تحميل الترجمة. حاول مرة أخرى');
    if (el.ccNote) el.ccNote.textContent = 'تعذر تحميل الترجمة. تحقق من الاتصال وحاول مجدداً.';
  } finally {
    if (requestId === state.captionRequestId) {
      state.captionsLoading = false;
      state.captionAbort = null;
      updateCaptionNote();
    }
  }
}

function disableCaptions() {
  state.captionRequestId = (state.captionRequestId || 0) + 1;
  state.captionAbort?.abort();
  state.captionAbort = null;
  state.captionsLoading = false;
  state.captions = { cues: [], active: false, key: '', name: '', mode: '' };
  if (el.captionsOverlay) el.captionsOverlay.innerHTML = '';
  el.ccBtn?.classList.remove('active');
  updateCaptionNote();
  renderCaptionMenus();
  closeCCMenu();
  showPlayerToast('تم إيقاف الترجمة');
}

function updateCaptionOverlay(time) {
  if (!el.captionsOverlay) return;
  if (!state.captions.active || !state.captions.cues.length) {
    if (el.captionsOverlay.childElementCount) el.captionsOverlay.innerHTML = '';
    return;
  }

  const cues = state.captions.cues;
  const currentTime = Number(time) || 0;
  let low = 0;
  let high = cues.length - 1;
  let index = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (cues[middle].start <= currentTime) {
      index = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  let text = '';
  if (index >= 0) {
    const cue = cues[index];
    const end = cue.start + Math.max(0.4, Number(cue.dur) || 0);
    if (currentTime <= end + 0.12) text = cue.text || '';
  }

  let span = el.captionsOverlay.querySelector('span');
  if (text) {
    if (!span) {
      span = document.createElement('span');
      span.dir = 'auto';
      el.captionsOverlay.innerHTML = '';
      el.captionsOverlay.appendChild(span);
    }
    if (span.textContent !== text) span.textContent = text;
  } else if (span) {
    el.captionsOverlay.innerHTML = '';
  }
}

/* ============================================================
 * Comments
 * ============================================================ */
function setupComments() {
  const toggleExpanded = (open) => {
    if (!el.commentsExpandedPanel || !el.commentsPreviewCard) return;
    const show = open != null ? !!open : el.commentsExpandedPanel.style.display === 'none';
    el.commentsExpandedPanel.style.display = show ? 'block' : 'none';
    el.commentsPreviewCard.style.display = show ? 'none' : 'flex';
    el.commentsPreviewCard.setAttribute('aria-expanded', show ? 'true' : 'false');
  };

  el.commentsPreviewCard?.addEventListener('click', () => toggleExpanded(true));
  el.commentsPreviewCard?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpanded(true);
    }
  });
  el.closeCommentsPanelBtn?.addEventListener('click', () => toggleExpanded(false));

  el.newCommentInput?.addEventListener('focus', () => {
    if (state.currentUser) return;
    state.wantsAuthAfterLogin = true;
    state.lastCommentInputWasGated = true;
    el.newCommentInput.blur();
    showToast('سجّل الدخول لإضافة تعليق');
    openAuthModal();
  });

  el.newCommentInput?.addEventListener('input', updateCommentComposer);
  el.newCommentInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitLocalComment();
    }
  });

  el.submitCommentBtn?.addEventListener('click', submitLocalComment);
  el.cancelCommentBtn?.addEventListener('click', clearCommentComposer);
  el.cancelReplyBtn?.addEventListener('click', () => {
    setReplyTarget(null);
    el.commentsList?.querySelectorAll('.comment-item.replying-to').forEach((node) => node.classList.remove('replying-to'));
  });
  el.commentsSortTop?.addEventListener('click', () => changeCommentsSort('top'));
  el.commentsSortNew?.addEventListener('click', () => changeCommentsSort('new'));

  el.loadMoreCommentsBtn?.addEventListener('click', () => {
    if (!state.activeVideo?.id || !state.commentsCursor || state.commentsLoading) return;
    loadComments(state.activeVideo.id, state.commentsSort, state.commentsCursor, true);
  });

  el.commentsList?.addEventListener('click', onCommentsClick);
}

function resetCommentsUI(videoId) {
  state.commentsRequestId = (state.commentsRequestId || 0) + 1;
  state.commentsAbort?.abort();
  state.commentsAbort = null;
  state.comments = [];
  state.commentsCursor = null;
  state.commentsCountText = '';
  state.commentsAvailable = false;
  state.commentsLoading = false;
  state.commentsLoadedFor = videoId || null;
  state.communityComments = [];
  state.communityCommentsLoadedFor = null;
  state.communityCommentsRequestId = (state.communityCommentsRequestId || 0) + 1;
  state.expandedCommentThreads = new Set();
  setReplyTarget(null);
  if (el.newCommentInput) el.newCommentInput.placeholder = state.currentUser ? 'أضف تعليقاً...' : 'سجّل الدخول للتعليق...';

  if (el.commentsExpandedPanel) el.commentsExpandedPanel.style.display = 'none';
  if (el.commentsPreviewCard) {
    el.commentsPreviewCard.style.display = 'flex';
    el.commentsPreviewCard.setAttribute('aria-expanded', 'false');
  }
  if (el.commentsPreviewCount) el.commentsPreviewCount.textContent = '';
  if (el.commentsPreviewAvatar) el.commentsPreviewAvatar.src = 'icon_round.png';
  if (el.commentsPreviewText) el.commentsPreviewText.textContent = 'جاري تحميل التعليقات... اضغط للعرض';
  if (el.commentsList) el.commentsList.innerHTML = renderCommentsSkeletonMarkup();
  if (el.commentsCount) el.commentsCount.textContent = 'التعليقات';
  if (el.loadMoreCommentsBtn) {
    el.loadMoreCommentsBtn.style.display = 'none';
    el.loadMoreCommentsBtn.disabled = false;
    el.loadMoreCommentsBtn.textContent = 'عرض المزيد من التعليقات';
  }
  clearCommentComposer();
}

function renderCommentsSkeletonMarkup() {
  return Array.from({ length: 3 }).map(() => `
    <div class="comment-loading-row">
      <div class="cl-avatar"></div>
      <div class="cl-lines">
        <div class="cl-line" style="width:34%"></div>
        <div class="cl-line" style="width:88%"></div>
        <div class="cl-line" style="width:62%"></div>
      </div>
    </div>
  `).join('');
}

async function loadComments(videoId, sort = 'top', cursor = '', append = false) {
  if (!videoId) return;

  const requestId = (state.commentsRequestId || 0) + 1;
  state.commentsRequestId = requestId;
  state.commentsAbort?.abort();
  const controller = new AbortController();
  state.commentsAbort = controller;

  state.commentsLoading = true;
  if (append) {
    if (el.loadMoreCommentsBtn) {
      el.loadMoreCommentsBtn.disabled = true;
      el.loadMoreCommentsBtn.textContent = 'جاري تحميل المزيد...';
    }
  } else {
    if (el.commentsExpandedPanel) el.commentsExpandedPanel.style.display = 'none';
  if (el.commentsPreviewCard) {
    el.commentsPreviewCard.style.display = 'flex';
    el.commentsPreviewCard.setAttribute('aria-expanded', 'false');
  }
  if (el.commentsPreviewCount) el.commentsPreviewCount.textContent = '';
  if (el.commentsPreviewAvatar) el.commentsPreviewAvatar.src = 'icon_round.png';
  if (el.commentsPreviewText) el.commentsPreviewText.textContent = 'جاري تحميل التعليقات... اضغط للعرض';
  if (el.commentsList) el.commentsList.innerHTML = renderCommentsSkeletonMarkup();
    if (el.loadMoreCommentsBtn) el.loadMoreCommentsBtn.style.display = 'none';
  }

  const params = new URLSearchParams({ v: videoId, sort });
  if (cursor) params.set('cursor', cursor);

  try {
    const response = await fetch(`/api/comments?${params.toString()}`, { signal: controller.signal });
    const data = await response.json().catch(() => null);

    if (requestId !== state.commentsRequestId) return;
    if (state.activeVideo?.id !== videoId) return;
    if (!response.ok || !data || !data.success) {
      throw new Error(data?.error || `تعذر جلب التعليقات (HTTP ${response.status})`);
    }

    const incoming = Array.isArray(data.comments)
      ? data.comments.filter((comment) => comment && comment.id && comment.text)
      : [];

    if (append) {
      const existing = new Set(state.comments.map((comment) => comment.id));
      incoming.forEach((comment) => {
        if (!existing.has(comment.id)) {
          existing.add(comment.id);
          state.comments.push(comment);
        }
      });
    } else {
      state.comments = incoming;
    }

    state.commentsAvailable = !!data.available;
    state.commentsCountText = data.countText || state.playerData?.comments?.countText || state.commentsCountText || '';
    state.commentsCursor = data.cursor || null;
    state.commentsLoadedFor = videoId;
    state.commentsLoading = false;

    renderCommentsList();
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (requestId !== state.commentsRequestId) return;
    if (state.activeVideo?.id !== videoId) return;

    console.error('Comments error:', error);
    state.commentsLoading = false;
    state.commentsAvailable = false;
    state.commentsLoadedFor = videoId;
    renderCommentsList();
    if (!append) showToast('تعذر تحميل التعليقات من YouTube');
  } finally {
    if (requestId === state.commentsRequestId) {
      state.commentsLoading = false;
      state.commentsAbort = null;
      if (el.loadMoreCommentsBtn) {
        el.loadMoreCommentsBtn.disabled = false;
        el.loadMoreCommentsBtn.textContent = 'عرض المزيد من التعليقات';
        el.loadMoreCommentsBtn.style.display = state.commentsCursor ? 'block' : 'none';
      }
    }
  }
}

async function loadCommunityComments(videoId, options = {}) {
  if (!videoId) return;
  const requestId = (state.communityCommentsRequestId || 0) + 1;
  state.communityCommentsRequestId = requestId;

  if (!options.skipMigration) {
    try {
      await migrateLegacyComments(videoId);
    } catch {
      /* non-critical */
    }
  }

  try {
    const params = new URLSearchParams({ v: videoId, sort: state.commentsSort });
    const response = await fetch(`/api/community-comments?${params.toString()}`, { cache: 'no-store' });
    const data = await response.json().catch(() => null);
    if (requestId !== state.communityCommentsRequestId) return;
    if (state.activeVideo?.id !== videoId) return;
    if (!response.ok || !data?.success) throw new Error(data?.error || 'تعذر تحميل تعليقات المجتمع');

    state.communityComments = Array.isArray(data.comments) ? data.comments : [];
    state.communityCommentsLoadedFor = videoId;
    renderCommentsList();
  } catch (error) {
    if (requestId !== state.communityCommentsRequestId) return;
    if (state.activeVideo?.id !== videoId) return;
    console.warn('Community comments error:', error);
    state.communityCommentsLoadedFor = videoId;
    renderCommentsList();
  }
}

async function migrateLegacyComments(videoId) {
  if (!state.currentUser || !videoId) return;
  const legacy = Array.isArray(state.localComments[videoId]) ? state.localComments[videoId] : [];
  if (!legacy.length) return;

  if (!state.legacyCommentsMigrating) state.legacyCommentsMigrating = new Set();
  if (state.legacyCommentsMigrating.has(videoId)) return;
  state.legacyCommentsMigrating.add(videoId);

  let migrated = 0;
  const failed = [];
  try {
    for (const comment of [...legacy].reverse()) {
      const text = String(comment?.text || '').trim();
      if (!text) continue;
      try {
        const response = await fetch('/api/community-comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId, text })
        });
        if (response.ok) migrated += 1;
        else failed.push(comment);
      } catch {
        failed.push(comment);
      }
    }
  } finally {
    state.legacyCommentsMigrating.delete(videoId);
  }

  if (failed.length) state.localComments[videoId] = failed;
  else delete state.localComments[videoId];
  writeJSON('ay_local_comments', state.localComments);
  if (migrated) showToast(`تم نقل ${migrated} تعليق محلي إلى حسابك`);
}

function renderCommentsList() {
  if (!el.commentsList) return;
  const videoId = state.activeVideo?.id;
  if (!videoId) return;

  el.commentsList.innerHTML = '';
  const localList = Array.isArray(state.localComments[videoId]) ? state.localComments[videoId] : [];
  const communityList = Array.isArray(state.communityComments) ? state.communityComments : [];
  const fragment = document.createDocumentFragment();
  const seen = new Set();

  communityList.forEach((comment) => {
    if (!comment?.id || seen.has(comment.id)) return;
    seen.add(comment.id);
    fragment.appendChild(createCommentNode({ ...comment, isLocal: true }, false));
  });

  localList.forEach((comment) => {
    if (!comment?.id || seen.has(comment.id)) return;
    seen.add(comment.id);
    fragment.appendChild(createCommentNode({ ...comment, isLocal: true, isMine: true, isLegacyLocal: true }, false));
  });

  state.comments.forEach((comment) => {
    if (!comment?.id || seen.has(comment.id)) return;
    seen.add(comment.id);
    fragment.appendChild(createCommentNode(comment, false));
  });

  el.commentsList.appendChild(fragment);

  const total = el.commentsList.querySelectorAll('.comment-item').length;
  if (!total) {
    const message = document.createElement('div');
    message.className = 'comments-empty';
    if (state.commentsLoadedFor === videoId && !state.commentsAvailable) {
      message.textContent = 'التعليقات غير متاحة لهذا الفيديو أو تم إغلاقها من الناشر.';
    } else {
      message.textContent = 'لا توجد تعليقات بعد. كن أول من يعلّق!';
    }
    el.commentsList.appendChild(message);
  } else if (localList.length && state.commentsLoadedFor === videoId && !state.commentsAvailable) {
    const note = document.createElement('div');
    note.className = 'comments-empty';
    note.style.padding = '10px 4px';
    note.textContent = 'تعذر تحميل تعليقات YouTube الأصلية — يتم عرض تعليقاتك المحلية.';
    el.commentsList.appendChild(note);
  }

  updateCommentsCount();
  updateCommentsPreviewCard();
  if (el.loadMoreCommentsBtn) {
    el.loadMoreCommentsBtn.style.display = state.commentsCursor && !state.commentsLoading ? 'block' : 'none';
  }
}

function updateCommentsPreviewCard() {
  if (!el.commentsPreviewText) return;
  const first = (state.communityComments && state.communityComments[0]) || (state.comments && state.comments[0]);
  if (first && first.text) {
    el.commentsPreviewText.textContent = first.text;
    if (el.commentsPreviewAvatar) {
      el.commentsPreviewAvatar.src = avatarSource(first.author, first.avatar);
      el.commentsPreviewAvatar.onerror = () => {
        el.commentsPreviewAvatar.src = getFallbackAvatar(first.author);
      };
    }
  } else if (state.commentsLoading) {
    el.commentsPreviewText.textContent = 'جاري تحميل التعليقات... اضغط للعرض';
    if (el.commentsPreviewAvatar) el.commentsPreviewAvatar.src = 'icon_round.png';
  } else if (state.commentsLoadedFor && !state.commentsAvailable) {
    el.commentsPreviewText.textContent = 'التعليقات مغلقة لهذا الفيديو.';
    if (el.commentsPreviewAvatar) el.commentsPreviewAvatar.src = 'icon_round.png';
  } else {
    el.commentsPreviewText.textContent = 'لا توجد تعليقات بعد. اضغط لإضافة أول تعليق!';
    if (el.commentsPreviewAvatar) el.commentsPreviewAvatar.src = 'icon_round.png';
  }
}

function communityCommentsTotal() {
  const list = Array.isArray(state.communityComments) ? state.communityComments : [];
  return list.reduce((total, comment) => (
    total + 1 + (Array.isArray(comment.replies) ? comment.replies.length : 0)
  ), 0);
}

function updateCommentsCount() {
  if (!el.commentsCount) return;
  const localCount = communityCommentsTotal();
  let display = 'التعليقات';
  if (state.commentsCountText && localCount) {
    display = `${state.commentsCountText} • ${localCount} تعليق من AYTube`;
  } else if (state.commentsCountText) {
    display = state.commentsCountText;
  } else {
    const total = state.comments.length + localCount;
    display = total ? `التعليقات • ${total}` : 'التعليقات';
  }
  el.commentsCount.textContent = display;
  if (el.commentsPreviewCount) {
    const rawNum = state.commentsCountText || String(state.comments.length + localCount || '');
    el.commentsPreviewCount.textContent = rawNum ? rawNum.replace(/[^\d.,KkMmألفمليون\s]/g, '').trim() : '';
  }
}

function findCommunityComment(serverId) {
  if (!serverId) return null;
  for (const comment of state.communityComments) {
    if (comment.id === serverId || comment.serverId === serverId) return comment;
    if (Array.isArray(comment.replies)) {
      const reply = comment.replies.find((entry) => entry.id === serverId || entry.serverId === serverId);
      if (reply) return reply;
    }
  }
  return null;
}

function setReplyTarget(target) {
  state.replyTarget = target && target.commentId ? target : null;
  if (el.commentReplyBanner) {
    el.commentReplyBanner.style.display = state.replyTarget ? 'flex' : 'none';
  }
  if (el.commentReplyText) {
    el.commentReplyText.textContent = state.replyTarget ? `الرد على ${state.replyTarget.author || 'مستخدم'}` : '';
  }
  updateCommentComposerPlaceholder();
}

function updateCommentComposerPlaceholder() {
  if (!el.newCommentInput) return;
  if (state.replyTarget) {
    el.newCommentInput.placeholder = `اكتب رداً على ${state.replyTarget.author || 'مستخدم'}...`;
  } else {
    el.newCommentInput.placeholder = state.currentUser
      ? `أضف تعليقاً باسم ${state.currentUser.name}...`
      : 'سجّل الدخول لإضافة تعليق...';
  }
}

function focusCommentComposer() {
  if (!el.newCommentInput) return;
  el.newCommentInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => el.newCommentInput?.focus(), 180);
}

function createCommentNode(comment, isReply = false) {
  const item = document.createElement('div');
  item.className = 'comment-item';
  const serverId = comment.serverId || (comment.isLocal && !comment.isLegacyLocal ? comment.id : '');
  item.setAttribute('data-id', comment.id || '');
  if (serverId) item.setAttribute('data-server-id', serverId);
  if (comment.parentId) item.setAttribute('data-parent-id', comment.parentId);
  if (comment.isMine) item.setAttribute('data-mine', '1');
  item.setAttribute('data-reaction', comment.viewerReaction || '');
  if (comment.isLocal) item.classList.add('comment-community');
  if (comment.isLegacyLocal) item.classList.add('comment-legacy');
  if (isReply) item.classList.add('comment-reply');
  if (state.replyTarget?.commentId && state.replyTarget.commentId === serverId) {
    item.classList.add('replying-to');
  }

  const avatar = document.createElement('img');
  avatar.className = 'comment-author-avatar';
  avatar.loading = 'lazy';
  avatar.referrerPolicy = 'no-referrer';
  avatar.alt = '';
  avatar.src = avatarSource(comment.author, comment.avatar);
  avatar.addEventListener('error', () => {
    avatar.src = getFallbackAvatar(comment.author);
  }, { once: true });

  const content = document.createElement('div');
  content.className = 'comment-content';

  const header = document.createElement('div');
  header.className = 'comment-header-row';

  const author = document.createElement('span');
  author.className = 'comment-author-name';
  author.textContent = comment.author || 'مستخدم';

  header.appendChild(author);

  if (comment.isVerified) {
    const verified = document.createElement('span');
    verified.textContent = '✔︎';
    verified.style.color = '#aaa';
    verified.style.fontSize = '0.75rem';
    verified.title = 'موثّق';
    header.appendChild(verified);
  }

  if (comment.isCreator && !comment.isLocal) {
    const creator = document.createElement('span');
    creator.className = 'comment-creator-badge';
    creator.textContent = 'المنشئ';
    header.appendChild(creator);
  }

  if (comment.isLocal && !comment.isLegacyLocal) {
    const localBadge = document.createElement('span');
    localBadge.className = 'comment-creator-badge comment-community-badge';
    localBadge.textContent = 'AYTube';
    localBadge.title = 'تعليق من مجتمع AYTube';
    header.appendChild(localBadge);
  }

  if (comment.isLegacyLocal) {
    const localBadge = document.createElement('span');
    localBadge.className = 'comment-creator-badge';
    localBadge.textContent = 'محلي';
    header.appendChild(localBadge);
  }

  if (comment.isMine) {
    const mineBadge = document.createElement('span');
    mineBadge.className = 'comment-creator-badge comment-mine-badge';
    mineBadge.textContent = 'أنت';
    header.appendChild(mineBadge);
  }

  if (comment.publishedTime) {
    const time = document.createElement('span');
    time.className = 'comment-time-tag';
    time.textContent = comment.editedAt ? `${comment.publishedTime} (معدّل)` : comment.publishedTime;
    header.appendChild(time);
  }

  const body = document.createElement('div');
  body.className = 'comment-text-body';
  body.dir = 'auto';
  body.textContent = comment.text || '';

  const interactions = document.createElement('div');
  interactions.className = 'comment-interaction-row';

  const likeButton = document.createElement('button');
  likeButton.type = 'button';
  likeButton.className = 'comment-btn-like';
  likeButton.setAttribute('data-action', 'like');
  const likeValue = comment.isLocal
    ? (Number(comment.likes) || 0)
    : parseHumanNumber(comment.likesText || '0');
  likeButton.setAttribute('data-likes', String(likeValue));
  if (comment.viewerReaction === 'like') likeButton.classList.add('liked');
  likeButton.appendChild(document.createTextNode('👍 '));
  const likeCount = document.createElement('span');
  likeCount.textContent = likeValue > 0 ? compactNumber(likeValue) : '';
  likeButton.appendChild(likeCount);
  interactions.appendChild(likeButton);

  const dislikeButton = document.createElement('button');
  dislikeButton.type = 'button';
  dislikeButton.className = 'comment-btn-like comment-btn-dislike';
  dislikeButton.setAttribute('data-action', 'dislike');
  if (comment.viewerReaction === 'dislike') dislikeButton.classList.add('liked');
  dislikeButton.textContent = '👎';
  interactions.appendChild(dislikeButton);

  if (!isReply) {
    const replyButton = document.createElement('button');
    replyButton.type = 'button';
    replyButton.className = 'comment-btn-like comment-btn-reply';
    replyButton.setAttribute('data-action', 'reply');
    replyButton.textContent = 'رد';
    interactions.appendChild(replyButton);
  }

  const replyCount = Array.isArray(comment.replies) ? comment.replies.length : Number(comment.replyCount) || 0;
  if (!isReply && (replyCount > 0 || comment.repliesToken)) {
    const repliesButton = document.createElement('button');
    repliesButton.type = 'button';
    repliesButton.className = 'comment-replies-btn';
    const expanded = !!comment.isLocal && state.expandedCommentThreads.has(comment.id);
    if (comment.isLocal) {
      repliesButton.setAttribute('data-action', 'community-replies');
      repliesButton.setAttribute('data-reply-count', String(replyCount));
      repliesButton.textContent = expanded ? 'إخفاء الردود' : `عرض ${replyCount} رد`;
    } else {
      repliesButton.setAttribute('data-action', 'replies');
      repliesButton.setAttribute('data-token', comment.repliesToken);
      repliesButton.setAttribute(
        'data-reply-count',
        comment.replyCountText || ''
      );
      repliesButton.textContent = comment.replyCountText
        ? `عرض ${comment.replyCountText} رد`
        : 'عرض الردود';
    }
    interactions.appendChild(repliesButton);
  }

  if (serverId && comment.isMine) {
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'comment-btn-like comment-btn-edit';
    editButton.setAttribute('data-action', 'edit');
    editButton.textContent = 'تعديل';
    interactions.appendChild(editButton);

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'comment-btn-like comment-btn-delete';
    deleteButton.setAttribute('data-action', 'delete');
    deleteButton.textContent = 'حذف';
    interactions.appendChild(deleteButton);
  }

  const repliesContainer = document.createElement('div');
  repliesContainer.className = 'comment-replies-list';
  if (comment.isLocal && !isReply && Array.isArray(comment.replies) && comment.replies.length) {
    comment.replies.forEach((reply) => {
      repliesContainer.appendChild(createCommentNode(reply, true));
    });
    repliesContainer.style.display = state.expandedCommentThreads.has(comment.id) ? 'flex' : 'none';
  } else {
    repliesContainer.style.display = 'none';
  }

  content.appendChild(header);
  content.appendChild(body);
  content.appendChild(interactions);
  content.appendChild(repliesContainer);
  item.appendChild(avatar);
  item.appendChild(content);

  return item;
}

function commentInteractions(item) {
  return item?.querySelector(':scope > .comment-content > .comment-interaction-row') || null;
}

function commentBody(item) {
  return item?.querySelector(':scope > .comment-content > .comment-text-body') || null;
}

function updateCommentReactionUI(item, comment) {
  if (!item || !comment) return;
  item.setAttribute('data-reaction', comment.viewerReaction || '');
  const interactions = commentInteractions(item);
  if (!interactions) return;

  const likeButton = interactions.querySelector('[data-action="like"]');
  if (likeButton) {
    likeButton.classList.toggle('liked', comment.viewerReaction === 'like');
    likeButton.setAttribute('data-likes', String(Number(comment.likes) || 0));
    const span = likeButton.querySelector('span');
    if (span) span.textContent = Number(comment.likes) > 0 ? compactNumber(Number(comment.likes)) : '';
  }

  const dislikeButton = interactions.querySelector('[data-action="dislike"]');
  if (dislikeButton) {
    dislikeButton.classList.toggle('liked', comment.viewerReaction === 'dislike');
  }
}

async function reactToCommunityComment(button, item, reaction) {
  if (!state.currentUser) {
    state.wantsAuthAfterLogin = true;
    showToast('سجّل الدخول للتفاعل مع التعليقات');
    openAuthModal();
    return;
  }

  const serverId = item?.getAttribute('data-server-id');
  const comment = findCommunityComment(serverId);
  if (!serverId || !comment) return;

  const previous = {
    reaction: comment.viewerReaction || null,
    likes: Number(comment.likes) || 0,
    dislikes: Number(comment.dislikes) || 0
  };
  const next = previous.reaction === reaction ? null : reaction;

  comment.likes = Math.max(0, previous.likes + (next === 'like' ? 1 : 0) - (previous.reaction === 'like' ? 1 : 0));
  comment.dislikes = Math.max(0, previous.dislikes + (next === 'dislike' ? 1 : 0) - (previous.reaction === 'dislike' ? 1 : 0));
  comment.viewerReaction = next;
  updateCommentReactionUI(item, comment);

  try {
    const response = await fetch(`/api/community-comments/${encodeURIComponent(serverId)}/react`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reaction: next })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) throw new Error(data?.error || 'تعذر حفظ التفاعل');

    comment.viewerReaction = data.reaction || null;
    comment.likes = Number(data.likes) || 0;
    comment.dislikes = Number(data.dislikes) || 0;
  } catch (error) {
    comment.viewerReaction = previous.reaction;
    comment.likes = previous.likes;
    comment.dislikes = previous.dislikes;
    showToast(error.message || 'تعذر حفظ التفاعل');
  }
  updateCommentReactionUI(item, comment);
}

function toggleCommunityReplies(button) {
  const item = button.closest('.comment-item');
  const container = item?.querySelector(':scope > .comment-content > .comment-replies-list');
  if (!container) return;

  const id = item.getAttribute('data-server-id') || item.getAttribute('data-id');
  const hiding = container.style.display !== 'none';
  container.style.display = hiding ? 'none' : 'flex';

  if (id) {
    if (hiding) state.expandedCommentThreads.delete(id);
    else state.expandedCommentThreads.add(id);
  }

  const count = button.getAttribute('data-reply-count')
    || String(container.querySelectorAll(':scope > .comment-item').length);
  button.textContent = hiding ? `عرض ${count} رد` : 'إخفاء الردود';
}

function startCommentEdit(item) {
  const body = commentBody(item);
  if (!body || body.getAttribute('data-editing') === 'true') return;

  const original = body.textContent || '';
  body.dataset.originalText = original;
  body.setAttribute('data-editing', 'true');
  body.textContent = '';

  const textarea = document.createElement('textarea');
  textarea.className = 'comment-edit-textarea';
  textarea.dir = 'auto';
  textarea.maxLength = 2000;
  textarea.value = original;

  const actions = document.createElement('div');
  actions.className = 'comment-edit-actions';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn-comment-cancel';
  cancel.setAttribute('data-action', 'cancel-edit');
  cancel.textContent = 'إلغاء';

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn-comment-submit';
  save.setAttribute('data-action', 'save-edit');
  save.textContent = 'حفظ';

  actions.appendChild(cancel);
  actions.appendChild(save);
  body.appendChild(textarea);
  body.appendChild(actions);
  setTimeout(() => {
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, 30);
}

function cancelCommentEdit(item) {
  const body = commentBody(item);
  if (!body || body.getAttribute('data-editing') !== 'true') return;
  body.textContent = body.dataset.originalText || '';
  delete body.dataset.originalText;
  body.removeAttribute('data-editing');
}

async function saveCommentEdit(item) {
  const body = commentBody(item);
  const textarea = body?.querySelector('.comment-edit-textarea');
  const serverId = item?.getAttribute('data-server-id');
  if (!body || !textarea || !serverId) return;

  const text = String(textarea.value || '').trim();
  if (!text) {
    showToast('نص التعليق لا يمكن أن يكون فارغاً');
    textarea.focus();
    return;
  }

  const saveButton = body.querySelector('[data-action="save-edit"]');
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = 'جارٍ الحفظ...';
  }

  try {
    const response = await fetch(`/api/community-comments/${encodeURIComponent(serverId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) throw new Error(data?.error || 'تعذر تعديل التعليق');

    const comment = findCommunityComment(serverId);
    if (comment) {
      comment.text = data.comment?.text || text;
      comment.editedAt = data.comment?.editedAt || new Date().toISOString();
      if (data.comment?.publishedTime) comment.publishedTime = data.comment.publishedTime;
    }
    renderCommentsList();
    showToast('تم تعديل التعليق');
  } catch (error) {
    showToast(error.message || 'تعذر تعديل التعليق');
    if (saveButton?.isConnected) {
      saveButton.disabled = false;
      saveButton.textContent = 'حفظ';
    }
  }
}

async function deleteCommunityComment(item) {
  const serverId = item?.getAttribute('data-server-id');
  if (!serverId) return;
  if (!window.confirm('هل تريد حذف هذا التعليق نهائياً؟')) return;

  const button = commentInteractions(item)?.querySelector('[data-action="delete"]');
  if (button) button.disabled = true;

  try {
    const response = await fetch(`/api/community-comments/${encodeURIComponent(serverId)}`, {
      method: 'DELETE'
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) throw new Error(data?.error || 'تعذر حذف التعليق');

    state.communityComments = state.communityComments
      .filter((comment) => comment.id !== serverId)
      .map((comment) => ({
        ...comment,
        replies: Array.isArray(comment.replies)
          ? comment.replies.filter((reply) => reply.id !== serverId)
          : []
      }));
    state.expandedCommentThreads.delete(serverId);
    renderCommentsList();
    showToast('تم حذف التعليق');
  } catch (error) {
    showToast(error.message || 'تعذر حذف التعليق');
    if (button?.isConnected) button.disabled = false;
  }
}

async function onCommentsClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button || !el.commentsList?.contains(button)) return;
  const action = button.getAttribute('data-action');
  const item = button.closest('.comment-item');
  const serverId = item?.getAttribute('data-server-id') || '';

  if (action === 'like' || action === 'dislike') {
    if (serverId) {
      await reactToCommunityComment(button, item, action);
      return;
    }

    if (action === 'like') {
      const wasLiked = button.classList.contains('liked');
      button.classList.toggle('liked', !wasLiked);
      const base = parseHumanNumber(button.getAttribute('data-likes') || '0');
      const value = Math.max(0, base + (wasLiked ? -1 : 1));
      button.setAttribute('data-likes', String(value));
      const span = button.querySelector('span');
      if (span) span.textContent = value > 0 ? compactNumber(value) : '';
      if (!wasLiked) {
        commentInteractions(item)?.querySelector('[data-action="dislike"]')?.classList.remove('liked');
      }
      return;
    }

    const wasDisliked = button.classList.contains('liked');
    button.classList.toggle('liked', !wasDisliked);
    if (!wasDisliked) {
      const likeButton = commentInteractions(item)?.querySelector('[data-action="like"]');
      if (likeButton?.classList.contains('liked')) {
        likeButton.classList.remove('liked');
        const base = parseHumanNumber(likeButton.getAttribute('data-likes') || '0');
        const value = Math.max(0, base - 1);
        likeButton.setAttribute('data-likes', String(value));
        const span = likeButton.querySelector('span');
        if (span) span.textContent = value > 0 ? compactNumber(value) : '';
      }
    }
    return;
  }

  if (action === 'reply') {
    if (!state.currentUser) {
      state.wantsAuthAfterLogin = true;
      showToast('سجّل الدخول للرد على التعليقات');
      openAuthModal();
      return;
    }

    const author = item?.querySelector(':scope > .comment-content > .comment-header-row > .comment-author-name')?.textContent || '';
    if (serverId) {
      setReplyTarget({ commentId: serverId, author, videoId: state.activeVideo?.id || '' });
      state.expandedCommentThreads.add(serverId);
      el.commentsList.querySelectorAll('.comment-item.replying-to').forEach((node) => node.classList.remove('replying-to'));
      item?.classList.add('replying-to');
      focusCommentComposer();
      return;
    }

    if (el.newCommentInput && author) {
      const prefix = `@${author} `;
      if (!el.newCommentInput.value.startsWith(prefix)) {
        el.newCommentInput.value = `${prefix}${el.newCommentInput.value}`;
      }
      updateCommentComposer();
      focusCommentComposer();
    }
    return;
  }

  if (action === 'community-replies') {
    toggleCommunityReplies(button);
    return;
  }

  if (action === 'replies') {
    toggleReplies(button);
    return;
  }

  if (action === 'more-replies') {
    loadMoreReplies(button);
    return;
  }

  if (action === 'edit') {
    startCommentEdit(item);
    return;
  }

  if (action === 'cancel-edit') {
    cancelCommentEdit(item);
    return;
  }

  if (action === 'save-edit') {
    await saveCommentEdit(item);
    return;
  }

  if (action === 'delete') {
    await deleteCommunityComment(item);
  }
}

async function toggleReplies(button) {
  const item = button.closest('.comment-item');
  const container = item?.querySelector('.comment-replies-list');
  if (!container) return;

  if (container.getAttribute('data-loaded') === 'true') {
    const hiding = container.style.display !== 'none';
    container.style.display = hiding ? 'none' : 'flex';
    button.textContent = hiding
      ? (button.getAttribute('data-reply-count')
        ? `عرض ${button.getAttribute('data-reply-count')} رد`
        : 'عرض الردود')
      : 'إخفاء الردود';
    return;
  }

  const token = button.getAttribute('data-token');
  const videoId = state.activeVideo?.id;
  if (!token || !videoId) return;

  container.style.display = 'flex';
  container.innerHTML = '<div class="comments-loading">جاري تحميل الردود...</div>';
  button.disabled = true;
  const originalText = button.textContent;

  try {
    const response = await fetch(`/api/comments?v=${encodeURIComponent(videoId)}&cursor=${encodeURIComponent(token)}`);
    const data = await response.json().catch(() => null);
    if (state.activeVideo?.id !== videoId) return;
    if (!response.ok || !data || !data.success) throw new Error('تعذر تحميل الردود');

    container.innerHTML = '';
    const replies = Array.isArray(data.comments) ? data.comments.filter((reply) => reply.id && reply.text) : [];
    replies.forEach((reply) => container.appendChild(createCommentNode(reply, true)));

    if (!replies.length) {
      const empty = document.createElement('div');
      empty.className = 'comments-empty';
      empty.style.padding = '8px 0';
      empty.textContent = 'لا توجد ردود.';
      container.appendChild(empty);
      button.style.display = 'none';
    }

    if (data.cursor) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'comment-replies-btn';
      more.setAttribute('data-action', 'more-replies');
      more.setAttribute('data-cursor', data.cursor);
      more.textContent = 'عرض المزيد من الردود';
      container.appendChild(more);
    }

    container.setAttribute('data-loaded', 'true');
    button.textContent = 'إخفاء الردود';
  } catch (error) {
    console.error('Replies error:', error);
    container.innerHTML = '<div class="comments-empty" style="padding:8px 0">تعذر تحميل الردود.</div>';
    button.textContent = originalText;
  } finally {
    button.disabled = false;
  }
}

async function loadMoreReplies(button) {
  const container = button.closest('.comment-replies-list');
  const cursor = button.getAttribute('data-cursor');
  const videoId = state.activeVideo?.id;
  if (!container || !cursor || !videoId) return;

  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = 'جاري التحميل...';

  try {
    const response = await fetch(`/api/comments?v=${encodeURIComponent(videoId)}&cursor=${encodeURIComponent(cursor)}`);
    const data = await response.json().catch(() => null);
    if (state.activeVideo?.id !== videoId) return;
    if (!response.ok || !data || !data.success) throw new Error('تعذر تحميل المزيد من الردود');

    const replies = Array.isArray(data.comments) ? data.comments.filter((reply) => reply.id && reply.text) : [];
    replies.forEach((reply) => container.insertBefore(createCommentNode(reply, true), button));

    if (data.cursor) {
      button.setAttribute('data-cursor', data.cursor);
      button.textContent = 'عرض المزيد من الردود';
    } else {
      button.remove();
    }
  } catch (error) {
    console.error('More replies error:', error);
    button.textContent = originalText;
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

function changeCommentsSort(sort) {
  const videoId = state.activeVideo?.id;
  if (!videoId) return;
  if (state.commentsSort === sort) return;
  state.commentsSort = sort;
  el.commentsSortTop?.classList.toggle('active', sort === 'top');
  el.commentsSortNew?.classList.toggle('active', sort === 'new');
  state.comments = [];
  state.commentsCursor = null;
  state.commentsLoadedFor = null;
  state.communityComments = [];
  state.communityCommentsLoadedFor = null;
  state.expandedCommentThreads = new Set();
  setReplyTarget(null);
  loadComments(videoId, sort, null, false);
  loadCommunityComments(videoId, { skipMigration: true });
}

function updateCommentComposer() {
  if (!el.newCommentInput) return;
  const hasText = !!el.newCommentInput.value.trim();
  if (el.commentButtonsRow) el.commentButtonsRow.style.display = hasText ? 'flex' : 'none';
  if (el.submitCommentBtn) el.submitCommentBtn.disabled = !hasText;
}

function clearCommentComposer() {
  if (el.newCommentInput) el.newCommentInput.value = '';
  if (el.commentButtonsRow) el.commentButtonsRow.style.display = 'none';
  if (el.submitCommentBtn) el.submitCommentBtn.disabled = true;
}

async function submitLocalComment() {
  if (!state.currentUser) {
    state.wantsAuthAfterLogin = true;
    showToast('سجّل الدخول لإضافة تعليق');
    openAuthModal();
    return;
  }
  if (state.commentSubmitting) return;

  const videoId = state.activeVideo?.id;
  const text = (el.newCommentInput?.value || '').trim();
  if (!videoId || !text) return;

  const parentId = state.replyTarget?.commentId || null;
  if (state.replyTarget?.videoId && state.replyTarget.videoId !== videoId) setReplyTarget(null);

  state.commentSubmitting = true;
  const submitButton = el.submitCommentBtn;
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = parentId ? 'جارٍ الرد...' : 'جارٍ النشر...';
  }

  try {
    const response = await fetch('/api/community-comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, text, parentId })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) {
      throw new Error(data?.error || 'تعذر نشر التعليق');
    }

    if (parentId) state.expandedCommentThreads.add(parentId);
    setReplyTarget(null);
    clearCommentComposer();
    await loadCommunityComments(videoId, { skipMigration: true });
    showToast(parentId ? 'تم نشر ردك' : 'تم نشر تعليقك');
  } catch (error) {
    showToast(error.message || 'تعذر نشر التعليق');
  } finally {
    state.commentSubmitting = false;
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = 'تعليق';
    }
    updateCommentComposer();
  }
}

/* ============================================================
 * PlayBack options
 * ============================================================ */
function setupOptions() {
  el.optHome?.addEventListener('click', () => {
    setActiveChip('الكل');
    if (el.searchInput) el.searchInput.value = '';
    updateClearSearchButton();
    if (state.isFloating) closeFloatingPlayer({ pause: true, showFeed: false });
    loadFeed(DEFAULT_QUERY, { cache: true });
  });

  el.optBackground?.addEventListener('click', () => requirePro('التشغيل في الخلفية', startBackgroundMode));
  el.optPip?.addEventListener('click', () => requirePro('المشغل العائم', activateExternalFloatingPlayer));

  el.optDesktop?.addEventListener('click', (event) => {
    if (event.target === el.desktopModeCheckbox) return;
    requirePro('وضع سطح المكتب', () => setTheater(!state.theater));
  });

  el.desktopModeCheckbox?.addEventListener('change', () => {
    if (!state.isPro) {
      el.desktopModeCheckbox.checked = state.theater;
      requirePro('وضع سطح المكتب', () => {
        el.desktopModeCheckbox.checked = !state.theater;
        setTheater(!state.theater);
      });
      return;
    }
    setTheater(!!el.desktopModeCheckbox.checked);
  });

  el.optFavorite?.addEventListener('click', () => requirePro('المفضلات', toggleFavoriteCurrent));
  el.optShare?.addEventListener('click', () => requirePro('المشاركة السريعة', openShareModal));
  el.optDownload?.addEventListener('click', () => requirePro('تنزيل المقاطع', openDownloadModal));
  el.optLoop?.addEventListener('click', () => requirePro('التكرار التلقائي (حلقة)', toggleLoop));
  el.optSleep?.addEventListener('click', () => requirePro('مؤقت النوم', openSleepModal));

  updateLoopUI();
  updateSleepUI();
}

function toggleLoop() {
  state.isLooping = !state.isLooping;
  updateLoopUI();
  showToast(state.isLooping ? 'تم تفعيل إعادة التشغيل التلقائي 🔁' : 'تم إيقاف إعادة التشغيل التلقائي');
}

function updateLoopUI() {
  if (el.loopTitleText) {
    el.loopTitleText.textContent = state.isLooping ? 'حلقة (مفعّلة)' : 'حلقة';
  }
  el.optLoop?.classList.toggle('active', state.isLooping);
}

/* ============================================================
 * AYTube PRO Upgrade & Centralized Server Revocable Code System
 * ============================================================ */
function isProActive() {
  return !!state.isPro && !!state.proToken;
}

function revokeLocalPro(silent = false) {
  const wasPro = !!state.isPro;
  state.isPro = false;
  state.proToken = '';
  state.allowExternalPip = false;
  try {
    localStorage.removeItem('ay_pro_token');
    localStorage.removeItem('ay_pro_unlocked');
    localStorage.removeItem('ay_pro_key');
  } catch {}
  if (state.isBackground) {
    try { stopBackgroundMode({ pause: true, silent: true }); } catch {}
  }
  syncNativePlaybackMeta(false);
  updateProUI();
  if (wasPro && !silent) {
    showToast('⚠️ تم تحديث أو إيقاف كود PRO من المطور. يرجى إدخال الكود الجديد لمتابعة استخدام ميزات PRO.');
  }
}

async function verifyProStatus(options = {}) {
  const token = state.proToken || localStorage.getItem('ay_pro_token') || '';
  if (!token) {
    if (state.isPro) revokeLocalPro(true);
    return false;
  }

  try {
    const qForce = options.force ? '&force=1' : '';
    const res = await fetch(`/api/pro/status?token=${encodeURIComponent(token)}${qForce}`, { cache: 'no-store' });
    if (!res.ok) return state.isPro;
    const data = await res.json().catch(() => null);
    if (data && data.success) {
      if (data.active) {
        state.isPro = true;
        state.proToken = token;
        updateProUI();
        return true;
      }
      if (data.revoked || data.cloudSynced) {
        // Master code was changed or paused on cloud server -> immediately revoke this device!
        revokeLocalPro(!!options.silent);
        return false;
      }
    }
  } catch {
    // Keep current state only if network is temporarily unreachable
  }
  return !!state.isPro;
}

function updateProUI() {
  const active = !!state.isPro;
  if (el.headerProBtn) {
    el.headerProBtn.classList.toggle('is-pro', active);
    if (el.headerProText) {
      el.headerProText.textContent = active ? 'PRO مُفعّل' : 'ترقية برو';
    }
  }
}

function openProModal(featureName = 'هذه الميزة', onAuthorized = null) {
  state.proPendingAction = onAuthorized;
  if (el.proModalPrompt) {
    el.proModalPrompt.innerHTML = `ميزة <strong>"${escapeHtml(featureName)}"</strong> حصرية لحسابات <strong>AYTube PRO</strong>.<br>أدخل كود التفعيل المكون من 16 حرفاً ورقماً للترقية والوصول إلى كافة الميزات الممتازة فوراً.`;
  }
  if (el.proCodeInput) {
    el.proCodeInput.value = '';
  }
  if (el.proModalStatus) {
    el.proModalStatus.style.display = 'none';
    el.proModalStatus.textContent = '';
  }
  showModal(el.proModal);
  if (window.innerWidth > 768) {
    setTimeout(() => el.proCodeInput?.focus(), 150);
  }
}

function closeProModal() {
  hideModal(el.proModal);
  state.proPendingAction = null;
}

async function activateProCode(inputCode) {
  const code = String(inputCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) {
    if (el.proModalStatus) {
      el.proModalStatus.style.display = 'block';
      el.proModalStatus.style.color = '#ff4d4f';
      el.proModalStatus.textContent = 'يرجى كتابة كود التفعيل المكون من 16 رمزاً (أحرف وأرقام).';
    }
    return;
  }

  if (el.proActivateBtn) {
    el.proActivateBtn.disabled = true;
    el.proActivateBtn.textContent = 'جاري التحقق...';
  }

  try {
    const res = await fetch('/api/pro/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.success && data.proToken) {
      state.isPro = true;
      state.proToken = data.proToken;
      try {
        localStorage.setItem('ay_pro_token', data.proToken);
      } catch {}
      updateProUI();
      if (el.proModalStatus) {
        el.proModalStatus.style.display = 'block';
        el.proModalStatus.style.color = '#00e676';
        el.proModalStatus.textContent = '🎉 تم تفعيل حساب AYTube PRO بنجاح!';
      }
      showToast('🎉 تم تفعيل حساب AYTube PRO بنجاح! جميع الميزات مفتوحة الآن.');
      const pending = state.proPendingAction;
      setTimeout(() => {
        closeProModal();
        if (typeof pending === 'function') {
          try { pending(); } catch {}
        }
      }, 650);
    } else {
      if (el.proModalStatus) {
        el.proModalStatus.style.display = 'block';
        el.proModalStatus.style.color = '#ff4d4f';
        el.proModalStatus.textContent = data?.error || '❌ كود التفعيل غير صحيح! تأكد من إدخال الكود المكون من 16 حرفاً ورقماً.';
      }
    }
  } catch {
    if (el.proModalStatus) {
      el.proModalStatus.style.display = 'block';
      el.proModalStatus.style.color = '#ff4d4f';
      el.proModalStatus.textContent = 'تعذر الاتصال بالخادم للتحقق من الكود.';
    }
  } finally {
    if (el.proActivateBtn) {
      el.proActivateBtn.disabled = false;
      el.proActivateBtn.textContent = 'تفعيل الحساب الآن ⚡';
    }
  }
}

async function requirePro(featureName, onAuthorized) {
  const valid = await verifyProStatus({ silent: false, force: true });
  if (valid) {
    if (typeof onAuthorized === 'function') onAuthorized();
    return true;
  }
  openProModal(featureName, onAuthorized);
  return false;
}

/* ============================================================
 * Modals: share, download, sleep, settings, pro
 * ============================================================ */
function setupModals() {
  el.closeProModalBtn?.addEventListener('click', closeProModal);
  el.proActivateBtn?.addEventListener('click', () => {
    activateProCode(el.proCodeInput?.value);
  });
  el.proCodeInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      activateProCode(el.proCodeInput.value);
    }
  });
  el.headerProBtn?.addEventListener('click', async () => {
    const valid = await verifyProStatus({ silent: false, force: true });
    if (valid && state.isPro) {
      showToast('🎉 حسابك مُفعّل مسبقاً بنسخة AYTube PRO 👑 جميع الميزات مفتوحة!');
    } else {
      openProModal('ترقية الحساب إلى برو');
    }
  });

  el.closeShareModalBtn?.addEventListener('click', closeShareModal);
  el.closeDownloadBtn?.addEventListener('click', closeDownloadModal);
  el.closeSleepBtn?.addEventListener('click', closeSleepModal);
  el.closeSettingsBtn?.addEventListener('click', closeSettingsModal);

  [el.shareModal, el.downloadModal, el.sleepModal, el.settingsModal, el.proModal].forEach((modal) => {
    modal?.addEventListener('click', (event) => {
      if (event.target === modal) hideModal(modal);
    });
  });

  el.doCopyLinkBtn?.addEventListener('click', async () => {
    const url = el.shareUrlInput?.value || '';
    if (!url) return;
    const copied = await copyTextToClipboard(url);
    if (copied) {
      if (el.copySuccessMsg) {
        el.copySuccessMsg.style.display = 'block';
        setTimeout(() => { if (el.copySuccessMsg) el.copySuccessMsg.style.display = 'none'; }, 2400);
      }
      showToast('تم نسخ الرابط ✅');
    } else {
      showToast('تعذر نسخ الرابط. حدّد الرابط وانسخه يدوياً.');
    }
  });

  el.downloadAudioBtn?.addEventListener('click', () => startDownload('audio'));
  el.downloadVideoBtn?.addEventListener('click', () => startDownload('video'));

  $$('.sleep-option-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const minutes = Number(button.getAttribute('data-min')) || 0;
      if (minutes > 0) setSleepTimer(minutes);
    });
  });
  el.cancelSleepTimerBtn?.addEventListener('click', cancelSleepTimer);

  el.openSettingsBtn?.addEventListener('click', openSettingsModal);
  el.settingThemeBtn?.addEventListener('click', toggleTheme);
  el.settingAutoplayToggle?.addEventListener('change', () => {
    state.autoplay = !!el.settingAutoplayToggle.checked;
    try { localStorage.setItem('pb_autoplay', String(state.autoplay)); } catch { /* ignore */ }
    showToast(state.autoplay ? 'سيبدأ الفيديو تلقائياً عند الفتح' : 'تم إيقاف التشغيل التلقائي');
  });
  el.settingQualitySelect?.addEventListener('change', () => {
    state.prefQuality = el.settingQualitySelect.value || 'auto';
    try { localStorage.setItem('pb_pref_quality', state.prefQuality); } catch { /* ignore */ }
    showToast(state.prefQuality === 'auto' ? 'الجودة المفضلة: تلقائي' : `الجودة المفضلة: ${state.prefQuality}p`);
  });
  el.clearHistoryRow?.addEventListener('click', () => {
    const confirmed = window.confirm('هل تريد مسح سجل المشاهدة والمفضلة من هذا الجهاز؟');
    if (!confirmed) return;
    state.history = [];
    state.favorites = [];
    saveHistory();
    saveFavorites();
    showToast('تم مسح سجل المشاهدة والمفضلة');
  });

  if (window.AYTubeNative?.openServerSettings && el.apkServerSettingsRow) {
    el.apkServerSettingsRow.style.display = '';
    el.apkServerSettingsRow.addEventListener('click', () => {
      closeSettingsModal();
      window.AYTubeNative.openServerSettings();
    });
  }
}

function openSettingsModal() {
  if (el.settingAutoplayToggle) el.settingAutoplayToggle.checked = state.autoplay;
  if (el.settingQualitySelect) el.settingQualitySelect.value = state.prefQuality;
  if (el.settingThemeBtn) el.settingThemeBtn.textContent = state.theme === 'dark' ? 'داكن' : 'فاتح';
  showModal(el.settingsModal);
}

function closeSettingsModal() {
  hideModal(el.settingsModal);
}

function openShareModal() {
  if (!state.activeVideo?.id) return;
  const url = `https://www.youtube.com/watch?v=${state.activeVideo.id}`;
  const title = state.activeVideo.title || 'فيديو على YouTube';
  if (el.shareUrlInput) el.shareUrlInput.value = url;

  const text = encodeURIComponent(title);
  if (el.shareWhatsappBtn) {
    el.shareWhatsappBtn.href = `https://wa.me/?text=${encodeURIComponent(`${title} ${url}`)}`;
  }
  if (el.shareFacebookBtn) {
    el.shareFacebookBtn.href = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
  }
  if (el.shareTelegramBtn) {
    el.shareTelegramBtn.href = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${text}`;
  }
  if (el.shareTwitterBtn) {
    el.shareTwitterBtn.href = `https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${text}`;
  }
  if (el.shareEmailBtn) {
    el.shareEmailBtn.href = `mailto:?subject=${text}&body=${encodeURIComponent(`${title}\n${url}`)}`;
  }
  if (el.copySuccessMsg) el.copySuccessMsg.style.display = 'none';
  showModal(el.shareModal);
}

function closeShareModal() {
  hideModal(el.shareModal);
}

async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back below */
  }
  try {
    if (el.shareUrlInput) {
      el.shareUrlInput.focus();
      el.shareUrlInput.select();
    }
    return document.execCommand('copy');
  } catch {
    return false;
  }
}

function openDownloadModal() {
  if (!state.activeVideo?.id) return;
  if (el.downloadVideoTitle) {
    el.downloadVideoTitle.textContent = state.activeVideo.title || 'عنوان الفيديو';
  }
  if (el.downloadStatusMsg) el.downloadStatusMsg.textContent = '';
  showModal(el.downloadModal);
}

function closeDownloadModal() {
  hideModal(el.downloadModal);
}

function startDownload(type) {
  if (!state.activeVideo?.id) return;
  const videoId = state.activeVideo.id;
  const label = type === 'audio' ? 'الصوت (M4A)' : 'الفيديو بالصوت والصورة (MP4)';
  if (el.downloadStatusMsg) {
    el.downloadStatusMsg.innerHTML = `<span class="spinner" style="display:inline-block; width:14px; height:14px; vertical-align:middle; margin-inline-end:8px;"></span> <span>⬇️ بدأ تحميل ${label}... راقب شريط التنزيلات في المتصفح</span>`;
  }
  showToast(`⬇️ بدأ تحميل ${label}...`);

  try {
    const anchor = document.createElement('a');
    anchor.href = `/api/download-direct?v=${encodeURIComponent(videoId)}&type=${type === 'audio' ? 'audio' : 'video'}`;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => anchor.remove(), 1200);
    setTimeout(() => {
      if (el.downloadStatusMsg) {
        el.downloadStatusMsg.innerHTML = '✅ يتم الآن تنزيل الملف وحفظه في مجلد التنزيلات بجهازك!';
      }
    }, 1500);
  } catch {
    if (el.downloadStatusMsg) el.downloadStatusMsg.textContent = '❌ تعذر بدء التحميل. حاول مرة أخرى.';
  }
}

function openSleepModal() {
  updateSleepUI();
  showModal(el.sleepModal);
}

function closeSleepModal() {
  hideModal(el.sleepModal);
}

function setSleepTimer(minutes) {
  cancelSleepTimer(true);
  state.sleepMinutes = minutes;
  state.sleepTimerId = setTimeout(() => {
    pauseMedia();
    stopBackgroundMode({ pause: true, silent: true });
    if (state.isFloating) closeFloatingPlayer({ pause: true, showFeed: true });
    state.sleepTimerId = null;
    state.sleepMinutes = 0;
    updateSleepUI();
    showToast('تم إيقاف التشغيل بواسطة مؤقت النوم ⏲️', 4200);
  }, minutes * 60 * 1000);
  updateSleepUI();
  closeSleepModal();
  showToast(`تم ضبط مؤقت النوم: سيتم إيقاف التشغيل بعد ${minutes} دقيقة ⏲️`);
}

function cancelSleepTimer(keepStatus = false) {
  if (state.sleepTimerId) {
    clearTimeout(state.sleepTimerId);
    state.sleepTimerId = null;
  }
  state.sleepMinutes = 0;
  updateSleepUI();
  if (!keepStatus) showToast('تم إلغاء مؤقت النوم');
}

function updateSleepUI() {
  if (el.sleepTitleText) {
    el.sleepTitleText.textContent = state.sleepMinutes
      ? `مؤقت النوم (${state.sleepMinutes} د)`
      : 'مؤقت النوم';
  }
  if (el.sleepStatusMsg) {
    el.sleepStatusMsg.textContent = state.sleepMinutes
      ? `مؤقت نشط: سيتم إيقاف التشغيل بعد ${state.sleepMinutes} دقيقة.`
      : 'لا يوجد مؤقت نوم نشط.';
  }
  el.optSleep?.classList.toggle('active', !!state.sleepMinutes);
}

/* ============================================================
 * Floating player (Zero-Lag CSS Mini Player + PRO OS PiP)
 * ============================================================ */
function setupFloatingPlayer() {
  const closeFn = () => {
    closeFloatingPlayer({ pause: true, showFeed: true });
    showToast('تم إغلاق المشغل العائم');
  };
  const expandFn = () => {
    closeFloatingPlayer({ pause: false, showFeed: false });
    switchToWatchView();
    if (state.playerData && el.videoEl?.paused && state.isPlaying) playMedia();
  };

  el.fpCloseBtn?.addEventListener('click', closeFn);
  el.fpExpandBtn?.addEventListener('click', expandFn);
  el.miniFloatCloseBtn?.addEventListener('click', (e) => { e.stopPropagation(); closeFn(); });
  el.miniFloatExpandBtn?.addEventListener('click', (e) => { e.stopPropagation(); expandFn(); });

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  el.miniFloatBar?.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    if (!state.isFloating || !el.playerShell) return;
    const rect = el.playerShell.getBoundingClientRect();
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    el.playerShell.style.setProperty('left', `${rect.left}px`, 'important');
    el.playerShell.style.setProperty('top', `${rect.top}px`, 'important');
    el.playerShell.style.setProperty('right', 'auto', 'important');
    el.playerShell.style.setProperty('bottom', 'auto', 'important');
    try { el.miniFloatBar.setPointerCapture(event.pointerId); } catch {}
    event.preventDefault();
  });

  el.miniFloatBar?.addEventListener('pointermove', (event) => {
    if (!dragging || !el.playerShell) return;
    const width = el.playerShell.offsetWidth;
    const height = el.playerShell.offsetHeight;
    const left = clamp(startLeft + (event.clientX - startX), 8, Math.max(8, window.innerWidth - width - 8));
    const top = clamp(startTop + (event.clientY - startY), 8, Math.max(8, window.innerHeight - height - 8));
    el.playerShell.style.setProperty('left', `${left}px`, 'important');
    el.playerShell.style.setProperty('top', `${top}px`, 'important');
  });

  const endMiniDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    try { el.miniFloatBar?.releasePointerCapture(event.pointerId); } catch {}
  };
  el.miniFloatBar?.addEventListener('pointerup', endMiniDrag);
  el.miniFloatBar?.addEventListener('pointercancel', endMiniDrag);
}

async function activateExternalFloatingPlayer() {
  if (!isProActive()) {
    openProModal('المشغل العائم', activateExternalFloatingPlayer);
    return;
  }
  if (!state.playerData || !el.videoEl) {
    showToast('افتح فيديو أولاً لاستخدام المشغل العائم');
    return;
  }
  state.allowExternalPip = true;
  syncNativePlaybackMeta(!el.videoEl.paused);

  if (window.AYTubeNative?.enterPip) {
    if (el.videoEl.paused) playMedia();
    window.AYTubeNative.enterPip(state.activeVideo?.title || 'AYTube', state.activeVideo?.id || '');
    return;
  }

  try {
    if (document.pictureInPictureEnabled && !el.videoEl.disablePictureInPicture) {
      if (el.videoEl.paused) await el.videoEl.play();
      await el.videoEl.requestPictureInPicture();
      return;
    }
  } catch {}

  startFloatingPlayer();
}

function startFloatingPlayer(options = {}) {
  if (!state.playerData || !el.playerShell) {
    if (!options.silentToast) showToast('افتح فيديو أولاً لاستخدام المشغل العائم');
    return;
  }
  if (state.isFloating) return;

  if (state.isBackground) {
    stopBackgroundMode({ pause: false, silent: true });
  }

  state.isFloating = true;
  document.body.classList.add('in-app-floating');
  if (el.miniFloatBar) el.miniFloatBar.style.display = 'flex';
  if (el.miniFloatTitle) el.miniFloatTitle.textContent = state.activeVideo?.title || 'فيديو عائم';
  el.playerShell.style.removeProperty('left');
  el.playerShell.style.removeProperty('top');
  el.playerShell.style.removeProperty('right');
  el.playerShell.style.removeProperty('bottom');

  showFeedView({ pause: false });
  if (!options.silentToast) {
    showToast('المشغل العائم نشط أثناء التصفح 🪟');
  }
}

function closeFloatingPlayer(options = {}) {
  if (!state.isFloating || !el.playerShell) return;

  state.isFloating = false;
  document.body.classList.remove('in-app-floating');
  if (el.miniFloatBar) el.miniFloatBar.style.display = 'none';
  el.playerShell.style.removeProperty('left');
  el.playerShell.style.removeProperty('top');
  el.playerShell.style.removeProperty('right');
  el.playerShell.style.removeProperty('bottom');

  if (options.pause) {
    pauseMedia();
    if (el.watchView) el.watchView.style.display = 'none';
  }
  if (options.showFeed) showFeedView({ pause: false });
}

/* ============================================================
 * Native Android Bridge Callbacks (Strict PRO Control + Media Notification)
 * ============================================================ */
window.onNativePipChanged = (inPip) => {
  document.body.classList.toggle('native-pip-mode', !!inPip);
  if (!inPip) {
    state.allowExternalPip = false;
    syncNativePlaybackMeta(!el.videoEl?.paused);
  }
};

window.pauseAllOnExit = () => {
  if (state.isBackground && isProActive()) return;
  state.allowExternalPip = false;
  pauseMedia();
  if (shortsState.active) {
    try { el.shortsVideoEl?.pause(); el.shortsAudioEl?.pause(); } catch {}
  }
  syncNativePlaybackMeta(false);
};

window.onNativeMediaCommand = (cmd, arg) => {
  if (!isProActive()) return;
  const media = state.isBackground ? el.audioEl : el.videoEl;
  if (!media) return;
  if (cmd === 'play') {
    if (state.isBackground) { el.audioEl.play().catch(() => {}); }
    else playMedia();
    syncNativePlaybackMeta(true);
  } else if (cmd === 'pause') {
    if (state.isBackground) { el.audioEl.pause(); }
    else pauseMedia();
    syncNativePlaybackMeta(false);
  } else if (cmd === 'toggle') {
    if (media.paused) window.onNativeMediaCommand('play');
    else window.onNativeMediaCommand('pause');
  } else if (cmd === 'prev') {
    const t = Math.max(0, (media.currentTime || 0) - 10);
    media.currentTime = t;
    if (!state.isBackground && el.audioEl?.getAttribute('src')) el.audioEl.currentTime = t;
    syncNativePlaybackMeta(!media.paused);
  } else if (cmd === 'next') {
    const nextRel = state.playerData?.related?.[0];
    if (nextRel?.id && !state.isBackground) {
      openWatchView(nextRel);
    } else {
      const t = Math.min(state.duration || media.duration || 0, (media.currentTime || 0) + 15);
      media.currentTime = t;
      syncNativePlaybackMeta(!media.paused);
    }
  } else if (cmd === 'seek') {
    const t = Math.max(0, (Number(arg) || 0) / 1000);
    media.currentTime = t;
    if (!state.isBackground && el.audioEl?.getAttribute('src')) el.audioEl.currentTime = t;
    syncNativePlaybackMeta(!media.paused);
  }
};

/* ============================================================
 * Background audio (Strictly PRO-gated + explicit user toggle)
 * ============================================================ */
function setupBackgroundMode() {
  el.bgReturnBtn?.addEventListener('click', returnFromBackground);
  el.bgStopBtn?.addEventListener('click', () => {
    stopBackgroundMode({ pause: true });
    showToast('تم إيقاف التشغيل في الخلفية');
  });

  let lastNativeSyncAt = 0;
  el.audioEl?.addEventListener('play', () => {
    if (state.isBackground) syncNativePlaybackMeta(true);
  });
  el.audioEl?.addEventListener('pause', () => {
    if (state.isBackground) syncNativePlaybackMeta(false);
  });
  el.audioEl?.addEventListener('timeupdate', () => {
    if (!state.isBackground) return;
    const now = Date.now();
    if (now - lastNativeSyncAt >= 1200) {
      lastNativeSyncAt = now;
      syncNativePlaybackMeta(!el.audioEl.paused);
    }
  });

  el.audioEl?.addEventListener('ended', () => {
    if (!state.isBackground) return;
    if (state.isLooping) {
      el.audioEl.currentTime = 0;
      el.audioEl.play().catch(() => { /* ignore */ });
      return;
    }
    state.isBackground = false;
    if (el.bgNotificationBar) el.bgNotificationBar.style.display = 'none';
    syncNativePlaybackMeta(false);
    showToast('انتهى الفيديو');
  });
}

function startBackgroundMode() {
  if (!isProActive()) {
    openProModal('التشغيل في الخلفية', startBackgroundMode);
    return;
  }
  if (!state.playerData || !el.audioEl) {
    showToast('افتح فيديو أولاً لتشغيل الصوت في الخلفية');
    return;
  }
  if (state.isFloating) closeFloatingPlayer({ pause: false, showFeed: false });

  const currentTime = el.videoEl?.currentTime || 0;
  const wasPlaying = !!el.videoEl && !el.videoEl.paused;

  state.isBackground = true;
  state.wasPlayingBeforeBackground = wasPlaying;
  if (el.videoEl) el.videoEl.pause();
  if (el.bgNotifTitle) el.bgNotifTitle.textContent = `تشغيل في الخلفية: ${state.activeVideo?.title || 'فيديو'}`;
  if (el.bgNotificationBar) el.bgNotificationBar.style.display = 'flex';
  showFeedView({ pause: false });

  el.audioEl.currentTime = currentTime;
  el.audioEl.playbackRate = state.speed;
  el.audioEl.volume = state.volume;
  el.audioEl.muted = state.muted;
  el.audioEl.play().catch(() => {
    showToast('اسمح بتشغيل الصوت ثم اضغط تشغيل');
  });

  showToast('تم تفعيل التشغيل في الخلفية 🎧');
  updatePlayPauseUI();
  syncNativePlaybackMeta(true);
}

function returnFromBackground() {
  if (!state.isBackground) {
    if (state.playerData) switchToWatchView();
    return;
  }

  const wasPlaying = el.audioEl ? !el.audioEl.paused : false;
  const currentTime = el.audioEl?.currentTime || 0;
  state.isBackground = false;
  if (el.bgNotificationBar) el.bgNotificationBar.style.display = 'none';
  if (el.audioEl) el.audioEl.pause();
  if (el.videoEl) el.videoEl.currentTime = currentTime;

  switchToWatchView();
  if (wasPlaying) {
    playMedia();
  } else {
    updatePlayPauseUI();
  }
  syncNativePlaybackMeta(wasPlaying);
}

function stopBackgroundMode(options = {}) {
  const wasBackground = state.isBackground;
  state.isBackground = false;
  if (el.bgNotificationBar) el.bgNotificationBar.style.display = 'none';
  if (options.pause) {
    el.audioEl?.pause();
    el.videoEl?.pause();
  }
  updatePlayPauseUI();
  syncNativePlaybackMeta(false);
  if (wasBackground && !options.silent) showToast('تم إيقاف التشغيل في الخلفية');
}

/* ============================================================
 * Keyboard shortcuts
 * ============================================================ */
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const openModal = $$('.modal-overlay.active')[0];
      if (openModal) {
        hideModal(openModal);
        return;
      }
      if (isAnyPlayerMenuOpen()) {
        closePlayerMenus();
        return;
      }
      closeProfileMenu();
      hideSuggestions();
      return;
    }

    if (isEditableTarget(event.target)) return;

    if (event.key === '/' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      el.searchInput?.focus();
      return;
    }

    const watchVisible = el.watchView && el.watchView.style.display !== 'none';
    if (!watchVisible) return;

    if (event.code === 'Space' || event.key.toLowerCase() === 'k') {
      event.preventDefault();
      togglePlay();
    } else if (event.key.toLowerCase() === 'm') {
      event.preventDefault();
      toggleMute();
    } else if (event.key.toLowerCase() === 'f') {
      event.preventDefault();
      toggleFullscreen();
    } else if (event.key.toLowerCase() === 't') {
      event.preventDefault();
      setTheater(!state.theater);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      seekTo((el.videoEl?.currentTime || 0) - 5);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      seekTo((el.videoEl?.currentTime || 0) + 5);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setVolume(state.volume + 0.05);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setVolume(state.volume - 0.05);
    }
  });

  document.addEventListener('click', (event) => {
    if (el.playerShell && !el.playerShell.contains(event.target)) closePlayerMenus();
  });
}

/* ============================================================
 * Start
 * ============================================================ */
updateLoopUI();
updateSleepUI();



/* ============================================================
 * Channel Page View
 * ============================================================ */
/* ============================================================
 * Channel Page View (Multi-tab matching YouTube Image 1 & 2)
 * ============================================================ */
let activeChannelState = {
  channel: null,
  tabs: [],
  currentTab: 'home',
  cachedTabs: {},
  sortOrder: 'latest'
};

async function openChannelPage(channelName, channelAvatar = '', channelId = '', initialTab = 'home', options = {}) {
  if (!channelName && !channelId) return;
  showFeedView({ pause: true });
  setActiveChip(null);
  renderSkeletons();

  if (!options.skipPush) {
    pushAppRoute({ channel: channelName || '', cid: channelId || '', tab: initialTab || 'home' });
  }

  activeChannelState = {
    channel: {
      id: channelId,
      name: channelName || 'قناة يوتيوب',
      avatar: channelAvatar,
      isSubscribed: isSubscribed(channelName, channelId)
    },
    tabs: [],
    currentTab: initialTab,
    cachedTabs: {},
    sortOrder: 'latest'
  };

  try {
    const params = new URLSearchParams();
    if (channelId) params.set('channelId', channelId);
    if (channelName) params.set('name', channelName);
    params.set('tab', initialTab);

    const res = await fetch(`/api/channel?${params.toString()}`, { cache: 'no-store' });
    const data = await res.json();
    if (data && data.success && data.channel) {
      activeChannelState.channel = data.channel;
      activeChannelState.tabs = data.tabs || [];
      activeChannelState.currentTab = data.currentTab || initialTab;
      activeChannelState.cachedTabs[activeChannelState.currentTab] = data;

      renderChannelFeed(data);
      return;
    }
  } catch (e) {
    console.error('Error loading channel:', e);
  }

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(channelName)}`);
    const data = await res.json();
    renderChannelFeed({
      channel: activeChannelState.channel,
      tabs: [],
      currentTab: 'videos',
      videos: data.results || []
    });
  } catch {
    renderVideoFeed([], 'تعذر تحميل فيديوهات هذه القناة');
  }
}

async function toggleChannelSubscription(channel, button) {
  if (!state.currentUser) {
    showToast('سجّل الدخول للاشتراك في القنوات');
    openAuthModal();
    return;
  }
  if (!channel || (!channel.id && !channel.name)) return;

  if (button) {
    button.disabled = true;
    button.textContent = '...';
  }

  try {
    const response = await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: channel.id || '',
        channelName: channel.name || '',
        channelAvatar: channel.avatar || ''
      })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) throw new Error(data?.error || 'تعذر تحديث الاشتراك');

    state.subscriptions = Array.isArray(data.subscriptions) ? data.subscriptions : state.subscriptions;
    saveSubscriptions();
    channel.isSubscribed = !!data.subscribed;
    if (button) {
      button.textContent = data.subscribed ? 'مشترك ✓' : 'اشتراك';
      button.classList.toggle('subscribed', !!data.subscribed);
    }
    updateSubscribeUI();
    showToast(data.subscribed ? `تم الاشتراك في ${channel.name}` : `تم إلغاء الاشتراك من ${channel.name}`);
  } catch (error) {
    showToast(error.message || 'تعذر تحديث الاشتراك');
    if (button) {
      const subscribed = isSubscribed(channel.name, channel.id);
      button.textContent = subscribed ? 'مشترك ✓' : 'اشتراك';
      button.classList.toggle('subscribed', subscribed);
    }
  } finally {
    if (button) button.disabled = false;
  }
}

function renderChannelFeed(data) {
  if (!el.videosContainer) return;
  el.videosContainer.className = 'yt-channel-page-view';
  el.videosContainer.innerHTML = '';

  const channel = data.channel || activeChannelState.channel || {};
  const channelName = channel.name || 'قناة يوتيوب';
  const subscribed = isSubscribed(channel.name, channel.id) || !!channel.isSubscribed;
  const subsText = channel.subscribers || (subscribed ? 'مشترك في القناة' : 'قناة رسمية');
  const videoCountText = channel.videoCount || (data.videos?.length ? `${data.videos.length} فيديو` : 'محتوى متجدد');

  // 1. Channel Banner (If available, matching YouTube Image 1 & 2)
  if (channel.banner) {
    const bannerWrap = document.createElement('div');
    bannerWrap.className = 'ch-banner-wrap';
    bannerWrap.innerHTML = `
      <img src="${escapeHtml(channel.banner)}" class="ch-banner-img" alt="غلاف ${escapeHtml(channelName)}" referrerpolicy="no-referrer">
    `;
    el.videosContainer.appendChild(bannerWrap);
  }

  // 2. Channel Hero Header Card (Full-width, YouTube style)
  const headerCard = document.createElement('div');
  headerCard.className = 'ch-hero-card';
  headerCard.innerHTML = `
    <div class="ch-hero-avatar-wrap">
      <img src="${avatarSource(channel.name, channel.avatar)}" class="ch-hero-avatar" alt="${escapeHtml(channelName)}" referrerpolicy="no-referrer">
    </div>
    <div class="ch-hero-details">
      <div class="ch-hero-title-row">
        <h1 class="ch-hero-name">${escapeHtml(channelName)}</h1>
        <svg class="ch-verified-icon" viewBox="0 0 24 24" width="22" height="22" fill="#aaa" title="قناة موثقة"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-1.9 14.7l-4.5-4.5 1.4-1.4 3.1 3.1 7.4-7.4 1.4 1.4-8.8 8.8z"/></svg>
      </div>
      <div class="ch-hero-meta">
        <span class="ch-handle">@${escapeHtml(channelName.replace(/\s+/g, ''))}</span>
        <span class="ch-dot">•</span>
        <span class="ch-subs-count">${escapeHtml(subsText)}</span>
        <span class="ch-dot">•</span>
        <span class="ch-vids-count">${escapeHtml(videoCountText)}</span>
      </div>
      <div class="ch-hero-actions">
        <button type="button" class="btn-yt-sub ch-sub-btn${subscribed ? ' subscribed' : ''}" id="channelBannerSubBtn">
          ${subscribed ? 'مشترك ✓' : 'اشتراك'}
        </button>
      </div>
    </div>
  `;
  const heroAvatarImg = headerCard.querySelector('.ch-hero-avatar');
  if (heroAvatarImg) {
    heroAvatarImg.addEventListener('error', () => {
      if (channel.avatar && !heroAvatarImg.src.includes('/api/image-proxy')) {
        heroAvatarImg.src = `/api/image-proxy?url=${encodeURIComponent(channel.avatar)}`;
      }
    });
  }
  headerCard.querySelector('#channelBannerSubBtn')?.addEventListener('click', (event) => {
    toggleChannelSubscription(channel, event.currentTarget);
  });
  el.videosContainer.appendChild(headerCard);

  // 3. Channel Navigation Tabs Bar with In-Channel Search (Matching YouTube Image 1)
  const tabsBarWrap = document.createElement('div');
  tabsBarWrap.className = 'ch-tabs-bar-wrap';

  const tabsBar = document.createElement('div');
  tabsBar.className = 'ch-nav-tabs';
  tabsBar.id = 'channelNavTabs';

  const tabsList = (data.tabs && data.tabs.length) ? data.tabs : [
    { id: 'home', title: 'الصفحة الرئيسية' },
    { id: 'videos', title: 'الفيديوهات' },
    { id: 'shorts', title: 'Shorts' },
    { id: 'live', title: 'البث المباشر' },
    { id: 'podcasts', title: 'برامج البودكاست' },
    { id: 'playlists', title: 'قوائم التشغيل' },
    { id: 'community', title: 'المنشورات' }
  ];

  tabsList.forEach((t) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ch-tab${(t.id === (data.currentTab || 'home')) ? ' active' : ''}`;
    btn.dataset.tabId = t.id;
    btn.dataset.tabParams = t.params || '';
    btn.textContent = t.title;

    btn.addEventListener('click', () => {
      if (activeChannelState.currentTab === t.id && !t.params) return;
      tabsBar.querySelectorAll('.ch-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      switchChannelTab(t.id, t.params);
    });
    tabsBar.appendChild(btn);
  });

  // In-channel search input
  const searchWrap = document.createElement('div');
  searchWrap.className = 'ch-search-inline-wrap';
  searchWrap.innerHTML = `
    <input type="text" class="ch-search-input" id="chSearchInput" placeholder="بحث في القناة..." autocomplete="off">
    <button type="button" class="ch-search-btn-icon" id="chSearchBtn" title="بحث">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
    </button>
  `;

  const doSearch = () => {
    const q = searchWrap.querySelector('#chSearchInput')?.value.trim();
    if (q) searchWithinChannel(q);
  };
  searchWrap.querySelector('#chSearchBtn')?.addEventListener('click', doSearch);
  searchWrap.querySelector('#chSearchInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doSearch();
    }
  });

  tabsBarWrap.appendChild(tabsBar);
  tabsBarWrap.appendChild(searchWrap);
  el.videosContainer.appendChild(tabsBarWrap);

  // 4. Tab Content Container
  const tabContentEl = document.createElement('div');
  tabContentEl.id = 'channelTabContent';
  tabContentEl.className = 'ch-tab-content-container';
  el.videosContainer.appendChild(tabContentEl);

  renderChannelTabContent(data, data.currentTab || 'home');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function switchChannelTab(tabId, tabParams = '', options = {}) {
  activeChannelState.currentTab = tabId;
  if (!options.skipPush) {
    const ch = activeChannelState.channel || {};
    pushAppRoute({ channel: ch.name || '', cid: ch.id || '', tab: tabId || 'home' });
  }
  const contentEl = document.getElementById('channelTabContent');
  if (!contentEl) return;

  // Use cached data if available
  if (activeChannelState.cachedTabs[tabId]) {
    renderChannelTabContent(activeChannelState.cachedTabs[tabId], tabId);
    return;
  }

  contentEl.innerHTML = `
    <div style="padding: 40px; text-align: center; color: var(--text-secondary); font-size: 1.1rem;">
      <span class="spinner" style="display:inline-block; margin-bottom: 12px;"></span>
      <div>جاري تحميل محتوى ${escapeHtml(tabId)}...</div>
    </div>
  `;

  try {
    const channel = activeChannelState.channel || {};
    const params = new URLSearchParams();
    if (channel.id) params.set('channelId', channel.id);
    if (channel.name) params.set('name', channel.name);
    params.set('tab', tabId);
    if (tabParams) params.set('params', tabParams);

    const res = await fetch(`/api/channel?${params.toString()}`);
    const data = await res.json();
    if (data && data.success) {
      activeChannelState.cachedTabs[tabId] = data;
      renderChannelTabContent(data, tabId);
    } else {
      contentEl.innerHTML = '<div class="comments-empty">تعذر تحميل محتوى هذه القائمة حالياً.</div>';
    }
  } catch (err) {
    contentEl.innerHTML = '<div class="comments-empty">حدث خطأ أثناء تحميل المحتوى. يرجى المحاولة مرة أخرى.</div>';
  }
}

async function searchWithinChannel(query) {
  const contentEl = document.getElementById('channelTabContent');
  if (!contentEl) return;

  // Mark all tabs unselected
  document.querySelectorAll('#channelNavTabs .ch-tab').forEach(b => b.classList.remove('active'));

  contentEl.innerHTML = `
    <div style="padding: 40px; text-align: center; color: var(--text-secondary);">
      <span class="spinner" style="display:inline-block; margin-bottom: 12px;"></span>
      <div>جاري البحث عن "${escapeHtml(query)}" داخل القناة...</div>
    </div>
  `;

  try {
    const channel = activeChannelState.channel || {};
    const res = await fetch(`/api/channel?channelId=${encodeURIComponent(channel.id || '')}&name=${encodeURIComponent(channel.name || '')}&q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (data && data.success && data.videos) {
      contentEl.innerHTML = `
        <div class="ch-shelf-header" style="margin-bottom: 18px;">
          <h2 class="ch-shelf-title">نتائج البحث داخل القناة عن: "${escapeHtml(query)}" (${data.videos.length})</h2>
        </div>
      `;
      if (!data.videos.length) {
        contentEl.innerHTML += '<div class="comments-empty">لم يتم العثور على أي نتائج مطابقة داخل القناة.</div>';
        return;
      }
      const grid = document.createElement('div');
      grid.className = 'ch-videos-grid';
      data.videos.forEach(v => grid.appendChild(createVideoCard(v)));
      contentEl.appendChild(grid);
    } else {
      contentEl.innerHTML = '<div class="comments-empty">تعذر إتمام البحث.</div>';
    }
  } catch {
    contentEl.innerHTML = '<div class="comments-empty">خطأ في الاتصال أثناء البحث.</div>';
  }
}

function renderChannelTabContent(data, tabId) {
  const contentEl = document.getElementById('channelTabContent');
  if (!contentEl) return;
  contentEl.innerHTML = '';

  const channel = data.channel || activeChannelState.channel || {};

  // ==========================================
  // TAB 1: الصفحة الرئيسية (Home)
  // ==========================================
  if (tabId === 'home') {
    // 1. Featured Trailer Video (Matching YouTube Image 1)
    if (data.featuredVideo) {
      const f = data.featuredVideo;
      const featCard = document.createElement('div');
      featCard.className = 'ch-featured-card';
      featCard.innerHTML = `
        <div class="ch-featured-thumb-wrap">
          <img src="${escapeHtml(f.thumbnail)}" class="ch-featured-thumb" alt="${escapeHtml(f.title)}" loading="lazy">
          <div class="ch-featured-play-badge">
            <div class="ch-featured-play-icon">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            </div>
          </div>
        </div>
        <div class="ch-featured-info">
          <h2 class="ch-featured-title">${escapeHtml(f.title)}</h2>
          <div class="ch-featured-meta">
            <span>${escapeHtml(f.views || '')}</span>
            ${f.publishedTime ? `<span>•</span><span>${escapeHtml(f.publishedTime)}</span>` : ''}
          </div>
          ${f.description ? `<p class="ch-featured-desc">${escapeHtml(f.description)}</p>` : ''}
          <button type="button" class="ch-featured-play-btn" id="featPlayBtn">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            <span>تشغيل المقطع</span>
          </button>
        </div>
      `;
      featCard.addEventListener('click', () => openWatchView(f));
      const featImg = featCard.querySelector('.ch-featured-thumb');
      attachSafeThumbnail(featImg, f.id, f.thumbnail);
      contentEl.appendChild(featCard);
    }

    // 2. Shelves (Sections: Latest Videos, Premier League, Champions League, Shorts shelf, etc.)
    if (data.shelves && data.shelves.length) {
      data.shelves.forEach((shelf) => {
        const section = document.createElement('section');
        section.className = 'ch-shelf-section';

        if (shelf.type === 'shorts' && shelf.shorts && shelf.shorts.length) {
          section.innerHTML = `
            <div class="ch-shelf-header">
              <h2 class="ch-shelf-title">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="#ff334b"><path d="M17.77 10.32l-1.2-.5L18 9.06c1.84-.96 2.53-3.23 1.56-5.06s-3.24-2.53-5.07-1.56L6 6.94c-1.29.68-2.07 2.04-2 3.49.07 1.42.93 2.67 2.22 3.25.03.01 1.2.5 1.2.5L6 14.93c-1.83.97-2.53 3.24-1.56 5.07.97 1.83 3.24 2.53 5.07 1.56l8.5-4.5c1.29-.68 2.06-2.04 1.99-3.49-.07-1.42-.94-2.68-2.23-3.25zM10 14.65v-5.3L15 12l-5 2.65z"/></svg>
                <span>${escapeHtml(shelf.title || 'Shorts')}</span>
              </h2>
            </div>
          `;
          const sGrid = document.createElement('div');
          sGrid.className = 'ch-shorts-grid';
          const shortSubset = shelf.shorts.slice(0, 10);
          shortSubset.forEach((sh) => {
            sGrid.appendChild(createShortCard(sh, shortSubset));
          });
          section.appendChild(sGrid);
          contentEl.appendChild(section);
        } else if (shelf.videos && shelf.videos.length) {
          section.innerHTML = `
            <div class="ch-shelf-header">
              <h2 class="ch-shelf-title">
                <span>${escapeHtml(shelf.title || 'الفيديوهات')}</span>
                <button type="button" class="ch-playall-btn shelf-play-all">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                  <span>تشغيل الكل</span>
                </button>
              </h2>
            </div>
          `;
          const vGrid = document.createElement('div');
          vGrid.className = 'ch-videos-grid';
          shelf.videos.forEach((v) => {
            vGrid.appendChild(createVideoCard(v));
          });
          section.appendChild(vGrid);
          section.querySelector('.shelf-play-all')?.addEventListener('click', () => {
            if (shelf.videos[0]) openWatchView(shelf.videos[0]);
          });
          contentEl.appendChild(section);
        }
      });
    } else if (data.videos && data.videos.length) {
      const section = document.createElement('section');
      section.className = 'ch-shelf-section';
      section.innerHTML = `
        <div class="ch-shelf-header">
          <h2 class="ch-shelf-title">أحدث الفيديوهات</h2>
        </div>
      `;
      const grid = document.createElement('div');
      grid.className = 'ch-videos-grid';
      data.videos.forEach(v => grid.appendChild(createVideoCard(v)));
      section.appendChild(grid);
      contentEl.appendChild(section);
    }
    return;
  }

  // ==========================================
  // TAB 2: الفيديوهات (Videos Grid with sorting)
  // ==========================================
  if (tabId === 'videos') {
    const videosList = [...(data.videos || [])];
    const section = document.createElement('section');
    section.className = 'ch-shelf-section';
    section.innerHTML = `
      <div class="ch-shelf-header">
        <h2 class="ch-shelf-title">الفيديوهات (${videosList.length})</h2>
        <div class="ch-shelf-sort">
          <button type="button" class="ch-sort-pill active" id="sortLatestBtn">الأحدث</button>
          <button type="button" class="ch-sort-pill" id="sortPopularBtn">الأكثر رواجاً</button>
        </div>
      </div>
    `;

    const grid = document.createElement('div');
    grid.className = 'ch-videos-grid';
    videosList.forEach(v => grid.appendChild(createVideoCard(v)));
    section.appendChild(grid);
    contentEl.appendChild(section);

    const sortLatest = section.querySelector('#sortLatestBtn');
    const sortPopular = section.querySelector('#sortPopularBtn');

    sortPopular?.addEventListener('click', () => {
      sortPopular.classList.add('active');
      sortLatest?.classList.remove('active');
      const sorted = [...videosList].sort((a, b) => {
        const vA = parseInt(String(a.views || '0').replace(/[^0-9]/g, '')) || 0;
        const vB = parseInt(String(b.views || '0').replace(/[^0-9]/g, '')) || 0;
        return vB - vA;
      });
      grid.innerHTML = '';
      sorted.forEach(v => grid.appendChild(createVideoCard(v)));
    });

    sortLatest?.addEventListener('click', () => {
      sortLatest.classList.add('active');
      sortPopular?.classList.remove('active');
      grid.innerHTML = '';
      videosList.forEach(v => grid.appendChild(createVideoCard(v)));
    });
    return;
  }

  // ==========================================
  // TAB 3: Shorts (9:16 Vertical Cards)
  // ==========================================
  if (tabId === 'shorts') {
    const shortsList = data.shorts || [];
    const section = document.createElement('section');
    section.className = 'ch-shelf-section';
    section.innerHTML = `
      <div class="ch-shelf-header">
        <h2 class="ch-shelf-title">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="#ff334b"><path d="M17.77 10.32l-1.2-.5L18 9.06c1.84-.96 2.53-3.23 1.56-5.06s-3.24-2.53-5.07-1.56L6 6.94c-1.29.68-2.07 2.04-2 3.49.07 1.42.93 2.67 2.22 3.25.03.01 1.2.5 1.2.5L6 14.93c-1.83.97-2.53 3.24-1.56 5.07.97 1.83 3.24 2.53 5.07 1.56l8.5-4.5c1.29-.68 2.06-2.04 1.99-3.49-.07-1.42-.94-2.68-2.23-3.25zM10 14.65v-5.3L15 12l-5 2.65z"/></svg>
          <span>فيديوهات Shorts (${shortsList.length})</span>
        </h2>
      </div>
    `;

    if (!shortsList.length) {
      section.innerHTML += '<div class="comments-empty">لا توجد فيديوهات Shorts متاحة لهذه القناة.</div>';
      contentEl.appendChild(section);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'ch-shorts-grid';
    shortsList.forEach((sh) => {
      grid.appendChild(createShortCard(sh, shortsList));
    });
    section.appendChild(grid);
    contentEl.appendChild(section);
    return;
  }

  // ==========================================
  // TAB 4: البث المباشر (Live)
  // ==========================================
  if (tabId === 'live') {
    const liveList = data.videos || [];
    const section = document.createElement('section');
    section.className = 'ch-shelf-section';
    section.innerHTML = `
      <div class="ch-shelf-header">
        <h2 class="ch-shelf-title">
          <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:#ff0033; animation: pulse 1.5s infinite;"></span>
          <span>البث المباشر والأحداث السابقة</span>
        </h2>
      </div>
    `;

    if (!liveList.length) {
      section.innerHTML += '<div class="comments-empty">لا توجد بثوث مباشرة جارية حالياً لهذه القناة.</div>';
      contentEl.appendChild(section);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'ch-videos-grid';
    liveList.forEach((v) => {
      const card = createVideoCard(v);
      const thumbWrap = card.querySelector('.thumbnail-wrapper');
      if (thumbWrap) {
        const liveTag = document.createElement('span');
        liveTag.className = 'duration-tag';
        liveTag.style.background = '#cc0000';
        liveTag.textContent = 'مباشر 🔴';
        thumbWrap.appendChild(liveTag);
      }
      grid.appendChild(card);
    });
    section.appendChild(grid);
    contentEl.appendChild(section);
    return;
  }

  // ==========================================
  // TAB 5: برامج البودكاست (Podcasts)
  // ==========================================
  if (tabId === 'podcasts') {
    const podList = (data.podcasts && data.podcasts.length) ? data.podcasts : (data.videos || []);
    const section = document.createElement('section');
    section.className = 'ch-shelf-section';
    section.innerHTML = `
      <div class="ch-shelf-header">
        <h2 class="ch-shelf-title">🎙️ برامج البودكاست والتحليل الرياضي (${podList.length})</h2>
      </div>
    `;

    if (!podList.length) {
      section.innerHTML += '<div class="comments-empty">لا توجد حلقات بودكاست متاحة لهذه القناة حالياً.</div>';
      contentEl.appendChild(section);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'ch-podcasts-grid';
    podList.forEach((pod) => {
      const card = document.createElement('div');
      card.className = 'ch-podcast-card';
      const thumbUrl = pod.thumbnail || (pod.firstVideoId ? `https://i.ytimg.com/vi/${pod.firstVideoId}/hqdefault.jpg` : '');
      card.innerHTML = `
        <div class="ch-podcast-thumb-wrap">
          <img src="${escapeHtml(thumbUrl)}" class="ch-podcast-thumb" alt="${escapeHtml(pod.title)}" loading="lazy">
          <div class="ch-podcast-badge">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2H3v2a9 9 0 0 0 8 8.94V23h2v-2.06A9 9 0 0 0 21 12v-2h-2z"/></svg>
            <span>${escapeHtml(pod.episodeCountText || 'بودكاست')}</span>
          </div>
        </div>
        <h3 class="ch-podcast-title">${escapeHtml(pod.title)}</h3>
        <span class="ch-podcast-author">${escapeHtml(pod.channel || channel.name || 'قناة')}</span>
      `;
      const podImg = card.querySelector('.ch-podcast-thumb');
      attachSafeThumbnail(podImg, pod.firstVideoId, thumbUrl);
      const shImg = card.querySelector('.ch-short-thumb');
  attachSafeThumbnail(shImg, sh.id, sh.thumbnail);
  card.addEventListener('pointerenter', () => prefetchPlayer(sh.id), { passive: true });
  card.addEventListener('click', () => {
        if (pod.firstVideoId) {
          openWatchView({
            id: pod.firstVideoId,
            title: pod.title,
            channel: channel.name,
            channelAvatar: channel.avatar
          });
        } else if (pod.id) {
          openWatchView({
            id: pod.id,
            title: pod.title,
            channel: channel.name,
            channelAvatar: channel.avatar
          });
        }
      });
      grid.appendChild(card);
    });
    section.appendChild(grid);
    contentEl.appendChild(section);
    return;
  }

  // ==========================================
  // TAB 6: قوائم التشغيل (Playlists)
  // ==========================================
  if (tabId === 'playlists') {
    const plList = data.playlists || [];
    const section = document.createElement('section');
    section.className = 'ch-shelf-section';
    section.innerHTML = `
      <div class="ch-shelf-header">
        <h2 class="ch-shelf-title">قوائم التشغيل (${plList.length})</h2>
      </div>
    `;

    if (!plList.length) {
      section.innerHTML += '<div class="comments-empty">لا توجد قوائم تشغيل متاحة لهذه القناة حالياً.</div>';
      contentEl.appendChild(section);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'ch-playlists-grid';
    plList.forEach((pl) => {
      const card = document.createElement('div');
      card.className = 'ch-playlist-card';
      card.innerHTML = `
        <div class="ch-playlist-thumb-wrap">
          <img src="${escapeHtml(pl.thumbnail || '')}" class="ch-playlist-thumb" alt="${escapeHtml(pl.title)}" loading="lazy">
          <div class="ch-playlist-badge">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M4 10h12v2H4zm0-4h12v2H4zm0 8h8v2H4zm10 0v6l5-3z"/></svg>
            <span>${escapeHtml(pl.videoCountText || 'قائمة تشغيل')}</span>
          </div>
        </div>
        <h3 class="ch-playlist-title">${escapeHtml(pl.title)}</h3>
        <span class="ch-playlist-sub">عرض قائمة التشغيل كاملة</span>
      `;
      const shImg = card.querySelector('.ch-short-thumb');
  attachSafeThumbnail(shImg, sh.id, sh.thumbnail);
  card.addEventListener('pointerenter', () => prefetchPlayer(sh.id), { passive: true });
  card.addEventListener('click', () => {
        if (pl.firstVideoId) {
          openWatchView({
            id: pl.firstVideoId,
            title: pl.title,
            channel: channel.name,
            channelAvatar: channel.avatar
          });
        } else {
          showToast(`فتح قائمة: ${pl.title}`);
        }
      });
      const plImg = card.querySelector('.ch-playlist-thumb');
      attachSafeThumbnail(plImg, pl.firstVideoId, pl.thumbnail);
      grid.appendChild(card);
    });
    section.appendChild(grid);
    contentEl.appendChild(section);
    return;
  }

  // ==========================================
  // TAB 7: المنشورات (Community Posts Feed)
  // ==========================================
  if (tabId === 'community') {
    const postsList = data.posts || [];
    const section = document.createElement('section');
    section.className = 'ch-shelf-section';
    section.innerHTML = `
      <div class="ch-shelf-header">
        <h2 class="ch-shelf-title">منشورات القناة (${postsList.length})</h2>
      </div>
    `;

    if (!postsList.length) {
      section.innerHTML += '<div class="comments-empty">لا توجد منشورات متاحة في المنتدى لهذه القناة.</div>';
      contentEl.appendChild(section);
      return;
    }

    const feed = document.createElement('div');
    feed.className = 'ch-community-feed';
    postsList.forEach((p) => {
      const card = document.createElement('article');
      card.className = 'ch-post-card';
      card.innerHTML = `
        <div class="ch-post-header">
          <img src="${avatarSource(p.author, p.avatar)}" class="ch-post-avatar" alt="${escapeHtml(p.author)}" referrerpolicy="no-referrer">
          <div class="ch-post-author-wrap">
            <span class="ch-post-author">${escapeHtml(p.author || channel.name)}</span>
            <span class="ch-post-time">${escapeHtml(p.publishedTime || '')}</span>
          </div>
        </div>
        <div class="ch-post-content">${escapeHtml(p.content || '')}</div>
        ${p.image ? `
          <div class="ch-post-img-wrap">
            <img src="${escapeHtml(p.image)}" class="ch-post-img" alt="صورة المنشور" loading="lazy" referrerpolicy="no-referrer">
          </div>
        ` : ''}
        <div class="ch-post-actions">
          <button type="button" class="ch-post-like-btn" id="postLikeBtn">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg>
            <span>${escapeHtml(p.likes || '0')}</span>
          </button>
        </div>
      `;
      const likeBtn = card.querySelector('#postLikeBtn');
      likeBtn?.addEventListener('click', () => {
        likeBtn.style.color = '#3ea6ff';
        showToast('تم الإعجاب بالمنشور 👍');
      });
      feed.appendChild(card);
    });
    section.appendChild(feed);
    contentEl.appendChild(section);
    return;
  }
}

function createShortCard(sh, queueList = []) {
  const card = document.createElement('div');
  card.className = 'ch-short-card';
  card.innerHTML = `
    <div class="ch-short-thumb-wrap">
      <img src="${escapeHtml(sh.thumbnail)}" class="ch-short-thumb" alt="${escapeHtml(sh.title)}" loading="lazy">
      <div class="ch-short-badge">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M10 14.65v-5.3L15 12l-5 2.65z"/></svg>
        <span>Shorts</span>
      </div>
    </div>
    <div class="ch-short-info">
      <h3 class="ch-short-title">${escapeHtml(sh.title)}</h3>
      <span class="ch-short-views">${escapeHtml(sh.views)}</span>
    </div>
  `;
  const shImg = card.querySelector('.ch-short-thumb');
  attachSafeThumbnail(shImg, sh.id, sh.thumbnail);
  card.addEventListener('pointerenter', () => prefetchPlayer(sh.id), { passive: true });
  card.addEventListener('click', () => {
    const normalized = {
      id: sh.id,
      title: sh.title,
      channel: sh.channel || activeChannelState.channel?.name || '',
      channelId: sh.channelId || activeChannelState.channel?.id || '',
      channelAvatar: sh.channelAvatar || activeChannelState.channel?.avatar || '',
      thumbnail: sh.thumbnail,
      isShort: true
    };
    const q = (Array.isArray(queueList) && queueList.length)
      ? queueList.map(item => ({
          id: item.id,
          title: item.title,
          channel: item.channel || normalized.channel,
          channelId: item.channelId || normalized.channelId,
          channelAvatar: item.channelAvatar || normalized.channelAvatar,
          thumbnail: item.thumbnail,
          isShort: true
        }))
      : [normalized];
    openShortsView(normalized, q);
  });
  return card;
}

/* ============================================================
 * Dedicated Vertical YouTube-style Shorts Player (Image 1)
 * ============================================================ */
const shortsState = {
  active: false,
  queue: [],
  index: 0,
  currentData: null,
  currentVideo: null,
  requestId: 0,
  abortCtrl: null,
  isPlaying: false,
  wheelLocked: false
};

function setupShortsPlayer() {
  if (!el.shortsView || !el.shortsVideoEl || !el.shortsAudioEl) return;

  const toggleShortsPlay = () => {
    if (!shortsState.active || !el.shortsVideoEl) return;
    if (el.shortsVideoEl.paused) {
      el.shortsVideoEl.play().catch(() => {});
      if (el.shortsAudioEl.getAttribute('src')) {
        el.shortsAudioEl.currentTime = el.shortsVideoEl.currentTime;
        el.shortsAudioEl.play().catch(() => {});
      }
    } else {
      el.shortsVideoEl.pause();
      el.shortsAudioEl.pause();
    }
  };

  el.shortsCardFrame?.addEventListener('click', (e) => {
    if (e.target.closest('button, input, .shorts-bottom-overlay, .shorts-top-controls')) return;
    toggleShortsPlay();
  });

  el.shortsPlayBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleShortsPlay();
  });

  el.shortsVideoEl.addEventListener('play', () => {
    shortsState.isPlaying = true;
    if (el.shortsLoading) el.shortsLoading.style.display = 'none';
    if (el.shortsCenterStatus) el.shortsCenterStatus.style.display = 'none';
    if (el.shortsPlaySvg) el.shortsPlaySvg.innerHTML = `<path d="${ICON_PAUSE}"/>`;
    if (el.shortsAudioEl.getAttribute('src') && el.shortsAudioEl.paused) {
      el.shortsAudioEl.currentTime = el.shortsVideoEl.currentTime;
      el.shortsAudioEl.play().catch(() => {});
    }
  });

  el.shortsVideoEl.addEventListener('playing', () => {
    if (el.shortsLoading) el.shortsLoading.style.display = 'none';
  });

  el.shortsVideoEl.addEventListener('pause', () => {
    shortsState.isPlaying = false;
    if (el.shortsCenterStatus) el.shortsCenterStatus.style.display = 'flex';
    if (el.shortsPlaySvg) el.shortsPlaySvg.innerHTML = `<path d="${ICON_PLAY}"/>`;
    if (el.shortsAudioEl.getAttribute('src')) {
      el.shortsAudioEl.pause();
    }
  });

  el.shortsVideoEl.addEventListener('timeupdate', () => {
    const dur = el.shortsVideoEl.duration || 0;
    const cur = el.shortsVideoEl.currentTime || 0;
    if (dur > 0) {
      const pct = clamp((cur / dur) * 100, 0, 100);
      if (el.shortsProgressFill) el.shortsProgressFill.style.width = `${pct}%`;
      if (el.shortsSeekBar) el.shortsSeekBar.value = String(Math.round((cur / dur) * 1000));
    }
    if (el.shortsAudioEl.getAttribute('src') && !el.shortsVideoEl.paused && cur > 1.5 && el.shortsAudioEl.readyState >= 2) {
      const drift = Math.abs(el.shortsAudioEl.currentTime - cur);
      if (drift > 0.6) el.shortsAudioEl.currentTime = cur;
    }
  });

  el.shortsSeekBar?.addEventListener('input', () => {
    const dur = el.shortsVideoEl.duration || 0;
    if (!dur) return;
    const target = (Number(el.shortsSeekBar.value) / 1000) * dur;
    el.shortsVideoEl.currentTime = target;
    if (el.shortsAudioEl.getAttribute('src')) el.shortsAudioEl.currentTime = target;
    if (el.shortsProgressFill) el.shortsProgressFill.style.width = `${(target / dur) * 100}%`;
  });

  el.shortsMuteBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    state.muted = !state.muted;
    el.shortsAudioEl.muted = state.muted;
    try { localStorage.setItem('pb_muted', String(state.muted)); } catch {}
    updateShortsMuteUI();
  });

  el.shortsBackBtn?.addEventListener('click', () => {
    stopShortsPlayer();
    if (history.length > 1) {
      history.back();
    } else {
      showFeedView({ pause: true });
      pushAppRoute({});
    }
  });

  el.shortsPrevBtn?.addEventListener('click', (e) => { e.stopPropagation(); stepShort(-1); });
  el.shortsNextBtn?.addEventListener('click', (e) => { e.stopPropagation(); stepShort(1); });

  // Mouse wheel navigation between Shorts
  el.shortsView.addEventListener('wheel', (e) => {
    if (!shortsState.active) return;
    if (e.target.closest('.shorts-comments-drawer')) return;
    if (Math.abs(e.deltaY) < 25) return;
    e.preventDefault();
    if (shortsState.wheelLocked) return;
    shortsState.wheelLocked = true;
    setTimeout(() => { shortsState.wheelLocked = false; }, 260);
    stepShort(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  // Touch vertical swipe up/down navigation for mobile phones & APK
  let touchStartY = 0;
  let touchStartX = 0;
  el.shortsCardFrame?.addEventListener('touchstart', (e) => {
    if (!e.touches || !e.touches.length) return;
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
  }, { passive: true });
  el.shortsCardFrame?.addEventListener('touchend', (e) => {
    if (!shortsState.active || !e.changedTouches || !e.changedTouches.length) return;
    if (e.target.closest('.shorts-seek-input, button, input')) return;
    const dy = touchStartY - e.changedTouches[0].clientY;
    const dx = Math.abs(touchStartX - e.changedTouches[0].clientX);
    if (Math.abs(dy) > 48 && Math.abs(dy) > dx * 1.2) {
      stepShort(dy > 0 ? 1 : -1);
    }
  }, { passive: true });

  // Keyboard navigation in Shorts View (works anywhere unless typing text)
  document.addEventListener('keydown', (e) => {
    if (!shortsState.active) return;
    const tag = document.activeElement?.tagName;
    const inputType = (document.activeElement?.getAttribute?.('type') || '').toLowerCase();
    if (tag === 'TEXTAREA' || (tag === 'INPUT' && inputType !== 'range' && inputType !== 'button')) return;

    if (e.key === 'ArrowDown' || e.key === 'PageDown') {
      e.preventDefault();
      stepShort(1);
    } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
      e.preventDefault();
      stepShort(-1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      stopShortsPlayer();
      if (history.length > 1) history.back();
      else { showFeedView({ pause: true }); pushAppRoute({}); }
    } else if (e.key.toLowerCase() === 'm') {
      e.preventDefault();
      el.shortsMuteBtn?.click();
    } else if (e.key.toLowerCase() === 'k' || e.code === 'Space') {
      e.preventDefault();
      toggleShortsPlay();
    }
  });

  // Side action buttons
  el.shortsLikeBtn?.addEventListener('click', () => {
    if (!shortsState.currentVideo?.id) return;
    state.activeVideo = shortsState.currentVideo;
    setReaction('like');
    const isLiked = el.likeBtn?.classList.contains('active') || el.shortsLikeBtn.classList.toggle('active');
    el.shortsLikeBtn.classList.toggle('active', isLiked);
    el.shortsDislikeBtn?.classList.remove('active');
  });

  el.shortsDislikeBtn?.addEventListener('click', () => {
    if (!shortsState.currentVideo?.id) return;
    state.activeVideo = shortsState.currentVideo;
    setReaction('dislike');
    el.shortsDislikeBtn.classList.toggle('active');
    el.shortsLikeBtn?.classList.remove('active');
  });

  el.shortsShareBtn?.addEventListener('click', () => {
    if (!shortsState.currentVideo) return;
    state.activeVideo = shortsState.currentVideo;
    openShareModal();
  });

  el.shortsDownloadBtn?.addEventListener('click', () => {
    if (!shortsState.currentVideo) return;
    requirePro('تحميل المقطع', () => {
      state.activeVideo = shortsState.currentVideo;
      openDownloadModal();
    });
  });

  const openShortsChannel = (e) => {
    e.stopPropagation();
    const ch = shortsState.currentData?.channel || {};
    const name = ch.name || shortsState.currentVideo?.channel || '';
    const avatar = ch.avatar || shortsState.currentVideo?.channelAvatar || '';
    const cid = ch.id || shortsState.currentVideo?.channelId || '';
    if (name || cid) {
      stopShortsPlayer();
      openChannelPage(name, avatar, cid);
    }
  };
  el.shortsChannelAvatar?.addEventListener('click', openShortsChannel);
  el.shortsChannelName?.addEventListener('click', openShortsChannel);
  el.shortsSoundThumbBtn?.addEventListener('click', openShortsChannel);

  el.shortsSubBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const ch = shortsState.currentData?.channel || {
      id: shortsState.currentVideo?.channelId || '',
      name: shortsState.currentVideo?.channel || '',
      avatar: shortsState.currentVideo?.channelAvatar || ''
    };
    toggleChannelSubscription(ch, el.shortsSubBtn);
  });

  el.shortsCommentsBtn?.addEventListener('click', () => {
    if (!el.shortsCommentsDrawer) return;
    const isHidden = el.shortsCommentsDrawer.style.display === 'none';
    el.shortsCommentsDrawer.style.display = isHidden ? 'flex' : 'none';
    if (isHidden && shortsState.currentVideo?.id) {
      loadShortsComments(shortsState.currentVideo.id);
    }
  });

  el.shortsCloseDrawerBtn?.addEventListener('click', () => {
    if (el.shortsCommentsDrawer) el.shortsCommentsDrawer.style.display = 'none';
  });
}

function updateShortsMuteUI() {
  if (el.shortsMuteSvg) {
    el.shortsMuteSvg.innerHTML = `<path d="${state.muted ? MUTED_PATH : VOLUME_PATH}"/>`;
  }
}

let shortsMediaAbort = null;
let shortsStallTimer = null;

function clearShortsMediaState() {
  shortsMediaAbort?.abort();
  shortsMediaAbort = null;
  if (shortsStallTimer) {
    clearTimeout(shortsStallTimer);
    shortsStallTimer = null;
  }
}

function stopShortsPlayer() {
  shortsState.active = false;
  shortsState.abortCtrl?.abort();
  clearShortsMediaState();
  if (el.shortsLoading) el.shortsLoading.style.display = 'none';
  if (el.shortsVideoEl) {
    el.shortsVideoEl.pause();
    el.shortsVideoEl.removeAttribute('src');
    el.shortsVideoEl.removeAttribute('poster');
    el.shortsVideoEl.load();
  }
  if (el.shortsAudioEl) {
    el.shortsAudioEl.pause();
    el.shortsAudioEl.removeAttribute('src');
    el.shortsAudioEl.load();
  }
  if (el.shortsCommentsDrawer) el.shortsCommentsDrawer.style.display = 'none';
  if (el.shortsView) el.shortsView.style.display = 'none';
  if (el.appFooter) el.appFooter.style.display = '';
  syncNativePlaybackMeta(false);
}

function prefetchNextShorts() {
  if (!shortsState.active || !shortsState.queue.length) return;
  [shortsState.index + 1, shortsState.index + 2].forEach((i) => {
    const nextItem = shortsState.queue[i];
    if (nextItem?.id) prefetchPlayer(nextItem.id);
  });
}

function chooseShortsQuality(data) {
  const qs = Array.isArray(data?.qualities) ? data.qualities : [];
  if (!qs.length) return null;
  // Prefer H.264 MP4 <= 720p so Shorts switch instantaneously without AV1/VP9 decode freeze
  const h264 = qs.filter(q => /avc1/i.test(q.codecs || '') || q.mime === 'video/mp4');
  const pool = h264.length ? h264 : qs;
  return pool.find(q => q.height === 720)
    || pool.find(q => q.height === 480)
    || pool.find(q => q.height === 360)
    || pool[pool.length - 1];
}

let shortsQueueFetching = false;
async function ensureShortsQueuePopulated(playerData = null) {
  if (shortsQueueFetching || !shortsState.active) return;
  shortsQueueFetching = true;
  try {
    const ch = playerData?.channel || shortsState.currentData?.channel || {};
    const cid = ch.id || shortsState.currentVideo?.channelId || '';
    const cname = ch.name || shortsState.currentVideo?.channel || '';

    let candidates = [];
    if (cid || cname) {
      const chRes = await fetch(`/api/channel?channelId=${encodeURIComponent(cid)}&name=${encodeURIComponent(cname)}&tab=shorts`).then(r => r.json()).catch(() => null);
      if (chRes?.shorts?.length) candidates.push(...chRes.shorts);
    }

    if (candidates.length < 4) {
      const qRes = await fetch('/api/search?q=Shorts').then(r => r.json()).catch(() => null);
      if (qRes?.results?.length) {
        candidates.push(...qRes.results.filter(v => v.isShort || /shorts/i.test(v.title || '') || /shorts/i.test(v.url || '')));
        if (candidates.length < 4) candidates.push(...qRes.results.slice(0, 8));
      }
    }

    const existing = new Set(shortsState.queue.map(i => i.id));
    let added = 0;
    for (const item of candidates) {
      if (item?.id && !existing.has(item.id)) {
        existing.add(item.id);
        shortsState.queue.push({
          id: item.id,
          title: item.title || '',
          channel: item.channel || cname,
          channelId: item.channelId || cid,
          channelAvatar: item.channelAvatar || ch.avatar || '',
          thumbnail: item.thumbnail || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
          isShort: true
        });
        added++;
      }
    }
    if (added > 0) {
      if (el.shortsNextBtn) {
        el.shortsNextBtn.disabled = shortsState.index >= shortsState.queue.length - 1;
      }
      prefetchNextShorts();
    }
  } catch {}
  finally {
    shortsQueueFetching = false;
  }
}

function stepShort(delta) {
  if (!shortsState.queue.length) return;
  const nextIdx = shortsState.index + delta;
  if (nextIdx < 0 || nextIdx >= shortsState.queue.length) {
    if (delta > 0) ensureShortsQueuePopulated();
    return;
  }
  shortsState.index = nextIdx;
  const nextItem = shortsState.queue[nextIdx];
  pushAppRoute({ shorts: nextItem.id });
  loadShortItem(nextItem);
  if (nextIdx >= shortsState.queue.length - 2) {
    ensureShortsQueuePopulated();
  }
}

async function openShortsView(video, queue = [], preloadedData = null, options = {}) {
  if (!video || !video.id) return;
  pauseMedia();
  if (el.feedView) el.feedView.style.display = 'none';
  if (el.watchView) el.watchView.style.display = 'none';
  if (el.shortsView) el.shortsView.style.display = 'flex';
  if (el.appFooter) el.appFooter.style.display = 'none';

  shortsState.active = true;
  shortsState.queue = (Array.isArray(queue) && queue.length) ? queue : [video];
  const idx = shortsState.queue.findIndex(item => item.id === video.id);
  shortsState.index = idx >= 0 ? idx : 0;

  if (!options.skipPush) {
    pushAppRoute({ shorts: video.id });
  }

  if (el.shortsCommentsDrawer) el.shortsCommentsDrawer.style.display = 'none';
  await loadShortItem(video, preloadedData);
  if (shortsState.queue.length <= 2) {
    await ensureShortsQueuePopulated(shortsState.currentData);
  }
  prefetchNextShorts();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

async function loadShortItem(video, preloadedData = null) {
  if (!video || !video.id) return;
  const reqId = ++shortsState.requestId;
  shortsState.abortCtrl?.abort();
  const controller = new AbortController();
  shortsState.abortCtrl = controller;
  clearShortsMediaState();
  shortsState.currentVideo = video;
  state.activeVideo = video;

  // Immediately clear old Short's video & audio so previous frame NEVER stays stuck under new title!
  if (el.shortsVideoEl) {
    el.shortsVideoEl.pause();
    el.shortsVideoEl.removeAttribute('src');
    el.shortsVideoEl.poster = normalizeThumbUrl(video.thumbnail, video.id);
    el.shortsVideoEl.load();
  }
  if (el.shortsAudioEl) {
    el.shortsAudioEl.pause();
    el.shortsAudioEl.removeAttribute('src');
    el.shortsAudioEl.load();
  }
  if (el.shortsCenterStatus) el.shortsCenterStatus.style.display = 'none';

  if (el.shortsPrevBtn) el.shortsPrevBtn.disabled = shortsState.index <= 0;
  if (el.shortsNextBtn) el.shortsNextBtn.disabled = shortsState.index >= shortsState.queue.length - 1;
  if (el.shortsTitle) el.shortsTitle.textContent = video.title || '';
  if (el.shortsChannelName) el.shortsChannelName.textContent = video.channel ? `@${video.channel.replace(/\s+/g, '')}` : '@AYTube';
  if (el.shortsChannelAvatar) el.shortsChannelAvatar.src = avatarSource(video.channel, video.channelAvatar);
  if (el.shortsSoundThumbImg) el.shortsSoundThumbImg.src = avatarSource(video.channel, video.channelAvatar);
  if (el.shortsProgressFill) el.shortsProgressFill.style.width = '0%';
  if (el.shortsSeekBar) el.shortsSeekBar.value = '0';
  if (el.shortsLikeBtn) el.shortsLikeBtn.classList.remove('active');
  if (el.shortsDislikeBtn) el.shortsDislikeBtn.classList.remove('active');
  updateShortsMuteUI();

  const cached = preloadedData || getCachedPlayerPayload(video.id);
  if (el.shortsLoading) el.shortsLoading.style.display = cached ? 'none' : 'flex';

  let data = cached;
  if (!data) {
    try {
      data = await fetchPlayerPayload(video.id, { signal: controller.signal });
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }

  if (reqId !== shortsState.requestId || !shortsState.active) return;
  if (!data || !data.success || !data.video) {
    if (el.shortsLoading) el.shortsLoading.style.display = 'none';
    showToast('تعذر تحميل مقطع Shorts');
    return;
  }

  shortsState.currentData = data;
  prefetchNextShorts();

  const chName = data.channel?.name || video.channel || '';
  const chAvatar = data.channel?.avatar || video.channelAvatar || '';
  const subscribed = isSubscribed(chName, data.channel?.id);

  if (el.shortsTitle) el.shortsTitle.textContent = data.video.title || video.title || '';
  if (el.shortsChannelName) el.shortsChannelName.textContent = chName ? `@${chName.replace(/\s+/g, '')}` : '@AYTube';
  if (el.shortsChannelAvatar) el.shortsChannelAvatar.src = avatarSource(chName, chAvatar);
  if (el.shortsSoundThumbImg) el.shortsSoundThumbImg.src = avatarSource(chName, chAvatar);
  if (el.shortsSubBtn) {
    el.shortsSubBtn.textContent = subscribed ? 'مشترك ✓' : 'اشتراك';
    el.shortsSubBtn.classList.toggle('subscribed', subscribed);
  }
  if (el.shortsLikeCount) {
    el.shortsLikeCount.textContent = data.video.likeCountText || (data.video.likes ? compactNumber(data.video.likes) : 'إعجاب');
  }
  if (el.shortsCommentsCount) {
    el.shortsCommentsCount.textContent = data.comments?.countText ? data.comments.countText.replace(/\D*تعليق.*/, '').trim() || 'تعليقات' : 'تعليقات';
  }

  document.title = `${data.video.title || 'Shorts'} - AYTube`;
  addToHistory({
    ...video,
    title: data.video.title || video.title,
    channel: chName,
    channelId: data.channel?.id || '',
    channelAvatar: chAvatar,
    thumbnail: data.video.thumbnail || video.thumbnail,
    isShort: true
  });

  const bestQuality = chooseShortsQuality(data) || chooseInitialQuality(data);
  if (bestQuality && el.shortsVideoEl) {
    const mediaCtrl = new AbortController();
    shortsMediaAbort = mediaCtrl;
    let fallbackStep = 0;

    const loadShortSources = (q, useProxy = false) => {
      if (reqId !== shortsState.requestId || !shortsState.active) return;
      const vidUrl = useProxy
        ? `/api/stream?v=${encodeURIComponent(video.id)}&itag=${encodeURIComponent(q.itag)}`
        : q.url;
      const audUrl = data.audio?.url
        ? (useProxy ? `/api/stream?v=${encodeURIComponent(video.id)}&type=audio` : data.audio.url)
        : '';

      el.shortsVideoEl.pause();
      el.shortsVideoEl.muted = true;
      el.shortsVideoEl.poster = normalizeThumbUrl(data.video.thumbnail || video.thumbnail, video.id);
      el.shortsVideoEl.src = vidUrl;
      el.shortsVideoEl.load();

      if (audUrl && el.shortsAudioEl) {
        el.shortsAudioEl.src = audUrl;
        el.shortsAudioEl.muted = state.muted;
        el.shortsAudioEl.volume = state.volume;
        el.shortsAudioEl.load();
      } else if (el.shortsAudioEl) {
        el.shortsAudioEl.removeAttribute('src');
        el.shortsAudioEl.load();
      }
    };

    const recoverShortStream = () => {
      if (reqId !== shortsState.requestId || !shortsState.active) return;
      fallbackStep++;
      if (fallbackStep === 1) {
        const alt = (data.qualities || []).find(q => q.itag !== bestQuality.itag && q.height <= 480) || bestQuality;
        loadShortSources(alt, true);
      } else if (fallbackStep === 2) {
        loadShortSources(bestQuality, true);
      } else {
        if (el.shortsLoading) el.shortsLoading.style.display = 'none';
      }
    };

    const playShort = () => {
      if (reqId !== shortsState.requestId || !shortsState.active) return;
      if (shortsStallTimer) {
        clearTimeout(shortsStallTimer);
        shortsStallTimer = null;
      }
      if (el.shortsLoading) el.shortsLoading.style.display = 'none';
      el.shortsVideoEl.play().catch(() => {});
      if (el.shortsAudioEl?.getAttribute('src')) {
        el.shortsAudioEl.muted = state.muted;
        el.shortsAudioEl.volume = state.volume;
        el.shortsAudioEl.play().catch(() => {});
      }
    };

    el.shortsVideoEl.addEventListener('loadeddata', playShort, { once: true, signal: mediaCtrl.signal });
    el.shortsVideoEl.addEventListener('canplay', playShort, { once: true, signal: mediaCtrl.signal });
    el.shortsVideoEl.addEventListener('error', recoverShortStream, { signal: mediaCtrl.signal });

    loadShortSources(bestQuality, false);
    if (el.shortsVideoEl.readyState >= 2) {
      playShort();
    } else {
      shortsStallTimer = setTimeout(() => {
        if (reqId === shortsState.requestId && shortsState.active && el.shortsVideoEl.readyState < 2) {
          recoverShortStream();
        }
      }, 3600);
    }
  } else if (el.shortsLoading) {
    el.shortsLoading.style.display = 'none';
  }
}

async function loadShortsComments(videoId) {
  if (!el.shortsDrawerList) return;
  el.shortsDrawerList.innerHTML = '<div class="comments-empty">جاري تحميل التعليقات...</div>';
  try {
    const res = await fetch(`/api/comments?v=${encodeURIComponent(videoId)}`);
    const data = await res.json();
    const list = data?.comments || [];
    if (!list.length) {
      el.shortsDrawerList.innerHTML = '<div class="comments-empty">لا توجد تعليقات حالياً.</div>';
      return;
    }
    el.shortsDrawerList.innerHTML = '';
    list.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'comment-row';
      row.innerHTML = `
        <img class="comment-avatar" src="${avatarSource(c.author, c.avatar)}" alt="${escapeHtml(c.author)}" referrerpolicy="no-referrer">
        <div class="comment-body">
          <div class="comment-header">
            <span class="comment-author">${escapeHtml(c.author)}</span>
            <span class="comment-time">${escapeHtml(c.publishedTime || '')}</span>
          </div>
          <div class="comment-text">${escapeHtml(c.text || '')}</div>
        </div>
      `;
      el.shortsDrawerList.appendChild(row);
    });
  } catch {
    el.shortsDrawerList.innerHTML = '<div class="comments-empty">تعذر تحميل التعليقات.</div>';
  }
}

/* ============================================================
 * Adaptive Quality Engine (auto drops on slow network, raises on fast)
 * ============================================================ */
function setupAdaptiveQuality() {
  if (!navigator.connection) return;
  const conn = navigator.connection;
  function evaluateSpeed() {
    if (state.prefQuality !== 'auto' || !state.playerData) return;
    const speed = conn.downlink || 5;
    const type = conn.effectiveType || '';
    if (type === '2g' || type === 'slow-2g' || speed < 1.0) {
      if (state.selectedQualityItag && state.qualities.length) {
        const low = state.qualities.find(q => q.height <= 360) || state.qualities[0];
        if (low && low.itag !== state.selectedQualityItag) setQuality(low, { auto: true });
      }
    } else if ((type === '4g' || speed >= 6.0) && state.selectedQualityItag && state.qualities.length) {
      const high = state.qualities.find(q => q.height === 720) || state.qualities.find(q => q.height === 1080);
      if (high && high.itag !== state.selectedQualityItag) setQuality(high, { auto: true });
    }
  }
  conn.addEventListener('change', evaluateSpeed);
  evaluateSpeed();
}

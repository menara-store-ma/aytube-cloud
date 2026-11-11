import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import ffmpegPath from 'ffmpeg-static';
import { searchVideos, getSuggestions, extractVideoId } from '../api-tools/playback-cli.mjs';
import { Ytdl, Client } from '@distube/ytdl-core';
import {
  getStore,
  saveStore,
  newId,
  normalizeEmail,
  hashPassword,
  verifyPassword,
  findUserByEmail,
  findUserById,
  createUser,
  publicUser,
  importLegacyHistory
} from './store.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

// Auto-load .env file if present
const ENV_FILE = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE)) {
  try {
    const lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key] && val) {
          process.env[key] = val;
        }
      }
    }
  } catch (e) {
    console.warn('Notice: .env read:', e.message);
  }
}

// Prevent unexpected server crashes
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception intercepted:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection intercepted:', reason);
});

const PORT = process.env.PORT || 3400;
const ytdl = new Ytdl();

// ============================================================
// 👑 Centralized Cloud Master PRO Control (Revokes ALL devices globally)
// ============================================================
const CLOUD_PRO_PRIMARY = process.env.CLOUD_PRO_URL || 'https://menara-store-ma.github.io/aytube-cloud/pro.json';
const CLOUD_PRO_FALLBACK = 'https://raw.githubusercontent.com/menara-store-ma/aytube-cloud/main/docs/pro.json';
const CLOUD_PRO_API = 'https://api.github.com/repos/menara-store-ma/aytube-cloud/contents/docs/pro.json';

function sha256EpochHash(cleanCode) {
  return crypto.createHash('sha256').update(`AYTUBE_PRO_V1:${cleanCode}`).digest('hex');
}

const cloudProState = {
  codeHash: '',
  proEnabled: true,
  epoch: 0,
  updatedAt: '',
  lastSyncAt: 0,
  lastApiAt: 0
};

function initCloudProFromLocal() {
  try {
    const saved = getStore().cloudPro;
    if (saved && saved.codeHash) {
      cloudProState.codeHash = String(saved.codeHash).trim().toLowerCase();
      cloudProState.proEnabled = saved.proEnabled !== false;
      cloudProState.epoch = Number(saved.epoch || 0);
      cloudProState.updatedAt = String(saved.updatedAt || '');
    }
    const envHash = String(process.env.PRO_MASTER_HASH || '').trim().toLowerCase();
    const envCode = String(process.env.PRO_MASTER_CODE || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!cloudProState.codeHash && (envHash || envCode)) {
      cloudProState.codeHash = envHash || sha256EpochHash(envCode);
      cloudProState.proEnabled = process.env.PRO_ENABLED !== '0';
    }
  } catch {}
}
initCloudProFromLocal();

async function fetchJsonWithTimeout(url, acceptHeader) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4500);
  try {
    const headers = {
      'Cache-Control': 'no-cache, no-store, max-age=0',
      'Pragma': 'no-cache',
      'User-Agent': 'AYTube-Server/3.0'
    };
    if (acceptHeader) headers.Accept = acceptHeader;
    const res = await fetch(url, { signal: ac.signal, headers });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data) return null;
    if (data.codeHash) return data;
    if (data.content) {
      const inner = JSON.parse(Buffer.from(String(data.content), 'base64').toString('utf8'));
      if (inner && inner.codeHash) return inner;
    }
  } catch {} finally {
    clearTimeout(timer);
  }
  return null;
}

function pickBetterCloudPro(best, cand) {
  if (!cand || !cand.codeHash) return best;
  if (!best) return cand;
  const be = Number(best.epoch || 0);
  const ce = Number(cand.epoch || 0);
  if (ce > be) return cand;
  if (ce === be && String(cand.updatedAt || '') > String(best.updatedAt || '')) return cand;
  return best;
}

let cloudSyncPromise = null;
async function syncCloudProConfig(force = false) {
  const now = Date.now();
  if (!force && (now - cloudProState.lastSyncAt) < 12000 && cloudProState.codeHash) {
    return cloudProState;
  }
  if (cloudSyncPromise) return cloudSyncPromise;

  cloudSyncPromise = (async () => {
    try {
      const ts = Date.now();
      let best = null;
      if ((force || !cloudProState.codeHash) && (ts - cloudProState.lastApiAt) >= 15000) {
        cloudProState.lastApiAt = ts;
        best = pickBetterCloudPro(best, await fetchJsonWithTimeout(CLOUD_PRO_API, 'application/vnd.github+json'));
      }
      best = pickBetterCloudPro(best, await fetchJsonWithTimeout(`${CLOUD_PRO_PRIMARY}?cb=${ts}`));
      if (!best || !force) {
        best = pickBetterCloudPro(best, await fetchJsonWithTimeout(`${CLOUD_PRO_FALLBACK}?cb=${ts}`));
      }
      if (best && best.codeHash) {
        const ep = Number(best.epoch || 0);
        const upd = String(best.updatedAt || '');
        const shouldAccept = ep > cloudProState.epoch || (ep === cloudProState.epoch && upd >= cloudProState.updatedAt);
        if (shouldAccept) {
          cloudProState.codeHash = String(best.codeHash).trim().toLowerCase();
          cloudProState.proEnabled = best.proEnabled !== false;
          cloudProState.epoch = ep;
          cloudProState.updatedAt = upd;
          const store = getStore();
          store.cloudPro = {
            codeHash: cloudProState.codeHash,
            proEnabled: cloudProState.proEnabled,
            epoch: cloudProState.epoch,
            updatedAt: cloudProState.updatedAt
          };
          saveStore();
        }
      }
      cloudProState.lastSyncAt = Date.now();
    } finally {
      cloudSyncPromise = null;
    }
    return cloudProState;
  })();

  return cloudSyncPromise;
}

syncCloudProConfig(true).catch(() => {});

const YT_INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const WEB_CLIENT = {
  clientName: 'WEB',
  clientVersion: '2.20251001.00.00',
  hl: 'ar',
  gl: 'MA'
};
const YT_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
  'X-Youtube-Client-Name': '1',
  'X-Youtube-Client-Version': WEB_CLIENT.clientVersion,
  'Origin': 'https://www.youtube.com',
  'Referer': 'https://www.youtube.com/'
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.vtt': 'text/vtt; charset=utf-8',
  '.woff2': 'font/woff2'
};

// ============================================================
// Helpers
// ============================================================
function sendJSON(res, statusCode, data, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
}

function decodeEntities(text = '') {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)));
}

function runsText(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (obj.simpleText) return obj.simpleText;
  if (Array.isArray(obj.runs)) return obj.runs.map(r => r.text || '').join('');
  return '';
}

function findFirst(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 30) return null;
  if (obj[key]) return obj[key];
  for (const k of Object.keys(obj)) {
    const found = findFirst(obj[k], key, depth + 1);
    if (found) return found;
  }
  return null;
}

function findAll(obj, key, out = [], depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 30) return out;
  if (obj[key]) out.push(obj[key]);
  for (const k of Object.keys(obj)) findAll(obj[k], key, out, depth + 1);
  return out;
}

function safeDecodeURIComponent(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function cookieValue(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return safeDecodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

// ============================================================
// YouTube InnerTube
// ============================================================
async function ytNext(payload) {
  const res = await fetch(
    `https://www.youtube.com/youtubei/v1/next?key=${YT_INNERTUBE_KEY}&prettyPrint=false`,
    {
      method: 'POST',
      headers: YT_HEADERS,
      body: JSON.stringify({ context: { client: WEB_CLIENT }, ...payload })
    }
  );
  if (!res.ok) throw new Error(`YouTube next HTTP ${res.status}`);
  return res.json();
}

async function ytBrowse(payload) {
  const res = await fetch(
    `https://www.youtube.com/youtubei/v1/browse?key=${YT_INNERTUBE_KEY}&prettyPrint=false`,
    {
      method: 'POST',
      headers: YT_HEADERS,
      body: JSON.stringify({ context: { client: WEB_CLIENT }, ...payload })
    }
  );
  if (!res.ok) throw new Error(`YouTube browse HTTP ${res.status}`);
  return res.json();
}

// ============================================================
// Player data cache + fast prewarm queue
// ============================================================
const playerCache = new Map();
const playerInflight = new Map();
const PLAYER_CACHE_TTL = 15 * 60 * 1000;
const prewarmPending = [];
let prewarmActive = 0;

function enqueuePrewarm(ids) {
  if (!Array.isArray(ids) || !ids.length) return;
  for (const id of ids) {
    if (!id || playerCache.has(id) || playerInflight.has(id) || prewarmPending.includes(id)) continue;
    if (prewarmPending.length >= 24) break;
    prewarmPending.push(id);
  }
  drainPrewarmQueue();
}

function drainPrewarmQueue() {
  while (prewarmActive < 2 && prewarmPending.length > 0) {
    const nextId = prewarmPending.shift();
    if (!nextId || playerCache.has(nextId)) continue;
    prewarmActive++;
    getPlayerData(nextId)
      .catch(() => {})
      .finally(() => {
        prewarmActive--;
        drainPrewarmQueue();
      });
  }
}

function parseStandardQualityHeight(f) {
  const labelNum = parseInt(f.qualityLabel, 10);
  if (labelNum && [144, 240, 360, 480, 720, 1080, 1440, 2160].includes(labelNum)) {
    return labelNum;
  }
  const w = Number(f.width) || 0;
  const h = Number(f.height) || 0;
  if (w > 0 && h > 0) {
    const shortSide = Math.min(w, h);
    if (shortSide >= 2000) return 2160;
    if (shortSide >= 1300) return 1440;
    if (shortSide >= 1000) return 1080;
    if (shortSide >= 680) return 720;
    if (shortSide >= 450) return 480;
    if (shortSide >= 330) return 360;
    if (shortSide >= 220) return 240;
    return 144;
  }
  return h || labelNum || 0;
}

function buildQualities(formats) {
  const groups = new Map();
  for (const f of formats) {
    if (!f.url || !f.hasVideo || !f.mimeType) continue;
    const height = parseStandardQualityHeight(f);
    if (!height) continue;
    const mime = f.mimeType.split(';')[0];
    if (mime !== 'video/mp4' && mime !== 'video/webm') continue;

    const isAvc = /avc1/i.test(f.mimeType);
    const isVp9 = /vp9/i.test(f.mimeType);
    const isAv1 = /av01/i.test(f.mimeType);
    // H.264 MP4 is the most compatible option for browsers.
    const score = (isAvc ? 100 : 0) + (isVp9 ? 40 : 0) + (isAv1 ? 5 : 0) + (mime === 'video/mp4' ? 10 : 0);
    const current = groups.get(height);
    if (!current || score > current.score) {
      groups.set(height, {
        itag: f.itag,
        height,
        width: Number(f.width) || 0,
        videoHeight: Number(f.height) || 0,
        label: f.qualityLabel || `${height}p`,
        mime,
        codecs: (f.mimeType.match(/codecs="?([^"]+)"?/) || [])[1] || '',
        url: f.url,
        score,
        fps: f.fps || 30,
        bitrate: f.bitrate || 0,
        hasAudio: !!f.hasAudio
      });
    }
  }
  return [...groups.values()].sort((a, b) => a.height - b.height);
}

function buildAudio(formats) {
  const audios = formats.filter(f => f.url && f.hasAudio && !f.hasVideo);
  if (!audios.length) return null;
  audios.sort((a, b) => {
    const aMp4 = /mp4a/i.test(a.mimeType) ? 100 : 0;
    const bMp4 = /mp4a/i.test(b.mimeType) ? 100 : 0;
    return (bMp4 + (b.bitrate || b.audioBitrate || 0) / 1000) - (aMp4 + (a.bitrate || a.audioBitrate || 0) / 1000);
  });
  const a = audios[0];
  return {
    itag: a.itag,
    mime: a.mimeType.split(';')[0],
    codecs: (a.mimeType.match(/codecs="?([^"]+)"?/) || [])[1] || '',
    url: a.url,
    bitrate: a.bitrate || a.audioBitrate || 0
  };
}

function buildCaptions(info) {
  const seen = new Set();
  const captions = [];
  for (const t of info.captionTracks || []) {
    if (!t.url) continue;
    const key = `${t.languageCode}:${t.isAutoGenerated ? 'auto' : 'manual'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    captions.push({
      code: t.languageCode,
      name: t.name || t.languageCode,
      auto: !!t.isAutoGenerated,
      isDefault: !!t.isDefault
    });
  }
  return captions;
}

function buildRelated(info) {
  const related = [];
  const seen = new Set();
  for (const v of info.relatedVideos || []) {
    if (!v || !v.id || seen.has(v.id)) continue;
    seen.add(v.id);
    const thumbs = v.thumbnails || [];
    const thumb = thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`;
    related.push({
      id: v.id,
      title: v.title || '',
      channel: v.author?.name || '',
      channelAvatar: v.author?.thumbnails?.[v.author.thumbnails.length - 1]?.url || '',
      duration: v.lengthSeconds || 0,
      views: v.viewCount || 0,
      thumbnail: thumb
    });
    if (related.length >= 18) break;
  }
  return related;
}

function extractCommentsMeta(nextResponse) {
  if (!nextResponse) return { available: false, sortTokens: [], countText: '' };
  const panels = findAll(nextResponse, 'engagementPanelSectionListRenderer');
  const panel = panels.find(p => String(p.panelIdentifier || '').includes('comment'));
  if (!panel) return { available: false, sortTokens: [], countText: '' };

  const header = panel.header?.engagementPanelTitleHeaderRenderer;
  const menu = header?.menu?.sortFilterSubMenuRenderer;
  const items = menu?.subMenuItems || [];
  const sortTokens = items
    .map(item => ({
      title: runsText(item.title),
      token: item.serviceEndpoint?.continuationCommand?.token
    }))
    .filter(item => item.token);

  return {
    available: sortTokens.length > 0,
    sortTokens,
    countText: runsText(header?.contextualInfo)
  };
}

function extractLikeCountText(nextResponse) {
  if (!nextResponse) return '';
  try {
    const viewModel = findAll(nextResponse, 'segmentedLikeDislikeButtonViewModel')[0];
    const likeText = viewModel?.likeButtonViewModel?.likeButtonViewModel?.toggleButtonViewModel?.toggleButtonViewModel?.defaultButtonViewModel?.buttonViewModel?.title;
    if (likeText) return likeText;
    const toggleBtn = findAll(nextResponse, 'toggleButtonRenderer').find(b => /like|إعجاب/i.test(JSON.stringify(b)));
    if (toggleBtn) return runsText(toggleBtn.defaultText);
  } catch {}
  return '';
}

function buildPlayerPayload(info, nextResponse) {
  const details = info.videoDetails || {};
  const qualities = buildQualities(info.formats || []);
  if (!qualities.length) throw new Error('لا توجد جودة فيديو متاحة لهذا المقطع');

  const audio = buildAudio(info.formats || []);
  const captions = buildCaptions(info);
  const commentsMeta = extractCommentsMeta(nextResponse);
  const author = details.author || {};

  const preferred = [720, 1080, 480, 360, 240, 144].find(h => qualities.some(q => q.height === h));
  const highestSafe = [...qualities].reverse().find(q => q.height <= 1080) || qualities[qualities.length - 1];
  const defaultQuality = qualities.find(q => q.height === preferred) || highestSafe || qualities[0];
  const isPortrait = Boolean(defaultQuality.width && defaultQuality.videoHeight && defaultQuality.videoHeight > defaultQuality.width);

  const thumbnail = (details.thumbnails || [])[details.thumbnails?.length - 1]?.url
    || `https://i.ytimg.com/vi/${details.id}/hqdefault.jpg`;

  const likeCountText = extractLikeCountText(nextResponse);

  return {
    ok: true,
    video: {
      id: details.id,
      title: details.title || '',
      description: details.description || '',
      lengthSeconds: Number(details.lengthSeconds) || 0,
      viewCount: Number(details.viewCount) || 0,
      likes: Number(details.likes) || 0,
      likeCountText,
      publishDate: details.publishDate || '',
      uploadDate: details.uploadDate || '',
      category: details.category || '',
      keywords: details.keywords || [],
      isLive: !!details.isLive,
      isPortrait,
      thumbnail
    },
    channel: {
      id: author.id || '',
      name: author.name || details.author?.name || '',
      avatar: author.thumbnails?.[author.thumbnails.length - 1]?.url || '',
      subscribers: author.subscriberCount || 0,
      verified: !!author.verified
    },
    qualities,
    defaultQualityItag: defaultQuality.itag,
    playableInEmbed: info.playerResponse?.playabilityStatus?.playableInEmbed !== false,
    audio,
    captions,
    comments: commentsMeta,
    related: buildRelated(info)
  };
}

async function getPlayerData(videoId) {
  const cached = playerCache.get(videoId);
  if (cached && Date.now() - cached.at < PLAYER_CACHE_TTL) return cached;

  if (playerInflight.has(videoId)) {
    return playerInflight.get(videoId);
  }

  const job = (async () => {
    const [infoResult, nextResult] = await Promise.allSettled([
      ytdl.getInfo(videoId),
      ytNext({ videoId })
    ]);

    if (infoResult.status === 'rejected') throw infoResult.reason;
    const info = infoResult.value;
    const nextResponse = nextResult.status === 'fulfilled' ? nextResult.value : null;
    const data = buildPlayerPayload(info, nextResponse);

    const entry = { info, nextResponse, data, at: Date.now() };
    if (playerCache.size > 150) {
      const oldest = playerCache.keys().next().value;
      playerCache.delete(oldest);
    }
    playerCache.set(videoId, entry);
    return entry;
  })();

  playerInflight.set(videoId, job);
  try {
    return await job;
  } finally {
    playerInflight.delete(videoId);
  }
}

async function getRawInfo(videoId) {
  const entry = await getPlayerData(videoId);
  return entry.info;
}

// ============================================================
// Captions + translation
// ============================================================
const captionCache = new Map();
const CAPTION_CACHE_TTL = 30 * 60 * 1000;

function parseCaptionJson(json) {
  const events = json?.events || [];
  const cues = [];
  for (const ev of events) {
    if (!ev || typeof ev.tStartMs !== 'number') continue;
    const text = (ev.segs || [])
      .map(seg => seg.utf8 || '')
      .join('')
      .replace(/\u200b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;

    const start = ev.tStartMs / 1000;
    const dur = (ev.dDurationMs || 0) / 1000;
    const last = cues[cues.length - 1];

    if (last && Math.abs(start - last.start) < 0.03) {
      if (!last.text.includes(text)) last.text = `${last.text} ${text}`.trim();
      continue;
    }
    if (last && last.text === text && start - last.start < 0.8) continue;

    cues.push({ start, dur, text });
  }

  for (let i = 0; i < cues.length; i++) {
    if (!cues[i].dur || cues[i].dur <= 0) {
      cues[i].dur = Math.max(1, (cues[i + 1]?.start || cues[i].start + 3) - cues[i].start);
    }
    cues[i].start = Math.round(cues[i].start * 1000) / 1000;
    cues[i].dur = Math.round(cues[i].dur * 1000) / 1000;
  }
  return cues;
}

function parseCaptionXml(xml) {
  const cues = [];
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = re.exec(xml))) {
    const attrs = match[1];
    const start = parseFloat((attrs.match(/\bstart="([^"]+)"/) || [])[1] || '0');
    const dur = parseFloat((attrs.match(/\bdur="([^"]+)"/) || [])[1] || '0');
    const text = decodeEntities(match[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (text) cues.push({ start, dur: dur || 2, text });
  }
  return cues;
}

const translationCache = new Map();

async function translateTexts(texts, targetLang) {
  const results = new Array(texts.length);
  const groups = [];
  let current = [];
  let currentLength = 0;

  texts.forEach((text, index) => {
    const cost = encodeURIComponent(text).length + 8;
    if (current.length >= 40 || currentLength + cost > 1600) {
      if (current.length) groups.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(index);
    currentLength += cost;
  });
  if (current.length) groups.push(current);

  for (let gi = 0; gi < groups.length; gi += 1) {
    const group = groups[gi];
    const params = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: targetLang });
    for (const idx of group) params.append('q', texts[idx]);

    try {
      const res = await fetch(`https://translate.googleapis.com/translate_a/t?${params.toString()}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'ar,en;q=0.8'
        }
      });
      if (!res.ok) throw new Error(`translate HTTP ${res.status}`);
      const data = await res.json();

      group.forEach((idx, offset) => {
        let item = Array.isArray(data) ? data[offset] : null;
        if (Array.isArray(item)) item = item[0];
        results[idx] = typeof item === 'string' && item ? item : texts[idx];
      });
    } catch (err) {
      console.error('Translation error:', err.message);
      group.forEach(idx => { results[idx] = texts[idx]; });
    }

    if (gi < groups.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 120));
    }
  }

  return results;
}

async function getCaptions(videoId, langCode, wantAuto, translateTo) {
  const cacheKey = `${videoId}:${langCode || ''}:${wantAuto ? 'auto' : 'manual'}:${translateTo || ''}`;
  const cached = captionCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CAPTION_CACHE_TTL) return cached.data;

  const info = await getRawInfo(videoId);
  const tracks = (info.captionTracks || []).filter(t => t.url);
  if (!tracks.length) {
    return { ok: true, available: false, cues: [], tracks: [] };
  }

  let track = null;
  if (langCode) {
    track = tracks.find(t => t.languageCode === langCode && !!t.isAutoGenerated === !!wantAuto);
    if (!track) track = tracks.find(t => t.languageCode === langCode);
  }
  if (!track) track = tracks.find(t => t.isAutoGenerated) || tracks[0];

  const captionUrl = `${track.url}${track.url.includes('fmt=') ? '' : '&fmt=json3'}`;
  const res = await fetch(captionUrl, {
    headers: {
      'User-Agent': YT_HEADERS['User-Agent'],
      'Accept-Language': 'ar,en;q=0.8'
    }
  });
  if (!res.ok) throw new Error(`تعذر جلب الترجمة (HTTP ${res.status})`);
  const raw = await res.text();

  let cues = [];
  try {
    cues = parseCaptionJson(JSON.parse(raw));
  } catch {
    cues = parseCaptionXml(raw);
  }

  let translatedTo = null;
  if (translateTo && translateTo !== 'off' && cues.length) {
    const translateKey = `${translateTo}:${track.languageCode}:${track.isAutoGenerated ? 'auto' : 'manual'}:${videoId}`;
    const cachedTranslation = translationCache.get(translateKey);
    if (cachedTranslation && Date.now() - cachedTranslation.at < CAPTION_CACHE_TTL) {
      cues = cachedTranslation.cues;
    } else {
      const texts = cues.map(c => c.text);
      const translated = await translateTexts(texts, translateTo);
      cues = cues.map((c, i) => ({ ...c, text: translated[i] || c.text }));
      translationCache.set(translateKey, { cues, at: Date.now() });
    }
    translatedTo = translateTo;
  }

  const data = {
    ok: true,
    available: true,
    language: track.languageCode,
    languageName: track.name,
    auto: !!track.isAutoGenerated,
    translatedTo,
    cues,
    tracks: tracks.map(t => ({
      code: t.languageCode,
      name: t.name,
      auto: !!t.isAutoGenerated,
      isDefault: !!t.isDefault
    }))
  };
  captionCache.set(cacheKey, { data, at: Date.now() });
  return data;
}

// ============================================================
// Comments
// ============================================================
const commentsCache = new Map();
const COMMENTS_CACHE_TTL = 2 * 60 * 1000;

function parseCommentsResponse(response) {
  const mutations = response?.frameworkUpdates?.entityBatchUpdate?.mutations || [];
  const payloads = mutations
    .map(m => m?.payload?.commentEntityPayload)
    .filter(Boolean);

  const threads = findAll(response, 'commentThreadRenderer');
  const repliesByKey = new Map();
  for (const thread of threads) {
    const key = thread?.commentViewModel?.commentViewModel?.commentKey;
    const repliesRenderer = thread?.replies?.commentRepliesRenderer;
    const token = repliesRenderer?.contents
      ?.map(item => item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token)
      .find(Boolean);
    if (key) repliesByKey.set(safeDecodeURIComponent(key), { token, hasReplies: !!token });
  }

  const comments = payloads.map(payload => {
    const props = payload.properties || {};
    const author = payload.author || {};
    const toolbar = payload.toolbar || {};
    const key = safeDecodeURIComponent(payload.key || '');
    const repliesInfo = repliesByKey.get(key) || {};

    return {
      id: props.commentId || '',
      author: author.displayName || '',
      avatar: author.avatarThumbnailUrl || '',
      isVerified: !!author.isVerified,
      isCreator: !!author.isCreator,
      text: props.content?.content || '',
      publishedTime: props.publishedTime || '',
      likesText: toolbar.likeCountNotliked || '',
      replyCountText: toolbar.replyCount || '',
      replyLevel: Number(props.replyLevel) || 0,
      repliesToken: repliesInfo.token || null,
      channelId: author.channelId || ''
    };
  }).filter(c => c.id && c.text);

  let cursor = null;
  for (const endpoint of response?.onResponseReceivedEndpoints || []) {
    const items = endpoint?.reloadContinuationItemsCommand?.continuationItems
      || endpoint?.appendContinuationItemsAction?.continuationItems
      || [];
    if (!items.length) continue;
    for (const item of items) {
      const token = item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
      if (token) cursor = token;
    }
  }

  const countText = runsText(findFirst(response, 'commentsHeaderRenderer')?.countText?.runs
    ? { runs: findFirst(response, 'commentsHeaderRenderer').countText.runs }
    : null);

  return { comments, cursor, hasMore: !!cursor, countText };
}

async function getComments(videoId, sort, cursor) {
  const cacheKey = `${videoId}:${sort || 'top'}:${cursor || 'first'}`;
  const cached = commentsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < COMMENTS_CACHE_TTL) return cached.data;

  let response;
  if (cursor) {
    response = await ytNext({ continuation: cursor });
  } else {
    const entry = await getPlayerData(videoId);
    const sortTokens = entry.data.comments?.sortTokens || [];
    if (!sortTokens.length) {
      return { ok: true, available: false, comments: [], cursor: null, hasMore: false };
    }
    const token = sort === 'new'
      ? (sortTokens[1]?.token || sortTokens[0].token)
      : sortTokens[0].token;
    response = await ytNext({ continuation: token });
  }

  const parsed = parseCommentsResponse(response);
  const data = { ok: true, available: true, ...parsed };
  commentsCache.set(cacheKey, { data, at: Date.now() });
  return data;
}

// ============================================================
// Optional real Google OAuth
// ============================================================
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const OAUTH_ENABLED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_COOKIE = 'ay_session';
const OAUTH_STATE_COOKIE = 'ay_oauth_state';

function signValue(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function createSessionToken(user) {
  const payload = Buffer.from(JSON.stringify({
    ...user,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000
  })).toString('base64url');
  return `${payload}.${signValue(payload)}`;
}

function readSession(req) {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = signValue(payload);
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function authBaseUrl(req) {
  return process.env.PUBLIC_BASE_URL
    || `http://${req.headers.host || `localhost:${PORT}`}`;
}

function readJsonBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sessionCookieHeader(user) {
  const token = createSessionToken({
    uid: user.id,
    id: user.id,
    name: user.name,
    email: user.email,
    picture: user.picture || '',
    provider: user.provider || 'local'
  });
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`;
}

function userFromRequest(req) {
  const session = readSession(req);
  if (!session) return null;

  let user = session.uid ? findUserById(session.uid) : null;
  if (!user && session.email) user = findUserByEmail(session.email);
  if (!user && session.email) {
    // Legacy local/Google session created before the accounts database existed.
    user = createUser({
      name: session.name || String(session.email).split('@')[0],
      email: session.email,
      password: '',
      picture: session.picture || '',
      provider: session.provider || 'google'
    });
  }
  return user || null;
}

function sessionUserRequest(req) {
  const user = userFromRequest(req);
  if (!user) return null;
  return publicUser(user);
}

function identityKey(user) {
  return user ? user.id : null;
}

function commentOwns(user, comment) {
  if (!user || !comment) return false;
  return comment.userId === user.id;
}

function formatRelativeTime(iso) {
  const timestamp = new Date(iso || 0).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const diff = Math.max(0, Date.now() - timestamp);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const year = 365 * day;

  if (diff < minute) return 'الآن';
  if (diff < hour) {
    const value = Math.floor(diff / minute);
    return `قبل ${value} ${value === 1 ? 'دقيقة' : 'دقائق'}`;
  }
  if (diff < day) {
    const value = Math.floor(diff / hour);
    return `قبل ${value} ${value === 1 ? 'ساعة' : 'ساعات'}`;
  }
  if (diff < 30 * day) {
    const value = Math.floor(diff / day);
    return `قبل ${value} ${value === 1 ? 'يوم' : 'أيام'}`;
  }
  if (diff < year) {
    const value = Math.floor(diff / (30 * day));
    return `قبل ${value} ${value === 1 ? 'شهر' : 'أشهر'}`;
  }
  const value = Math.floor(diff / year);
  return `قبل ${value} ${value === 1 ? 'سنة' : 'سنوات'}`;
}

function commentView(comment, viewer, replyCount = 0) {
  const author = findUserById(comment.userId);
  const reactions = comment.reactions || {};
  const values = Object.values(reactions);
  const likes = values.filter((value) => value === 'like').length;
  const dislikes = values.filter((value) => value === 'dislike').length;
  return {
    id: comment.id,
    serverId: comment.id,
    parentId: comment.parentId || null,
    author: author?.name || comment.authorName || 'مستخدم',
    avatar: author?.picture || '',
    channelId: '',
    text: comment.text || '',
    publishedTime: formatRelativeTime(comment.createdAt),
    createdAt: comment.createdAt,
    editedAt: comment.editedAt || '',
    likesText: likes ? String(likes) : '0',
    likes,
    dislikes,
    viewerReaction: viewer ? (reactions[viewer.id] || null) : null,
    replyCount,
    isMine: !!viewer && comment.userId === viewer.id,
    isLocal: true,
    isVerified: false,
    isCreator: false,
    repliesToken: null
  };
}

function groupCommunityComments(comments, viewer) {
  const topLevel = [];
  const repliesByParent = new Map();

  for (const comment of comments) {
    if (comment.parentId) {
      if (!repliesByParent.has(comment.parentId)) repliesByParent.set(comment.parentId, []);
      repliesByParent.get(comment.parentId).push(comment);
    } else {
      topLevel.push(comment);
    }
  }

  return topLevel.map((comment) => {
    const replies = (repliesByParent.get(comment.id) || [])
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .map((reply) => commentView(reply, viewer));
    return { ...commentView(comment, viewer, replies.length), replies };
  });
}

const channelFeedCache = new Map();
const CHANNEL_FEED_TTL = 10 * 60 * 1000;
const CHANNEL_VIDEOS_TAB_PARAMS = 'EgZ2aWRlb3PyBgQKAjoA';

function richTextValue(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.content === 'string') return value.content;
  if (typeof value.simpleText === 'string') return value.simpleText;
  if (Array.isArray(value.runs)) return value.runs.map((run) => run.text || '').join('');
  return '';
}

function parseBrowseChannelVideos(data, channel = {}) {
  const videos = [];
  const seen = new Set();
  const channelName = channel.channelName || channel.name || '';

  const add = (video) => {
    if (!video?.id || seen.has(video.id)) return;
    seen.add(video.id);
    videos.push({
      channel: channelName,
      channelId: channel.channelId || '',
      channelAvatar: channel.channelAvatar || '',
      duration: '',
      views: '',
      publishedTime: '',
      url: `https://www.youtube.com/watch?v=${video.id}`,
      ...video
    });
  };

  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    const lockup = node.lockupViewModel;
    if (lockup?.contentId
      && lockup.contentType !== 'LOCKUP_CONTENT_TYPE_PLAYLIST'
      && lockup.contentType !== 'LOCKUP_CONTENT_TYPE_CHANNEL') {
      const meta = lockup.metadata?.lockupMetadataViewModel || {};
      const rows = meta.metadata?.contentMetadataViewModel?.metadataRows || [];
      const parts = rows
        .flatMap((row) => (row.metadataParts || []).map((part) => richTextValue(part.text)))
        .filter(Boolean);
      const badges = lockup.contentImage?.thumbnailViewModel?.overlays?.[0]
        ?.thumbnailBottomOverlayViewModel?.badges || [];
      const duration = badges
        .map((badge) => badge.thumbnailBadgeViewModel?.text || '')
        .find((text) => /^\d+(?::\d+){1,2}$/.test(text)) || '';
      const sources = lockup.contentImage?.thumbnailViewModel?.image?.sources
        || lockup.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources
        || [];
      const thumbnail = sources.length ? sources[sources.length - 1].url : '';
      add({
        id: lockup.contentId,
        title: richTextValue(meta.title),
        duration,
        views: parts.find((text) => /مشاهدة|views?/i.test(text)) || '',
        publishedTime: parts.find((text) => /قبل|ago|منذ/i.test(text)) || '',
        thumbnail: thumbnail || `https://i.ytimg.com/vi/${lockup.contentId}/mqdefault.jpg`
      });
    }

    const legacy = node.videoRenderer || node.gridVideoRenderer || node.compactVideoRenderer;
    if (legacy?.videoId) {
      const thumbnails = legacy.thumbnail?.thumbnails || [];
      add({
        id: legacy.videoId,
        title: richTextValue(legacy.title) || richTextValue(legacy.headline),
        duration: richTextValue(legacy.lengthText),
        views: richTextValue(legacy.viewCountText),
        publishedTime: richTextValue(legacy.publishedTimeText),
        thumbnail: thumbnails.length ? thumbnails[thumbnails.length - 1].url : `https://i.ytimg.com/vi/${legacy.videoId}/hqdefault.jpg`
      });
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === 'lockupViewModel' || key === 'videoRenderer' || key === 'gridVideoRenderer' || key === 'compactVideoRenderer') continue;
      if (value && typeof value === 'object') visit(value);
    }
  };

  visit(data);
  return videos;
}

const CHANNEL_TAB_PARAMS = {
  home: 'EghmZWF0dXJlZPIGBAoCMgA%3D',
  videos: 'EgZ2aWRlb3PyBgQKAjoA',
  shorts: 'EgZzaG9ydHPyBgUKA5oBAA%3D%3D',
  live: 'EgdzdHJlYW1z8gYECgJ6AA%3D%3D',
  podcasts: 'Eghwb2RjYXN0c_IGBQoDugEA',
  playlists: 'EglwbGF5bGlzdHPyBgoKCEIGCgIQaCIA',
  community: 'EgVwb3N0c_IGBAoCSgA%3D'
};

const DEFAULT_CHANNEL_TABS = [
  { id: 'home', title: 'الصفحة الرئيسية', params: CHANNEL_TAB_PARAMS.home },
  { id: 'videos', title: 'الفيديوهات', params: CHANNEL_TAB_PARAMS.videos },
  { id: 'shorts', title: 'Shorts', params: CHANNEL_TAB_PARAMS.shorts },
  { id: 'live', title: 'البث المباشر', params: CHANNEL_TAB_PARAMS.live },
  { id: 'podcasts', title: 'برامج البودكاست', params: CHANNEL_TAB_PARAMS.podcasts },
  { id: 'playlists', title: 'قوائم التشغيل', params: CHANNEL_TAB_PARAMS.playlists },
  { id: 'community', title: 'المنشورات', params: CHANNEL_TAB_PARAMS.community }
];

function parseBrowseHomeTab(data, channel = {}) {
  let featuredVideo = null;
  const shelves = [];
  const seenVideoIds = new Set();
  const channelName = channel.name || channel.channelName || '';
  const channelAvatar = channel.avatar || channel.channelAvatar || '';

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;

    if (node.channelVideoPlayerRenderer && !featuredVideo) {
      const v = node.channelVideoPlayerRenderer;
      if (v.videoId) {
        featuredVideo = {
          id: v.videoId,
          title: runsText(v.title),
          description: runsText(v.description),
          views: runsText(v.viewCountText),
          publishedTime: runsText(v.publishedTimeText),
          thumbnail: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
          channel: channelName,
          channelAvatar: channelAvatar,
          channelId: channel.id || channel.channelId || ''
        };
        seenVideoIds.add(v.videoId);
      }
      return;
    }

    if (node.shelfRenderer) {
      const s = node.shelfRenderer;
      const title = runsText(s.title);
      const shelfVideos = parseBrowseChannelVideos(s.content, channel);
      if (shelfVideos.length) {
        shelves.push({
          title,
          type: 'videos',
          videos: shelfVideos
        });
      }
      return;
    }

    if (node.reelShelfRenderer) {
      const r = node.reelShelfRenderer;
      const title = runsText(r.title) || 'Shorts';
      const items = parseBrowseShorts(r, channel);
      if (items.length) {
        shelves.push({
          title,
          type: 'shorts',
          shorts: items
        });
      }
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const v of Object.values(node)) {
      walk(v);
    }
  };

  walk(data);
  return { featuredVideo, shelves };
}

function parseBrowseShorts(data, channel = {}) {
  const shorts = [];
  const seen = new Set();
  const channelName = channel.name || channel.channelName || '';
  const channelAvatar = channel.avatar || channel.channelAvatar || '';

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;

    if (node.shortsLockupViewModel) {
      const s = node.shortsLockupViewModel;
      const id = s.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId
        || (s.entityId ? s.entityId.replace(/^shorts-shelf-item-/, '') : '');
      if (id && !seen.has(id)) {
        seen.add(id);
        const title = s.overlayMetadata?.primaryText?.content || runsText(s.accessibilityText) || '';
        const views = s.overlayMetadata?.secondaryText?.content || '';
        const thumb = s.thumbnailViewModel?.thumbnailViewModel?.image?.sources?.[0]?.url
          || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
        shorts.push({
          id,
          title,
          views,
          thumbnail: thumb,
          isShort: true,
          channel: channelName,
          channelAvatar: channelAvatar,
          channelId: channel.id || channel.channelId || ''
        });
      }
      return;
    }

    if (node.reelItemRenderer) {
      const r = node.reelItemRenderer;
      const id = r.videoId;
      if (id && !seen.has(id)) {
        seen.add(id);
        const title = runsText(r.headline) || runsText(r.accessibilityText) || '';
        const views = runsText(r.viewCountText) || '';
        const thumbs = r.thumbnail?.thumbnails || [];
        const thumb = thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
        shorts.push({
          id,
          title,
          views,
          thumbnail: thumb,
          isShort: true,
          channel: channelName,
          channelAvatar: channelAvatar,
          channelId: channel.id || channel.channelId || ''
        });
      }
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const v of Object.values(node)) {
      walk(v);
    }
  };

  walk(data);
  return shorts;
}

function parseBrowsePlaylists(data, channel = {}) {
  const playlists = [];
  const seen = new Set();
  const channelName = channel.name || channel.channelName || '';
  const channelAvatar = channel.avatar || channel.channelAvatar || '';

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;

    if (node.lockupViewModel && node.lockupViewModel.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST') {
      const pl = node.lockupViewModel;
      const id = pl.contentId;
      if (id && !seen.has(id)) {
        seen.add(id);
        const title = pl.metadata?.lockupMetadataViewModel?.title?.content || '';
        const thumb = pl.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources?.[0]?.url
          || pl.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources?.[1]?.url || '';
        const badge = pl.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.overlays?.[0]?.thumbnailOverlayBadgeViewModel?.thumbnailBadges?.[0]?.thumbnailBadgeViewModel?.text || '';
        const firstVid = pl.itemPlayback?.inlinePlayerData?.onSelect?.innertubeCommand?.watchEndpoint?.videoId || '';
        playlists.push({
          id,
          title,
          thumbnail: thumb,
          videoCountText: badge,
          firstVideoId: firstVid,
          channel: channelName,
          channelAvatar: channelAvatar,
          channelId: channel.id || channel.channelId || ''
        });
      }
      return;
    }

    if (node.gridPlaylistRenderer) {
      const g = node.gridPlaylistRenderer;
      const id = g.playlistId;
      if (id && !seen.has(id)) {
        seen.add(id);
        const title = runsText(g.title);
        const thumbs = g.thumbnail?.thumbnails || [];
        const thumb = thumbs.length ? thumbs[thumbs.length - 1].url : '';
        const badge = runsText(g.videoCountShortText) || runsText(g.videoCountText) || '';
        const firstVid = g.navigationEndpoint?.watchEndpoint?.videoId || '';
        playlists.push({
          id,
          title,
          thumbnail: thumb,
          videoCountText: badge,
          firstVideoId: firstVid,
          channel: channelName,
          channelAvatar: channelAvatar,
          channelId: channel.id || channel.channelId || ''
        });
      }
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const v of Object.values(node)) {
      walk(v);
    }
  };

  walk(data);
  return playlists;
}

function parseBrowsePodcasts(data, channel = {}) {
  const podcasts = [];
  const seen = new Set();
  const channelName = channel.name || channel.channelName || '';
  const channelAvatar = channel.avatar || channel.channelAvatar || '';

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;

    if (node.lockupViewModel && (
      node.lockupViewModel.contentType === 'LOCKUP_CONTENT_TYPE_PODCAST'
      || node.lockupViewModel.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST'
    )) {
      const pl = node.lockupViewModel;
      const id = pl.contentId;
      if (id && !seen.has(id)) {
        seen.add(id);
        const title = pl.metadata?.lockupMetadataViewModel?.title?.content || '';
        const primary = pl.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel
          || pl.contentImage?.thumbnailViewModel;
        const sources = primary?.image?.sources || [];
        const thumb = sources.length ? sources[sources.length - 1].url : '';
        const badge = primary?.overlays?.[0]?.thumbnailOverlayBadgeViewModel?.thumbnailBadges?.[0]?.thumbnailBadgeViewModel?.text
          || primary?.overlays?.[0]?.thumbnailBottomOverlayViewModel?.badges?.[0]?.thumbnailBadgeViewModel?.text
          || '';
        const firstVid = pl.itemPlayback?.inlinePlayerData?.onSelect?.innertubeCommand?.watchEndpoint?.videoId || '';

        podcasts.push({
          id,
          title,
          thumbnail: thumb,
          episodeCountText: badge,
          firstVideoId: firstVid,
          channel: channelName,
          channelAvatar: channelAvatar,
          channelId: channel.id || channel.channelId || ''
        });
      }
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const v of Object.values(node)) {
      walk(v);
    }
  };

  walk(data);
  return podcasts;
}

function parseBrowseCommunity(data, channel = {}) {
  const posts = [];
  const seen = new Set();
  const channelName = channel.name || channel.channelName || '';
  const channelAvatar = channel.avatar || channel.channelAvatar || '';

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;

    const post = node.backstagePostThreadRenderer?.post?.backstagePostRenderer || node.backstagePostRenderer;
    if (post && post.postId && !seen.has(post.postId)) {
      seen.add(post.postId);
      const author = runsText(post.authorText) || channelName;
      let avatar = post.authorThumbnail?.thumbnails?.[0]?.url || channelAvatar;
      if (avatar && avatar.startsWith('//')) avatar = 'https:' + avatar;
      const publishedTime = runsText(post.publishedTimeText);
      const content = runsText(post.contentText);
      const image = post.backstageAttachment?.backstageImageRenderer?.image?.thumbnails?.[0]?.url
        || post.backstageAttachment?.postMultiImageRenderer?.images?.[0]?.backstageImageRenderer?.image?.thumbnails?.[0]?.url
        || '';
      const likes = runsText(post.voteCount);

      posts.push({
        id: post.postId,
        author,
        avatar,
        publishedTime,
        content,
        image,
        likes
      });
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const v of Object.values(node)) {
      walk(v);
    }
  };

  walk(data);
  return posts;
}

async function fetchChannelFeed(channelId, channel = {}) {
  if (!channelId) return [];
  const cached = channelFeedCache.get(channelId);
  if (cached && Date.now() - cached.at < CHANNEL_FEED_TTL) return cached.videos;

  let channelName = channel.channelName || channel.name || '';
  try {
    const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, {
      headers: {
        'User-Agent': YT_HEADERS['User-Agent'],
        'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8'
      }
    });
    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
    const xml = await res.text();
    const nameMatch = xml.match(/<title>([\s\S]*?)<\/title>/);
    channelName = channelName || (nameMatch ? decodeEntities(nameMatch[1].trim()) : '');
    const videos = parseYouTubeFeed(xml, { ...channel, channelId, channelName });
    if (videos.length) {
      channelFeedCache.set(channelId, { videos, at: Date.now() });
      return videos;
    }
  } catch (error) {
    console.error('Channel RSS error:', channelId, error.message);
  }

  try {
    const data = await ytBrowse({ browseId: channelId, params: CHANNEL_VIDEOS_TAB_PARAMS });
    channelName = channelName
      || data?.metadata?.channelMetadataRenderer?.title
      || data?.microformat?.microformatDataRenderer?.title
      || '';
    const avatarSources = data?.metadata?.channelMetadataRenderer?.avatar?.thumbnails || [];
    const channelAvatar = channel.channelAvatar
      || (avatarSources.length ? avatarSources[avatarSources.length - 1].url : '');
    const videos = parseBrowseChannelVideos(data, { ...channel, channelId, channelName, channelAvatar });
    channelFeedCache.set(channelId, { videos, at: Date.now() });
    return videos;
  } catch (error) {
    console.error('Channel browse error:', channelId, error.message);
    return [];
  }
}

async function resolveChannelId(channelName) {
  if (!channelName) return '';
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(channelName)}&sp=EgIQAg%253D%253D`;
    const res = await fetch(url, { headers: { 'User-Agent': YT_HEADERS['User-Agent'], 'Accept-Language': 'ar,en;q=0.8' } });
    if (!res.ok) return '';
    const html = await res.text();
    const match = html.match(/"channelId":"(UC[a-zA-Z0-9_-]{20,})"/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

const channelProfileCache = new Map();
const CHANNEL_PROFILE_TTL = 30 * 60 * 1000;

async function getChannelProfile(channelId, channelName) {
  const cacheKey = channelId || channelName;
  if (cacheKey && channelProfileCache.has(cacheKey)) {
    const cached = channelProfileCache.get(cacheKey);
    if (Date.now() - cached.at < CHANNEL_PROFILE_TTL) {
      return cached.data;
    }
  }

  let avatar = '';
  let banner = '';
  let name = channelName || '';
  let subscribers = '';
  let videoCount = '';
  let resolvedId = channelId || '';
  let tabs = [];

  // 1. Try ytBrowse if we have channelId
  if (resolvedId) {
    try {
      const browseData = await ytBrowse({ browseId: resolvedId });
      const header = browseData?.header?.pageHeaderRenderer?.content?.pageHeaderViewModel || browseData?.header?.c4TabbedHeaderRenderer;
      
      const avatarSources = header?.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources
        || header?.avatar?.thumbnails
        || browseData?.metadata?.channelMetadataRenderer?.avatar?.thumbnails
        || [];
      if (avatarSources.length) {
        avatar = avatarSources[avatarSources.length - 1].url;
      }

      const bannerSources = header?.banner?.imageBannerViewModel?.image?.sources
        || header?.banner?.thumbnails
        || [];
      if (bannerSources.length) {
        banner = bannerSources[bannerSources.length - 1].url;
      }

      const titleVal = header?.title?.dynamicTextViewModel?.text?.content
        || header?.title
        || browseData?.metadata?.channelMetadataRenderer?.title;
      if (titleVal) name = titleVal;

      const metaRows = header?.metadata?.contentMetadataViewModel?.metadataRows || [];
      const parts = metaRows.flatMap(r => (r.metadataParts || []).map(p => p.text?.content)).filter(Boolean);
      subscribers = parts.find(t => /مشترك|subscriber/i.test(t)) || '';
      videoCount = parts.find(t => /فيديو|video/i.test(t)) || '';

      const rawTabs = browseData?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
      for (const t of rawTabs) {
        const tr = t.tabRenderer;
        if (!tr) continue;
        const title = runsText(tr.title);
        const tabParams = tr.endpoint?.browseEndpoint?.params || '';
        let id = 'other';
        if (/الرئيسية|home|featured/i.test(title)) id = 'home';
        else if (/فيديو|video/i.test(title)) id = 'videos';
        else if (/shorts/i.test(title)) id = 'shorts';
        else if (/مباشر|live|stream/i.test(title)) id = 'live';
        else if (/بودكاست|podcast/i.test(title)) id = 'podcasts';
        else if (/تشغيل|playlist/i.test(title)) id = 'playlists';
        else if (/منشور|community|post/i.test(title)) id = 'community';
        if (id !== 'other') {
          tabs.push({ id, title, params: tabParams });
        }
      }
    } catch (e) {
      // ignore
    }
  }

  // 2. If avatar is still missing or we need to search
  if (!avatar && (channelName || name)) {
    try {
      const results = await searchVideos(channelName || name);
      if (results.length) {
        const match = results.find(v => v.channelAvatar) || results[0];
        if (match?.channelAvatar) avatar = match.channelAvatar;
        if (!resolvedId && match?.channelId) resolvedId = match.channelId;
        if (!name && match?.channel) name = match.channel;
      }
    } catch {}
  }

  if (!tabs.length) tabs = DEFAULT_CHANNEL_TABS;

  const data = { channelId: resolvedId, name, avatar, banner, subscribers, videoCount, tabs };
  if (cacheKey) channelProfileCache.set(cacheKey, { data, at: Date.now() });
  return data;
}

function parseYouTubeFeed(xml, channel = {}) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml))) {
    const block = match[1];
    const pick = (tag) => {
      const found = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return found ? decodeEntities(found[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim()) : '';
    };
    const videoId = pick('yt:videoId');
    if (!videoId) continue;
    const thumbMatch = block.match(/<media:thumbnail[^>]+url="([^"]+)"/);
    const viewsMatch = block.match(/<media:statistics[^>]+views="(\d+)"/);
    entries.push({
      id: videoId,
      title: pick('title'),
      channel: channel.channelName || pick('name') || '',
      channelId: channel.channelId || '',
      channelAvatar: channel.channelAvatar || '',
      duration: '',
      views: viewsMatch ? Number(viewsMatch[1]) : 0,
      publishedTime: formatRelativeTime(pick('published')),
      publishedAt: pick('published'),
      thumbnail: thumbMatch ? decodeEntities(thumbMatch[1]) : `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      url: `https://www.youtube.com/watch?v=${videoId}`
    });
  }
  return entries;
}

// ============================================================
// Download & Mux helpers (guarantees video + audio sound!)
// ============================================================
function pickDownloadFormat(info, type) {
  const formats = (info.formats || []).filter(f => f.url);
  if (type === 'audio') {
    return formats
      .filter(f => f.hasAudio && !f.hasVideo)
      .sort((a, b) => {
        const aMp4 = /mp4a/i.test(a.mimeType) ? 100 : 0;
        const bMp4 = /mp4a/i.test(b.mimeType) ? 100 : 0;
        return (bMp4 + (b.bitrate || 0) / 1000) - (aMp4 + (a.bitrate || 0) / 1000);
      })[0] || formats.filter(f => f.hasAudio)[0];
  }
  const muxed = formats.filter(f => f.hasVideo && f.hasAudio).sort((a, b) => (parseStandardQualityHeight(b) || 0) - (parseStandardQualityHeight(a) || 0));
  if (muxed.length > 0) return muxed[0];

  // Adaptive H.264 MP4 up to 1080p for muxing with M4A audio
  const mp4Avc = formats
    .filter(f => f.hasVideo && /avc1/i.test(f.mimeType) && /video\/mp4/i.test(f.mimeType))
    .sort((a, b) => {
      const ha = parseStandardQualityHeight(a);
      const hb = parseStandardQualityHeight(b);
      const prefA = ha === 720 ? 2 : (ha <= 1080 ? 1 : 0);
      const prefB = hb === 720 ? 2 : (hb <= 1080 ? 1 : 0);
      if (prefB !== prefA) return prefB - prefA;
      return hb - ha;
    });
  if (mp4Avc.length) return mp4Avc[0];

  return formats.filter(f => f.hasVideo).sort((a, b) => (parseStandardQualityHeight(b) || 0) - (parseStandardQualityHeight(a) || 0))[0];
}

async function fetchToTempFile(url, filePath) {
  const upstream = await fetch(url, { headers: { 'User-Agent': YT_HEADERS['User-Agent'] } });
  if (!upstream.ok || !upstream.body) {
    throw new Error(`HTTP ${upstream.status} fetching media`);
  }
  const writer = fs.createWriteStream(filePath);
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!writer.write(Buffer.from(value))) {
        await new Promise(resolve => writer.once('drain', resolve));
      }
    }
    await new Promise((resolve, reject) => {
      writer.end(resolve);
      writer.on('error', reject);
    });
  } catch (err) {
    writer.destroy();
    throw err;
  }
}

function runFfmpegMux(videoPath, audioPath, outputPath, canCopyAudio = true) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg binary missing'));
    const args = [
      '-y',
      '-i', videoPath,
      '-i', audioPath,
      '-c:v', 'copy',
      '-c:a', canCopyAudio ? 'copy' : 'aac',
      '-shortest',
      '-movflags', '+faststart',
      outputPath
    ];
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errLog = '';
    proc.stderr?.on('data', chunk => { errLog += chunk.toString().slice(-400); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) resolve(outputPath);
      else reject(new Error(`ffmpeg exited with code ${code}: ${errLog}`));
    });
  });
}

function sanitizeFilename(name) {
  return String(name || 'video').replace(/[/\\?%*:|"<>]/g, '_').trim().substring(0, 80) || 'video';
}

// ============================================================
// Smart Personalized Home Recommendation Engine (Learns over time)
// ============================================================
const STOP_WORDS_AR = new Set([
  'في', 'من', 'على', 'إلى', 'عن', 'مع', 'هذا', 'هذه', 'ذلك', 'التي', 'الذي',
  'الذين', 'كان', 'يكون', 'بعد', 'قبل', 'أو', 'ثم', 'بين', 'حتى', 'كل', 'فيديو',
  'جديد', 'حصري', 'مباشر', 'كامل', 'حلقة', 'shorts', 'the', 'and', 'for', 'with',
  'hd', '4k', 'official', 'video', 'clip'
]);

function extractTopicPhrases(title = '') {
  const cleaned = String(title || '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleaned.split(' ').filter(w => w.length >= 3 && !STOP_WORDS_AR.has(w.toLowerCase()));
  const phrases = [];
  if (words.length >= 2) phrases.push(`${words[0]} ${words[1]}`);
  if (words.length >= 4) phrases.push(`${words[2]} ${words[3]}`);
  if (!phrases.length && words.length) phrases.push(words[0]);
  return phrases;
}

function recordWatchInterest(store, userKey, video) {
  if (!store.watchStats) store.watchStats = {};
  if (!store.watchStats[userKey]) {
    store.watchStats[userKey] = { channels: {}, topics: {} };
  }
  const stats = store.watchStats[userKey];
  if (!stats.channels) stats.channels = {};
  if (!stats.topics) stats.topics = {};
  const now = Date.now();

  const chName = String(video.channel || '').trim();
  if (chName && chName !== 'قناة يوتيوب') {
    const cur = stats.channels[chName] || { count: 0, lastAt: now };
    stats.channels[chName] = { count: cur.count + 1, lastAt: now };
  }

  const phrases = extractTopicPhrases(video.title);
  for (const ph of phrases) {
    const key = ph.trim();
    if (!key) continue;
    const cur = stats.topics[key] || { count: 0, lastAt: now };
    stats.topics[key] = { count: cur.count + 1, lastAt: now };
  }
}

function getTopInterestQueries(store, userKey) {
  const stats = store.watchStats?.[userKey] || store.watchStats?.global;
  const queries = [];

  if (stats) {
    const channels = Object.entries(stats.channels || {})
      .sort((a, b) => (b[1].count * 10 + (b[1].lastAt / 1e12)) - (a[1].count * 10 + (a[1].lastAt / 1e12)));
    const topics = Object.entries(stats.topics || {})
      .sort((a, b) => (b[1].count * 8 + (b[1].lastAt / 1e12)) - (a[1].count * 8 + (a[1].lastAt / 1e12)));

    if (channels[0]) queries.push(channels[0][0]);
    if (topics[0]) queries.push(topics[0][0]);
    if (channels[1]) queries.push(channels[1][0]);
    if (topics[1]) queries.push(topics[1][0]);
  }

  // Fallback to scanning watch history if stats aren't built yet
  if (!queries.length) {
    const hist = store.history?.[userKey] || store.history?.global || [];
    const chFreq = new Map();
    for (const item of hist) {
      if (item?.channel) chFreq.set(item.channel, (chFreq.get(item.channel) || 0) + 1);
    }
    const topCh = [...chFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0]);
    queries.push(...topCh);
  }

  return [...new Set(queries.filter(Boolean))];
}

// ============================================================
// HTTP server request handler
// ============================================================
const searchCache = new Map();
const HOME_WARM_FILE = path.join(__dirname, 'data', 'home_cache.json');
const homeRefreshing = new Set();

function loadDiskWarmHome() {
  try {
    if (!fs.existsSync(HOME_WARM_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(HOME_WARM_FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const [k, entry] of Object.entries(raw)) {
        if (entry && Array.isArray(entry.data) && entry.data.length) {
          searchCache.set(k.toLowerCase().trim(), { data: entry.data, time: entry.time || Date.now() });
        }
      }
    }
  } catch {}
}

function saveDiskWarmHome() {
  try {
    const out = {};
    for (const [k, entry] of searchCache.entries()) {
      if (k.startsWith('__home_') && Array.isArray(entry.data) && entry.data.length) {
        out[k] = { data: entry.data.slice(0, 60), time: entry.time };
      }
    }
    fs.writeFileSync(HOME_WARM_FILE, JSON.stringify(out), 'utf8');
  } catch {}
}

loadDiskWarmHome();

function getCachedSearch(key, maxAgeMs = 15 * 60 * 1000) {
  const hit = searchCache.get(key.toLowerCase().trim());
  if (hit && Date.now() - hit.time < maxAgeMs) return hit;
  return null;
}

function setCachedSearch(key, data) {
  if (searchCache.size > 200) {
    const first = searchCache.keys().next().value;
    searchCache.delete(first);
  }
  const cleanKey = key.toLowerCase().trim();
  searchCache.set(cleanKey, { data, time: Date.now() });
  if (cleanKey.startsWith('__home_')) saveDiskWarmHome();
}

async function fetchPersonalizedHome(userKey) {
  const store = getStore();
  const homeCacheKey = `__home_${userKey}`;
  const topInterests = getTopInterestQueries(store, userKey);
  const defaultTrends = ['ملخص مباريات اليوم', 'أخبار اليوم عاجل', 'القرآن الكريم بصوت جميل'];
  const queriesToFetch = [...topInterests.slice(0, 3), ...defaultTrends].slice(0, 4);

  const settled = await Promise.allSettled(queriesToFetch.map(term => searchVideos(term)));
  const combined = [];
  const seen = new Set();

  for (const resItem of settled) {
    if (resItem.status !== 'fulfilled' || !Array.isArray(resItem.value)) continue;
    for (const item of resItem.value) {
      if (item && item.id && !seen.has(item.id)) {
        seen.add(item.id);
        combined.push(item);
      }
    }
  }
  if (combined.length) {
    setCachedSearch(homeCacheKey, combined);
    enqueuePrewarm(combined.slice(0, 5).map(v => v.id));
  }
  return combined;
}

function refreshHomeInBackground(userKey) {
  if (homeRefreshing.has(userKey)) return;
  homeRefreshing.add(userKey);
  fetchPersonalizedHome(userKey)
    .catch(() => {})
    .finally(() => homeRefreshing.delete(userKey));
}

const handleRequest = async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;

  const host = req.headers.host || '';
  // If user opens port 3400 in browser, redirect to 5000 so Google OAuth matches Authorized JavaScript Origins
  if (host.includes('3400') && req.method === 'GET' && !pathname.startsWith('/api/')) {
    res.writeHead(302, { 'Location': `http://localhost:5000${req.url}` });
    return res.end();
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  try {
    // ---------- PRO Master Code Verification & Revocation ----------
    if (pathname === '/api/pro/status' && req.method === 'GET') {
      const force = reqUrl.searchParams.get('force') === '1';
      await syncCloudProConfig(force || !cloudProState.codeHash);
      const clientToken = String(reqUrl.searchParams.get('token') || req.headers['x-pro-token'] || '').trim().toLowerCase();
      const synced = Boolean(cloudProState.codeHash);
      const active = Boolean(cloudProState.proEnabled && synced && clientToken && clientToken === cloudProState.codeHash);
      const revoked = Boolean(clientToken && (!cloudProState.proEnabled || (synced && clientToken !== cloudProState.codeHash)));
      return sendJSON(res, 200, {
        success: true,
        active,
        revoked,
        cloudSynced: synced,
        proEnabled: cloudProState.proEnabled,
        epoch: cloudProState.epoch
      });
    }

    if (pathname === '/api/pro/activate' && req.method === 'POST') {
      try {
        await syncCloudProConfig(true);
        if (!cloudProState.codeHash) {
          return sendJSON(res, 503, {
            success: false,
            error: 'تعذر الاتصال بسيرفر التفعيل السحابي، تأكد من اتصال الإنترنت.'
          });
        }
        if (!cloudProState.proEnabled) {
          return sendJSON(res, 403, {
            success: false,
            error: '⏸️ تم إيقاف التفعيل مؤقتاً من لوحة تحكم المطور.'
          });
        }
        const body = await readJsonBody(req);
        const normalized = String(body.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        const candidateHash = sha256EpochHash(normalized);
        if (normalized.length < 6 || candidateHash !== cloudProState.codeHash) {
          return sendJSON(res, 403, {
            success: false,
            error: '❌ كود التفعيل غير صحيح! تأكد من إدخال الكود الرسمي الجديد.'
          });
        }
        return sendJSON(res, 200, { success: true, proToken: cloudProState.codeHash, epoch: cloudProState.epoch });
      } catch (err) {
        return sendJSON(res, 400, { success: false, error: err.message });
      }
    }

    // ---------- Search & Personalized "الكل" Home Feed ----------
    if (pathname === '/api/search' || pathname === '/api/trending') {
      const q = (reqUrl.searchParams.get('q') || '').trim();
      
      // If "الكل" (All) or empty or trending, prioritize user's most-watched channels/topics over time!
      if (!q || q === 'الكل' || pathname === '/api/trending') {
        const viewer = userFromRequest(req);
        const userKey = viewer ? viewer.id : 'global';
        const homeCacheKey = `__home_${userKey}`;

        // Stale-while-revalidate: serve immediately (up to 6h cache), refresh in background after 4m
        const hit = getCachedSearch(homeCacheKey, 6 * 60 * 60 * 1000);
        if (hit && Array.isArray(hit.data) && hit.data.length) {
          if (Date.now() - hit.time > 4 * 60 * 1000) {
            refreshHomeInBackground(userKey);
          }
          enqueuePrewarm(hit.data.slice(0, 4).map(v => v.id));
          return sendJSON(res, 200, { success: true, count: hit.data.length, results: hit.data });
        }

        const combined = await fetchPersonalizedHome(userKey);
        return sendJSON(res, 200, { success: true, count: combined.length, results: combined });
      }

      const hit = getCachedSearch(q, 15 * 60 * 1000);
      if (hit) {
        return sendJSON(res, 200, { success: true, count: hit.data.length, results: hit.data });
      }
      const results = await searchVideos(q);
      setCachedSearch(q, results);
      if (/shorts/i.test(q) && Array.isArray(results)) {
        enqueuePrewarm(results.slice(0, 4).map(v => v.id));
      }
      return sendJSON(res, 200, { success: true, count: results.length, results });
    }

    // ---------- Cloud Synced Watch History + Interest Learning ----------
    if (pathname === '/api/history') {
      const store = getStore();
      const viewer = userFromRequest(req);
      const userKey = viewer ? viewer.id : 'global';

      if (req.method === 'GET') {
        const list = store.history[userKey] || store.history.global || [];
        return sendJSON(res, 200, { success: true, history: Array.isArray(list) ? list : [] });
      }

      if (req.method === 'POST') {
        try {
          const body = await readJsonBody(req);
          const video = body.video;
          if (!video || !video.id) return sendJSON(res, 400, { success: false });

          const list = Array.isArray(store.history[userKey]) ? store.history[userKey] : [];
          const filtered = list.filter((item) => item.id !== video.id);
          filtered.unshift(video);
          if (filtered.length > 200) filtered.pop();
          store.history[userKey] = filtered;

          // Accumulate long-term watch interest for "الكل" Home feed
          recordWatchInterest(store, userKey, video);
          if (userKey !== 'global') {
            recordWatchInterest(store, 'global', video);
          }
          // Invalidate personalized home cache & refresh quietly so Home is instant AND updated
          searchCache.delete(`__home_${userKey}`.toLowerCase());
          searchCache.delete('__home_global');
          saveDiskWarmHome();
          refreshHomeInBackground(userKey);

          saveStore();
          return sendJSON(res, 200, { success: true, count: filtered.length });
        } catch (error) {
          return sendJSON(res, 500, { success: false, error: error.message });
        }
      }

      if (req.method === 'DELETE') {
        store.history[userKey] = [];
        if (store.watchStats && store.watchStats[userKey]) {
          delete store.watchStats[userKey];
        }
        searchCache.delete(`__home_${userKey}`.toLowerCase());
        saveDiskWarmHome();
        refreshHomeInBackground(userKey);
        saveStore();
        return sendJSON(res, 200, { success: true, history: [] });
      }
    }

    // ---------- Autocomplete ----------
    if (pathname === '/api/suggest') {
      const q = reqUrl.searchParams.get('q') || '';
      if (!q.trim()) return sendJSON(res, 200, { success: true, suggestions: [] });
      const suggestions = await getSuggestions(q);
      return sendJSON(res, 200, { success: true, suggestions });
    }

    // ---------- Video info (lightweight) ----------
    if (pathname === '/api/info') {
      const videoId = extractVideoId(reqUrl.searchParams.get('v') || '');
      if (!videoId) return sendJSON(res, 400, { success: false, error: 'Invalid video ID' });
      return sendJSON(res, 200, {
        success: true,
        videoId,
        thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
        embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&enablejsapi=1`
      });
    }

    // ---------- Full player payload ----------
    if (pathname === '/api/player') {
      const videoId = extractVideoId(reqUrl.searchParams.get('v') || '');
      if (!videoId) return sendJSON(res, 400, { success: false, error: 'معرف الفيديو غير صالح' });
      if (reqUrl.searchParams.get('refresh') === '1') playerCache.delete(videoId);
      const entry = await getPlayerData(videoId);
      if (entry?.data?.related?.length) {
        enqueuePrewarm(entry.data.related.slice(0, 2).map(r => r.id));
      }
      return sendJSON(res, 200, { success: true, ...entry.data });
    }

    // ---------- Reliable Range-Supported Stream Proxy Fallback ----------
    if (pathname === '/api/stream') {
      const videoId = extractVideoId(reqUrl.searchParams.get('v') || '');
      const itag = reqUrl.searchParams.get('itag') || '';
      const streamType = reqUrl.searchParams.get('type') || 'video';
      if (!videoId) {
        res.writeHead(400);
        return res.end('Invalid id');
      }
      const entry = await getPlayerData(videoId);
      let targetUrl = '';
      let targetMime = streamType === 'audio' ? 'audio/mp4' : 'video/mp4';

      if (streamType === 'audio') {
        targetUrl = entry.data.audio?.url || '';
        targetMime = entry.data.audio?.mime || 'audio/mp4';
      } else {
        const matchQ = itag
          ? entry.data.qualities.find(q => String(q.itag) === String(itag))
          : null;
        const pickedQ = matchQ
          || entry.data.qualities.find(q => String(q.itag) === String(entry.data.defaultQualityItag))
          || entry.data.qualities[0];
        if (pickedQ) {
          targetUrl = pickedQ.url;
          targetMime = pickedQ.mime || 'video/mp4';
        }
      }

      if (!targetUrl) {
        res.writeHead(404);
        return res.end('Stream unavailable');
      }

      const fwdHeaders = { 'User-Agent': YT_HEADERS['User-Agent'] };
      if (req.headers.range) fwdHeaders['Range'] = req.headers.range;
      const upstream = await fetch(targetUrl, { headers: fwdHeaders });
      if (!upstream.ok || !upstream.body) {
        res.writeHead(upstream.status || 502);
        return res.end();
      }
      const outHeaders = {
        'Content-Type': upstream.headers.get('content-type') || targetMime,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      };
      if (upstream.headers.get('content-length')) outHeaders['Content-Length'] = upstream.headers.get('content-length');
      if (upstream.headers.get('content-range')) outHeaders['Content-Range'] = upstream.headers.get('content-range');
      res.writeHead(upstream.status, outHeaders);

      const reader = upstream.body.getReader();
      res.on('close', () => { try { reader.cancel(); } catch {} });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || res.writableEnded) break;
          res.write(Buffer.from(value));
        }
      } catch {}
      if (!res.writableEnded) res.end();
      return;
    }

    // ---------- Captions + on-demand translation ----------
    if (pathname === '/api/captions') {
      const videoId = extractVideoId(reqUrl.searchParams.get('v') || '');
      if (!videoId) return sendJSON(res, 400, { success: false, error: 'معرف الفيديو غير صالح' });
      const lang = reqUrl.searchParams.get('lang') || '';
      const auto = reqUrl.searchParams.get('auto') === '1';
      const translateTo = (reqUrl.searchParams.get('translate') || '').trim();
      const data = await getCaptions(videoId, lang, auto, translateTo);
      return sendJSON(res, 200, { success: true, ...data });
    }

    // ---------- Real YouTube comments ----------
    if (pathname === '/api/comments') {
      const videoId = extractVideoId(reqUrl.searchParams.get('v') || '');
      if (!videoId) return sendJSON(res, 400, { success: false, error: 'معرف الفيديو غير صالح' });
      const sort = reqUrl.searchParams.get('sort') === 'new' ? 'new' : 'top';
      const cursor = reqUrl.searchParams.get('cursor') || '';
      const data = await getComments(videoId, sort, cursor);
      return sendJSON(res, 200, { success: true, ...data });
    }

    // ---------- Auth config ----------
    if (pathname === '/api/auth/config') {
      return sendJSON(res, 200, {
        success: true,
        googleOAuth: OAUTH_ENABLED,
        googleClientId: GOOGLE_CLIENT_ID || '496823523744-s13qgm44idrlpe0ootkj32h1df7in24o.apps.googleusercontent.com',
        provider: OAUTH_ENABLED ? 'google' : 'google-gis',
        localAccounts: true
      });
    }

    // ---------- Local account registration ----------
    if (pathname === '/api/auth/register' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const name = String(body.name || '').trim();
        const email = normalizeEmail(body.email);
        const password = String(body.password || '');

        if (name.length < 2) {
          return sendJSON(res, 400, { success: false, error: 'الاسم يجب أن يكون حرفين على الأقل' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
          return sendJSON(res, 400, { success: false, error: 'البريد الإلكتروني غير صالح' });
        }
        if (password.length < 6) {
          return sendJSON(res, 400, { success: false, error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
        }
        if (findUserByEmail(email)) {
          return sendJSON(res, 409, { success: false, error: 'هذا البريد مسجّل بالفعل. سجّل الدخول بدلاً من ذلك.' });
        }

        const user = createUser({ name, email, password, provider: 'local' });
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': sessionCookieHeader(user)
        });
        return res.end(JSON.stringify({ success: true, user: publicUser(user) }));
      } catch (error) {
        return sendJSON(res, 400, { success: false, error: error.message || 'تعذر إنشاء الحساب' });
      }
    }

    // ---------- Local account login ----------
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const email = normalizeEmail(body.email);
        const password = String(body.password || '');
        const user = findUserByEmail(email);

        if (!user || !user.passwordHash) {
          return sendJSON(res, 401, { success: false, error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
        }
        if (!verifyPassword(password, user.salt, user.passwordHash)) {
          return sendJSON(res, 401, { success: false, error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
        }

        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': sessionCookieHeader(user)
        });
        return res.end(JSON.stringify({ success: true, user: publicUser(user) }));
      } catch (error) {
        return sendJSON(res, 400, { success: false, error: error.message || 'تعذر تسجيل الدخول' });
      }
    }

    // ---------- Google Identity Services (One-Tap / Official button token verification) ----------
    if (pathname === '/api/auth/google-token' && req.method === 'POST') {
      let bodyStr = '';
      req.on('data', chunk => { bodyStr += chunk; });
      req.on('end', () => {
        try {
          const body = JSON.parse(bodyStr || '{}');
          const credential = body.credential;
          if (!credential) {
            return sendJSON(res, 400, { success: false, error: 'رمز الدخول مفقود' });
          }
          const profile = decodeJwtPayload(credential);
          if (!profile || !profile.email) {
            return sendJSON(res, 400, { success: false, error: 'بيانات الحساب غير صالحة' });
          }
          const user = createUser({
            name: profile.name || profile.email.split('@')[0],
            email: profile.email,
            password: '',
            picture: profile.picture || '',
            provider: 'google'
          });
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Set-Cookie': sessionCookieHeader(user)
          });
          return res.end(JSON.stringify({
            success: true,
            user: publicUser(user)
          }));
        } catch (err) {
          return sendJSON(res, 500, { success: false, error: err.message });
        }
      });
      return;
    }

    // ---------- Safe Image / Channel Avatar Proxy ----------
    if (pathname === '/api/image-proxy') {
      const targetUrl = reqUrl.searchParams.get('url');
      if (!targetUrl || (!targetUrl.startsWith('https://') && !targetUrl.startsWith('http://'))) {
        res.writeHead(400);
        return res.end();
      }
      try {
        const upstream = await fetch(targetUrl, {
          headers: {
            'User-Agent': YT_HEADERS['User-Agent'],
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
          }
        });
        if (!upstream.ok) {
          res.writeHead(upstream.status);
          return res.end();
        }
        res.writeHead(200, {
          'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*'
        });
        const arrBuffer = await upstream.arrayBuffer();
        return res.end(Buffer.from(arrBuffer));
      } catch {
        res.writeHead(502);
        return res.end();
      }
    }

    // ---------- Current session ----------
    if (pathname === '/api/auth/me') {
      const user = userFromRequest(req);
      return sendJSON(res, 200, {
        success: true,
        user: publicUser(user)
      });
    }

    // ---------- Start Google OAuth ----------
    if (pathname === '/api/auth/google') {
      if (!OAUTH_ENABLED) {
        return sendJSON(res, 503, {
          success: false,
          error: 'Google OAuth غير مُهيأ. أضف GOOGLE_CLIENT_ID و GOOGLE_CLIENT_SECRET.'
        });
      }
      const state = crypto.randomBytes(24).toString('hex');
      const redirectUri = `${authBaseUrl(req)}/api/auth/google/callback`;
      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        access_type: 'online',
        prompt: 'select_account',
        state,
        hl: 'ar'
      });
      res.writeHead(302, {
        'Location': `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
        'Set-Cookie': `${OAUTH_STATE_COOKIE}=${state}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax`
      });
      return res.end();
    }

    // ---------- Google OAuth callback ----------
    if (pathname === '/api/auth/google/callback') {
      if (!OAUTH_ENABLED) {
        res.writeHead(302, { Location: '/?auth=error' });
        return res.end();
      }
      const code = reqUrl.searchParams.get('code');
      const state = reqUrl.searchParams.get('state');
      const expectedState = cookieValue(req, OAUTH_STATE_COOKIE);
      if (!code || !state || !expectedState || state !== expectedState) {
        res.writeHead(302, { Location: '/?auth=error' });
        return res.end();
      }

      const redirectUri = `${authBaseUrl(req)}/api/auth/google/callback`;
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code'
        })
      });
      if (!tokenRes.ok) {
        res.writeHead(302, { Location: '/?auth=error' });
        return res.end();
      }
      const tokens = await tokenRes.json();
      const profile = decodeJwtPayload(tokens.id_token || '');
      if (!profile || (profile.aud && profile.aud !== GOOGLE_CLIENT_ID)) {
        res.writeHead(302, { Location: '/?auth=error' });
        return res.end();
      }

      const user = createUser({
        name: profile.name || profile.email || 'Google User',
        email: profile.email || '',
        password: '',
        picture: profile.picture || '',
        provider: 'google'
      });
      res.writeHead(302, {
        Location: '/?auth=success',
        'Set-Cookie': [
          sessionCookieHeader(user),
          `${OAUTH_STATE_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`
        ]
      });
      return res.end();
    }

    // ---------- Logout ----------
    if (pathname === '/api/auth/logout') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`
      });
      return res.end(JSON.stringify({ success: true }));
    }

    // ---------- Video reaction / subscription state ----------
    if (pathname === '/api/video-state' && req.method === 'GET') {
      const store = getStore();
      const viewer = userFromRequest(req);
      const videoId = extractVideoId(reqUrl.searchParams.get('v') || '');
      const channelId = String(reqUrl.searchParams.get('channelId') || '');
      const channelName = String(reqUrl.searchParams.get('channelName') || '');
      if (!videoId) return sendJSON(res, 400, { success: false, error: 'معرف الفيديو غير صالح' });

      const reactions = store.reactions[videoId] || {};
      const values = Object.values(reactions);
      const likes = values.filter((value) => value === 'like').length;
      const dislikes = values.filter((value) => value === 'dislike').length;
      const viewerReaction = viewer ? (reactions[viewer.id] || null) : null;

      const subscriptions = viewer ? (store.subscriptions[viewer.id] || []) : [];
      const isSubscribed = subscriptions.some((entry) => (
        (channelId && entry.channelId === channelId)
        || (channelName && String(entry.channelName || '').toLowerCase() === channelName.toLowerCase())
      ));
      const subscriberDelta = Object.values(store.subscriptions).reduce((total, list) => (
        total + (Array.isArray(list) ? list.filter((entry) => (
          (channelId && entry.channelId === channelId)
          || (channelName && String(entry.channelName || '').toLowerCase() === channelName.toLowerCase())
        )).length : 0)
      ), 0);

      return sendJSON(res, 200, {
        success: true,
        reaction: viewerReaction,
        likes,
        dislikes,
        isSubscribed,
        subscriberDelta,
        commentCount: store.comments.filter((comment) => comment.videoId === videoId).length
      });
    }

    if (pathname === '/api/video-react' && req.method === 'POST') {
      const viewer = userFromRequest(req);
      if (!viewer) return sendJSON(res, 401, { success: false, error: 'سجّل الدخول أولاً' });
      try {
        const body = await readJsonBody(req);
        const videoId = extractVideoId(body.videoId || '');
        const reaction = body.reaction === 'like' || body.reaction === 'dislike' ? body.reaction : null;
        if (!videoId) return sendJSON(res, 400, { success: false, error: 'معرف الفيديو غير صالح' });

        const store = getStore();
        if (!store.reactions[videoId]) store.reactions[videoId] = {};
        if (reaction) store.reactions[videoId][viewer.id] = reaction;
        else delete store.reactions[videoId][viewer.id];
        saveStore();

        const values = Object.values(store.reactions[videoId]);
        return sendJSON(res, 200, {
          success: true,
          reaction,
          likes: values.filter((value) => value === 'like').length,
          dislikes: values.filter((value) => value === 'dislike').length
        });
      } catch (error) {
        return sendJSON(res, 400, { success: false, error: error.message });
      }
    }

    // ---------- Channel subscriptions ----------
    if (pathname === '/api/subscribe' && req.method === 'POST') {
      const viewer = userFromRequest(req);
      if (!viewer) return sendJSON(res, 401, { success: false, error: 'سجّل الدخول أولاً' });
      try {
        const body = await readJsonBody(req);
        const channelId = String(body.channelId || '');
        const channelName = String(body.channelName || '').trim();
        if (!channelName && !channelId) return sendJSON(res, 400, { success: false, error: 'بيانات القناة مفقودة' });

        const store = getStore();
        if (!store.subscriptions[viewer.id]) store.subscriptions[viewer.id] = [];
        const list = store.subscriptions[viewer.id];
        const index = list.findIndex((entry) => (
          (channelId && entry.channelId === channelId)
          || (channelName && String(entry.channelName || '').toLowerCase() === channelName.toLowerCase())
        ));

        let subscribed;
        if (index >= 0) {
          list.splice(index, 1);
          subscribed = false;
        } else {
          list.push({
            channelId,
            channelName: channelName || 'قناة يوتيوب',
            channelAvatar: String(body.channelAvatar || ''),
            createdAt: new Date().toISOString()
          });
          subscribed = true;
        }
        saveStore();

        return sendJSON(res, 200, { success: true, subscribed, subscriptions: list });
      } catch (error) {
        return sendJSON(res, 400, { success: false, error: error.message });
      }
    }

    if (pathname === '/api/subscriptions' && req.method === 'GET') {
      const viewer = userFromRequest(req);
      const store = getStore();
      const subscriptions = viewer ? (store.subscriptions[viewer.id] || []) : [];
      return sendJSON(res, 200, { success: true, subscriptions });
    }

    if (pathname === '/api/subscription-feed' && req.method === 'GET') {
      const viewer = userFromRequest(req);
      const store = getStore();
      const subscriptions = viewer ? (store.subscriptions[viewer.id] || []) : [];
      if (!subscriptions.length) {
        return sendJSON(res, 200, { success: true, videos: [], subscriptions: [] });
      }

      const withIds = subscriptions.filter((entry) => entry.channelId);
      const lists = await Promise.all(withIds.map((entry) => fetchChannelFeed(entry.channelId, entry)));
      const seen = new Set();
      const videos = [];
      for (const video of lists.flat()) {
        if (!video.id || seen.has(video.id)) continue;
        seen.add(video.id);
        videos.push(video);
      }
      videos.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
      return sendJSON(res, 200, {
        success: true,
        videos: videos.slice(0, 60),
        subscriptions
      });
    }

    // ---------- Community comments (real, persisted, with replies & likes) ----------
    if (pathname === '/api/community-comments' && req.method === 'GET') {
      const videoId = extractVideoId(reqUrl.searchParams.get('v') || '');
      if (!videoId) return sendJSON(res, 400, { success: false, error: 'معرف الفيديو غير صالح' });
      const sort = reqUrl.searchParams.get('sort') === 'new' ? 'new' : 'top';
      const viewer = userFromRequest(req);
      const store = getStore();
      let list = store.comments.filter((comment) => comment.videoId === videoId);

      const countReactions = (comment) => {
        const values = Object.values(comment.reactions || {});
        return values.filter((value) => value === 'like').length
          - values.filter((value) => value === 'dislike').length;
      };
      if (sort === 'top') {
        list = [...list].sort((a, b) => (
          countReactions(b) - countReactions(a)
          || new Date(b.createdAt) - new Date(a.createdAt)
        ));
      } else {
        list = [...list].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      }

      const grouped = groupCommunityComments(list, viewer);
      return sendJSON(res, 200, {
        success: true,
        comments: grouped,
        totalCount: list.length
      });
    }

    if (pathname === '/api/community-comments' && req.method === 'POST') {
      const viewer = userFromRequest(req);
      if (!viewer) return sendJSON(res, 401, { success: false, error: 'سجّل الدخول أولاً للتعليق' });
      try {
        const body = await readJsonBody(req);
        const videoId = extractVideoId(body.videoId || '');
        const text = String(body.text || '').trim();
        const parentId = body.parentId ? String(body.parentId) : null;
        if (!videoId) return sendJSON(res, 400, { success: false, error: 'معرف الفيديو غير صالح' });
        if (!text || text.length > 2000) {
          return sendJSON(res, 400, { success: false, error: 'نص التعليق مطلوب (حتى 2000 حرف)' });
        }

        const store = getStore();
        if (parentId) {
          const parent = store.comments.find((comment) => comment.id === parentId && comment.videoId === videoId);
          if (!parent || parent.parentId) {
            return sendJSON(res, 400, { success: false, error: 'لا يمكن الرد على هذا التعليق' });
          }
        }

        const comment = {
          id: newId('cm_'),
          videoId,
          userId: viewer.id,
          parentId,
          text,
          createdAt: new Date().toISOString(),
          editedAt: '',
          reactions: {}
        };
        store.comments.push(comment);
        saveStore();

        return sendJSON(res, 200, {
          success: true,
          comment: { ...commentView(comment, viewer), replies: [] }
        });
      } catch (error) {
        return sendJSON(res, 400, { success: false, error: error.message });
      }
    }

    const commentMatch = pathname.match(/^\/api\/community-comments\/([^/]+)$/);
    if (commentMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
      const viewer = userFromRequest(req);
      if (!viewer) return sendJSON(res, 401, { success: false, error: 'سجّل الدخول أولاً' });
      const store = getStore();
      const commentId = decodeURIComponent(commentMatch[1]);
      const index = store.comments.findIndex((comment) => comment.id === commentId);
      if (index === -1) return sendJSON(res, 404, { success: false, error: 'التعليق غير موجود' });
      if (!commentOwns(viewer, store.comments[index])) {
        return sendJSON(res, 403, { success: false, error: 'لا يمكنك تعديل هذا التعليق' });
      }

      if (req.method === 'DELETE') {
        store.comments = store.comments.filter((comment) => comment.id !== commentId && comment.parentId !== commentId);
        saveStore();
        return sendJSON(res, 200, { success: true });
      }

      try {
        const body = await readJsonBody(req);
        const text = String(body.text || '').trim();
        if (!text || text.length > 2000) {
          return sendJSON(res, 400, { success: false, error: 'نص التعليق غير صالح' });
        }
        const comment = store.comments[index];
        comment.text = text;
        comment.editedAt = new Date().toISOString();
        saveStore();
        return sendJSON(res, 200, {
          success: true,
          comment: { ...commentView(comment, viewer), replies: [] }
        });
      } catch (error) {
        return sendJSON(res, 400, { success: false, error: error.message });
      }
    }

    const commentReactionMatch = pathname.match(/^\/api\/community-comments\/([^/]+)\/react$/);
    if (commentReactionMatch && req.method === 'POST') {
      const viewer = userFromRequest(req);
      if (!viewer) return sendJSON(res, 401, { success: false, error: 'سجّل الدخول أولاً' });
      try {
        const body = await readJsonBody(req);
        const reaction = body.reaction === 'like' || body.reaction === 'dislike' ? body.reaction : null;
        const store = getStore();
        const comment = store.comments.find((entry) => entry.id === decodeURIComponent(commentReactionMatch[1]));
        if (!comment) return sendJSON(res, 404, { success: false, error: 'التعليق غير موجود' });

        if (!comment.reactions) comment.reactions = {};
        if (reaction) comment.reactions[viewer.id] = reaction;
        else delete comment.reactions[viewer.id];
        saveStore();

        const values = Object.values(comment.reactions);
        return sendJSON(res, 200, {
          success: true,
          reaction,
          likes: values.filter((value) => value === 'like').length,
          dislikes: values.filter((value) => value === 'dislike').length
        });
      } catch (error) {
        return sendJSON(res, 400, { success: false, error: error.message });
      }
    }

    // ---------- Channel page (Multi-tab: Home, Videos, Shorts, Live, Podcasts, Playlists, Community, Search) ----------
    if (pathname === '/api/channel' && req.method === 'GET') {
      let channelId = String(reqUrl.searchParams.get('channelId') || '');
      const channelName = String(reqUrl.searchParams.get('name') || '');
      const requestedTab = String(reqUrl.searchParams.get('tab') || 'home').toLowerCase();
      const customParams = String(reqUrl.searchParams.get('params') || '');
      const searchQuery = String(reqUrl.searchParams.get('q') || '').trim();

      if (!channelId && channelName) channelId = await resolveChannelId(channelName);
      if (!channelId && !channelName) {
        return sendJSON(res, 400, { success: false, error: 'معرف القناة مطلوب' });
      }

      const profile = await getChannelProfile(channelId, channelName);
      if (profile.channelId && !channelId) channelId = profile.channelId;

      const viewer = userFromRequest(req);
      const store = getStore();
      const stored = viewer ? (store.subscriptions[viewer.id] || []).find((entry) => (
        (channelId && entry.channelId === channelId)
        || (channelName && String(entry.channelName || '').toLowerCase() === channelName.toLowerCase())
      )) : null;

      const realAvatar = profile.avatar || stored?.channelAvatar || '';
      const channelInfo = {
        id: channelId,
        name: profile.name || stored?.channelName || channelName || 'قناة يوتيوب',
        avatar: realAvatar,
        banner: profile.banner || '',
        subscribers: profile.subscribers || '',
        videoCount: profile.videoCount || '',
        isSubscribed: !!stored
      };

      // In-channel search if query given
      if (searchQuery) {
        try {
          const results = await searchVideos(`${channelInfo.name} ${searchQuery}`);
          const filtered = results.filter(v => (
            String(v.channel || '').toLowerCase().includes(channelInfo.name.toLowerCase())
            || String(v.channelId || '') === channelId
          ));
          const finalVideos = filtered.length ? filtered : results;
          for (const v of finalVideos) {
            if (realAvatar) v.channelAvatar = realAvatar;
          }
          return sendJSON(res, 200, {
            success: true,
            channel: channelInfo,
            tabs: profile.tabs || DEFAULT_CHANNEL_TABS,
            currentTab: 'search',
            query: searchQuery,
            videos: finalVideos
          });
        } catch (err) {
          return sendJSON(res, 500, { success: false, error: 'تعذر البحث داخل القناة' });
        }
      }

      // Determine browse params for target tab
      let targetParams = customParams;
      if (!targetParams) {
        const found = (profile.tabs || []).find(t => t.id === requestedTab);
        targetParams = found?.params || CHANNEL_TAB_PARAMS[requestedTab] || CHANNEL_TAB_PARAMS.home;
      }

      let browseData = null;
      try {
        browseData = await ytBrowse({ browseId: channelId, params: targetParams });
      } catch (err) {
        console.warn('Tab browse error:', requestedTab, err.message);
      }

      let featuredVideo = null;
      let shelves = [];
      let videos = [];
      let shorts = [];
      let playlists = [];
      let podcasts = [];
      let posts = [];

      if (browseData) {
        if (requestedTab === 'home') {
          const homeResult = parseBrowseHomeTab(browseData, channelInfo);
          featuredVideo = homeResult.featuredVideo;
          shelves = homeResult.shelves;
          videos = parseBrowseChannelVideos(browseData, channelInfo);
        } else if (requestedTab === 'shorts') {
          shorts = parseBrowseShorts(browseData, channelInfo);
        } else if (requestedTab === 'playlists') {
          playlists = parseBrowsePlaylists(browseData, channelInfo);
        } else if (requestedTab === 'podcasts') {
          podcasts = parseBrowsePodcasts(browseData, channelInfo);
          if (!podcasts.length) {
            videos = parseBrowseChannelVideos(browseData, channelInfo);
          }
        } else if (requestedTab === 'community') {
          posts = parseBrowseCommunity(browseData, channelInfo);
        } else {
          // videos, live
          videos = parseBrowseChannelVideos(browseData, channelInfo);
        }
      }

      // Fallbacks if browse returned empty
      if (requestedTab === 'videos' && !videos.length) {
        try {
          videos = await fetchChannelFeed(channelId, stored || channelInfo);
        } catch {}
      }
      if (!videos.length && !shorts.length && !playlists.length && !podcasts.length && !posts.length && !shelves.length) {
        try {
          videos = await searchVideos(channelInfo.name);
        } catch {}
      }

      // Guarantee realAvatar on all videos
      for (const v of videos) {
        if (realAvatar) v.channelAvatar = realAvatar;
      }
      for (const p of podcasts) {
        if (realAvatar && !p.channelAvatar) p.channelAvatar = realAvatar;
      }
      for (const shelf of shelves) {
        if (shelf.videos) {
          for (const v of shelf.videos) {
            if (realAvatar) v.channelAvatar = realAvatar;
          }
        }
      }

      return sendJSON(res, 200, {
        success: true,
        channel: channelInfo,
        tabs: profile.tabs || DEFAULT_CHANNEL_TABS,
        currentTab: requestedTab,
        featuredVideo,
        shelves,
        videos,
        shorts,
        playlists,
        podcasts,
        posts
      });
    }

    // ---------- In-app download (direct with guaranteed audio+video muxing) ----------
    if (pathname === '/api/download-direct') {
      const videoId = extractVideoId(reqUrl.searchParams.get('v') || '');
      const type = reqUrl.searchParams.get('type') === 'video' ? 'video' : 'audio';
      if (!videoId) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('معرف الفيديو غير صالح');
      }

      let info;
      try {
        info = await getRawInfo(videoId);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('تعذر جلب بيانات الفيديو للتحميل: ' + err.message);
      }

      let format = pickDownloadFormat(info, type);
      if (!format || !format.url) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('لا يوجد تنسيق متاح للتحميل');
      }

      const rawTitle = info.videoDetails?.title || `video_${videoId}`;
      const safeAscii = sanitizeFilename(rawTitle).replace(/[^\x20-\x7E]/g, '_') || 'video';
      const utf8Filename = encodeURIComponent(sanitizeFilename(rawTitle));

      // If video download lacks integrated audio, mux HD video + best audio into MP4!
      if (type === 'video' && !format.hasAudio) {
        if (req.method === 'HEAD') {
          res.writeHead(200, {
            'Content-Disposition': `attachment; filename="${safeAscii}.mp4"; filename*=UTF-8''${utf8Filename}.mp4`,
            'Content-Type': 'video/mp4',
            'Access-Control-Allow-Origin': '*'
          });
          return res.end();
        }

        const audioFmt = pickDownloadFormat(info, 'audio');
        if (ffmpegPath && audioFmt && audioFmt.url) {
          // Send headers IMMEDIATELY so browser opens Download progress UI right away!
          res.writeHead(200, {
            'Content-Disposition': `attachment; filename="${safeAscii}.mp4"; filename*=UTF-8''${utf8Filename}.mp4`,
            'Content-Type': 'video/mp4',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*'
          });

          const canCopyAudio = /mp4a/i.test(audioFmt.mimeType || '');
          const proc = spawn(ffmpegPath, [
            '-loglevel', 'error',
            '-user_agent', YT_HEADERS['User-Agent'],
            '-i', format.url,
            '-user_agent', YT_HEADERS['User-Agent'],
            '-i', audioFmt.url,
            '-c:v', 'copy',
            '-c:a', canCopyAudio ? 'copy' : 'aac',
            '-shortest',
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
            '-f', 'mp4',
            'pipe:1'
          ], { stdio: ['ignore', 'pipe', 'pipe'] });

          proc.stdout.pipe(res);
          res.on('close', () => { try { proc.kill('SIGKILL'); } catch {} });
          proc.stderr?.on('data', chunk => {
            const msg = chunk.toString().trim();
            if (msg) console.warn('ffmpeg pipe:', msg);
          });
          proc.on('error', (err) => {
            console.warn('ffmpeg pipe error:', err.message);
            if (!res.writableEnded) res.end();
          });
          return;
        }

        // Fallback: fetch muxed format (hasVideo && hasAudio) via Tv / WebEmbedded client
        try {
          const tvYtdl = new Ytdl({ clients: [Client.Tv, Client.WebEmbedded, Client.Mweb] });
          const tvInfo = await tvYtdl.getInfo(videoId);
          const tvMuxed = (tvInfo.formats || []).filter(f => f.url && f.hasVideo && f.hasAudio)
            .sort((a, b) => (parseStandardQualityHeight(b) || 0) - (parseStandardQualityHeight(a) || 0));
          if (tvMuxed.length) {
            format = tvMuxed[0];
          }
        } catch (fbErr) {
          console.warn('Tv fallback format error:', fbErr.message);
        }
      }

      const ext = type === 'audio'
        ? (/mp4a/i.test(format.mimeType) ? 'm4a' : 'mp3')
        : 'mp4';
      const mime = type === 'audio'
        ? (/mp4a/i.test(format.mimeType) ? 'audio/mp4' : 'audio/mpeg')
        : (format.mimeType?.split(';')[0] || 'video/mp4');

      const headers = {
        'User-Agent': YT_HEADERS['User-Agent']
      };
      if (req.headers.range) {
        headers['Range'] = req.headers.range;
      }

      let upstream;
      try {
        upstream = await fetch(format.url, { headers });
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('تعذر الاتصال بمصدر الفيديو للتحميل');
      }

      if (!upstream.ok || !upstream.body) {
        res.writeHead(upstream.status || 502, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('تعذر تدفق ملف التحميل');
      }

      const responseHeaders = {
        'Content-Disposition': `attachment; filename="${safeAscii}.${ext}"; filename*=UTF-8''${utf8Filename}.${ext}`,
        'Content-Type': mime,
        'Access-Control-Allow-Origin': '*'
      };

      if (upstream.headers.get('content-length')) {
        responseHeaders['Content-Length'] = upstream.headers.get('content-length');
      }
      if (upstream.headers.get('content-range')) {
        responseHeaders['Content-Range'] = upstream.headers.get('content-range');
      }

      res.writeHead(upstream.status, responseHeaders);

      if (req.method === 'HEAD') {
        return res.end();
      }

      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(Buffer.from(value))) {
            await new Promise(resolve => res.once('drain', resolve));
          }
        }
      } catch (err) {
        console.error('Download stream error:', err.message);
      }
      return res.end();
    }

    // ---------- System status ----------
    if (pathname === '/api/status') {
      return sendJSON(res, 200, {
        success: true,
        app: 'AYTube',
        version: '3.0.0',
        status: 'online',
        customPlayer: true,
        realComments: true,
        captionTranslation: true,
        googleOAuth: OAUTH_ENABLED
      });
    }

    // ---------- Static files ----------
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      return sendJSON(res, 400, { success: false, error: 'Bad path' });
    }

    let filePath = path.normalize(path.join(PUBLIC_DIR, decodedPath === '/' ? 'index.html' : decodedPath));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Forbidden');
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ['.html', '.js', '.css', '.json'].includes(ext)
        ? 'no-cache'
        : 'public, max-age=3600'
    });
    fs.createReadStream(filePath).pipe(res);

  } catch (err) {
    console.error('Server error:', err);
    if (!res.headersSent) {
      sendJSON(res, 500, { success: false, error: err.message || 'Internal server error' });
    } else {
      res.destroy();
    }
  }
};

importLegacyHistory();

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 AYTube running on: http://localhost:${PORT}`);
  console.log(`   Custom player: ON | Real comments: ON | Caption translation: ON`);
  console.log(`   Google OAuth: ${OAUTH_ENABLED ? 'ON' : 'OFF (local Google-style sign-in)'}`);
  console.log(`======================================================\n`);
  setTimeout(() => {
    refreshHomeInBackground('global');
  }, 150);
});

const fallbackPort = Number(PORT) === 5000 ? 3400 : 5000;
const serverSecondary = http.createServer(handleRequest);
serverSecondary.on('error', () => {});
serverSecondary.listen(fallbackPort, () => {
  console.log(`🚀 AYTube ALSO running on: http://localhost:${fallbackPort}`);
});

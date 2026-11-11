import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');
const LEGACY_HISTORY_FILE = path.join(__dirname, '..', 'api-tools', 'users-history.json');

function emptyStore() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    users: [],
    reactions: {},
    subscriptions: {},
    comments: [],
    history: {},
    watchStats: {},
    playlists: {},
    notifications: [],
    cloudPro: { codeHash: '', proEnabled: true, epoch: 0, updatedAt: '' }
  };
}

let cache = null;

function normalizeStore(data) {
  const base = emptyStore();
  if (!data || typeof data !== 'object') return base;
  return {
    ...base,
    ...data,
    users: Array.isArray(data.users) ? data.users : [],
    reactions: data.reactions && typeof data.reactions === 'object' ? data.reactions : {},
    subscriptions: data.subscriptions && typeof data.subscriptions === 'object' ? data.subscriptions : {},
    comments: Array.isArray(data.comments) ? data.comments : [],
    history: data.history && typeof data.history === 'object' ? data.history : {},
    watchStats: data.watchStats && typeof data.watchStats === 'object' ? data.watchStats : {},
    playlists: data.playlists && typeof data.playlists === 'object' ? data.playlists : {},
    notifications: Array.isArray(data.notifications) ? data.notifications : [],
    cloudPro: data.cloudPro && typeof data.cloudPro === 'object'
      ? {
          codeHash: String(data.cloudPro.codeHash || ''),
          proEnabled: data.cloudPro.proEnabled !== false,
          epoch: Number(data.cloudPro.epoch || 0),
          updatedAt: String(data.cloudPro.updatedAt || '')
        }
      : { codeHash: '', proEnabled: true, epoch: 0, updatedAt: '' }
  };
}

export function getStore() {
  if (cache) return cache;
  try {
    if (fs.existsSync(DB_FILE)) {
      cache = normalizeStore(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
    }
  } catch (error) {
    console.error('Store read error:', error.message);
  }
  if (!cache) cache = emptyStore();
  return cache;
}

export function saveStore() {
  if (!cache) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${DB_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, DB_FILE);
  } catch (error) {
    console.error('Store write error:', error.message);
  }
}

export function newId(prefix = '') {
  return `${prefix}${crypto.randomBytes(12).toString('hex')}`;
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  try {
    const candidate = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(hash, 'hex');
    if (candidate.length !== expected.length) return false;
    return crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

export function findUserByEmail(email) {
  const target = normalizeEmail(email);
  return getStore().users.find((user) => normalizeEmail(user.email) === target) || null;
}

export function findUserById(id) {
  return getStore().users.find((user) => user.id === id) || null;
}

export function createUser({ name, email, password, picture = '', provider = 'local' }) {
  const existing = findUserByEmail(email);
  if (existing) return existing;

  const credentials = password ? hashPassword(password) : null;
  const user = {
    id: newId('u_'),
    name: String(name || '').trim() || String(email).split('@')[0],
    email: normalizeEmail(email),
    picture: picture || '',
    provider,
    salt: credentials?.salt || '',
    passwordHash: credentials?.hash || '',
    createdAt: new Date().toISOString()
  };
  getStore().users.push(user);
  saveStore();
  return user;
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    picture: user.picture || '',
    provider: user.provider || 'local',
    createdAt: user.createdAt || ''
  };
}

export function importLegacyHistory() {
  const store = getStore();
  if (store.meta?.legacyHistoryImported) return;
  try {
    if (fs.existsSync(LEGACY_HISTORY_FILE)) {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_HISTORY_FILE, 'utf8'));
      for (const [key, list] of Object.entries(legacy || {})) {
        if (!Array.isArray(list)) continue;
        const uid = key === 'global_history' ? 'global' : `email:${key}`;
        if (!Array.isArray(store.history[uid])) store.history[uid] = list.filter((v) => v && v.id);
      }
    }
  } catch {
    /* ignore legacy import errors */
  }
  store.meta = { ...(store.meta || {}), legacyHistoryImported: true };
  saveStore();
}

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PRO_JSON_LOCAL = path.join(ROOT, 'docs', 'pro.json');
const ENV_LOCAL = path.join(ROOT, '.env');
const REPO = 'menara-store-ma/aytube-cloud';

function sha256Epoch(cleanCode) {
  return crypto.createHash('sha256').update(`AYTUBE_PRO_V1:${cleanCode}`).digest('hex');
}

function generateRandomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += chars[bytes[i] % chars.length];
  return out.match(/.{1,4}/g).join('-');
}

function promptQuestion(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(q, ans => { rl.close(); resolve(ans); }));
}

function updateLocalEnvHash(newHash, enabled) {
  if (!fs.existsSync(ENV_LOCAL)) return;
  let content = fs.readFileSync(ENV_LOCAL, 'utf8');
  const lines = content.split(/\r?\n/).filter(l => !l.startsWith('PRO_MASTER_CODE=') && !l.startsWith('PRO_MASTER_HASH=') && !l.startsWith('PRO_ENABLED='));
  lines.push(`PRO_MASTER_HASH=${newHash}`);
  lines.push(`PRO_ENABLED=${enabled ? '1' : '0'}`);
  fs.writeFileSync(ENV_LOCAL, lines.join('\n').trim() + '\n', 'utf8');
}

async function main() {
  const arg = (process.argv[2] || '').trim();
  let modeEnable = true;
  let rawCode = arg;

  if (!rawCode) {
    console.log('\n=== AYTube PRO Cloud Control (Free Cloud Server) ===');
    console.log('1) Enter a NEW PRO activation code (or leave empty to generate random)');
    console.log('2) Type OFF to stop PRO globally on ALL devices');
    rawCode = (await promptQuestion('\nNew PRO Code (or OFF, or Enter for random): ')).trim();
  }

  let current = { epoch: 1, codeHash: '', minVersion: '3.0.0' };
  try {
    current = JSON.parse(fs.readFileSync(PRO_JSON_LOCAL, 'utf8'));
  } catch {}

  let nextHash = current.codeHash || '';
  if (rawCode.toUpperCase() === 'OFF') {
    modeEnable = false;
  } else {
    if (!rawCode) rawCode = generateRandomCode();
    const normalized = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (normalized.length < 6) {
      console.error('❌ Code must be at least 6 alphanumeric characters.');
      process.exit(1);
    }
    rawCode = normalized.match(/.{1,4}/g).join('-');
    nextHash = sha256Epoch(normalized);
  }

  const nextPayload = {
    app: 'AYTube',
    proEnabled: modeEnable,
    epoch: Number(current.epoch || 1) + 1,
    codeHash: nextHash,
    minVersion: '3.0.0',
    updatedAt: new Date().toISOString()
  };
  const jsonText = JSON.stringify(nextPayload, null, 2) + '\n';
  fs.mkdirSync(path.dirname(PRO_JSON_LOCAL), { recursive: true });
  fs.writeFileSync(PRO_JSON_LOCAL, jsonText, 'utf8');
  updateLocalEnvHash(nextHash, modeEnable);

  // Push update cleanly to GitHub Cloud Server via gh CLI (no secrets exposed)
  let sha = '';
  try {
    const cur = JSON.parse(execFileSync('gh', ['api', `repos/${REPO}/contents/docs/pro.json`], { encoding: 'utf8' }));
    sha = cur.sha || '';
  } catch {}

  const bodyObj = {
    message: modeEnable ? `Rotate AYTube PRO epoch ${nextPayload.epoch}` : `Pause AYTube PRO epoch ${nextPayload.epoch}`,
    content: Buffer.from(jsonText, 'utf8').toString('base64')
  };
  if (sha) bodyObj.sha = sha;

  const tmpFile = path.join(ROOT, 'docs', '.tmp_put.json');
  fs.writeFileSync(tmpFile, JSON.stringify(bodyObj), 'utf8');
  try {
    execFileSync('gh', ['api', '--method', 'PUT', `repos/${REPO}/contents/docs/pro.json`, '--input', tmpFile], { stdio: 'inherit' });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }

  console.log('\n======================================================');
  console.log(modeEnable ? `✅ LIVE CLOUD PRO CODE UPDATED -> ${rawCode}` : '🛑 PRO DISABLED GLOBALLY ON CLOUD SERVER');
  console.log(`   Epoch: ${nextPayload.epoch} | Hash: ${nextHash}`);
  console.log('   All phones & PC copies running old codes will revoke automatically.');
  console.log('======================================================\n');
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * PlayBack API & CLI Engine
 * أداة سطر الأوامر ومكتبة التفاعل مع خدمات PlayBack و YouTube
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * استخراج معرف الفيديو من الرابط أو النص
 */
export function extractVideoId(urlOrId) {
  if (!urlOrId) return null;
  urlOrId = urlOrId.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(urlOrId)) return urlOrId;
  const match = urlOrId.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

/**
 * البحث عن اقتراحات الإكمال التلقائي (Autocomplete Suggestions)
 */
export async function getSuggestions(query) {
  if (!query) return [];
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data[1]) ? data[1] : [];
  } catch (err) {
    return [];
  }
}

/**
 * البحث المباشر في يوتيوب واستخراج الفيديوهات
 */
export async function searchVideos(query) {
  if (!query) return [];
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  const res = await fetch(searchUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8'
    }
  });

  if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
  const html = await res.text();
  const match = html.match(/var ytInitialData = ({.*?});<\/script>/);
  if (!match) return [];

  const data = JSON.parse(match[1]);
  const secList = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
  
  const results = [];
  for (const sec of secList) {
    const contents = sec?.itemSectionRenderer?.contents || [];
    for (const item of contents) {
      const v = item.videoRenderer;
      if (v && v.videoId) {
        // استخراج شعار القناة بدقة مع ضمان البروتوكول https:
        let channelAvatar = 
          v.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails?.[0]?.url ||
          v.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.avatar?.thumbnails?.[0]?.url ||
          v.channelThumbnail?.thumbnails?.[0]?.url ||
          '';

        if (channelAvatar && channelAvatar.startsWith('//')) {
          channelAvatar = 'https:' + channelAvatar;
        }

        const thumbs = v.thumbnail?.thumbnails || [];
        const bestThumb = (thumbs.length ? thumbs[thumbs.length - 1].url : '')
          || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`;

        const timeOverlay = (v.thumbnailOverlays || []).find(o => o.thumbnailOverlayTimeStatusRenderer)?.thumbnailOverlayTimeStatusRenderer;
        const isLive = timeOverlay?.style === 'LIVE' || (v.badges || []).some(b => b.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_LIVE_NOW');
        const isShort = Boolean(v.navigationEndpoint?.reelWatchEndpoint) || timeOverlay?.style === 'SHORTS' || /#shorts/i.test(v.title?.runs?.[0]?.text || '');

        results.push({
          id: v.videoId,
          title: v.title?.runs?.[0]?.text || '',
          channel: v.ownerText?.runs?.[0]?.text || '',
          channelAvatar: channelAvatar,
          duration: v.lengthText?.simpleText || (isShort ? 'Shorts' : (isLive ? 'بث مباشر' : '')),
          isShort,
          isLive,
          views: v.viewCountText?.simpleText || '',
          publishedTime: v.publishedTimeText?.simpleText || '',
          thumbnail: bestThumb.startsWith('//') ? ('https:' + bestThumb) : bestThumb,
          url: isShort ? `https://www.youtube.com/shorts/${v.videoId}` : `https://www.youtube.com/watch?v=${v.videoId}`
        });
      }
    }
  }
  return results;
}

/**
 * توليد ملف قائمة تشغيل M3U المتوافق مع VLC ومشغلات الوسائط
 */
export function generateM3U(videos, playlistTitle = 'PlayBack Playlist') {
  let m3u = `#EXTM3U name="${playlistTitle}"\n\n`;
  for (const v of videos) {
    m3u += `#EXTINF:-1 tvg-id="${v.id}" tvg-name="${v.title}" tvg-logo="${v.thumbnail}" group-title="${v.channel}",${v.title}\n`;
    m3u += `https://www.youtube.com/watch?v=${v.id}\n\n`;
  }
  return m3u;
}

/**
 * توليد حزمة نسخ احتياطي متوافقة 100% مع تطبيق PlayBack أندرويد
 */
export function createBackupPayload(favorites = [], history = []) {
  return {
    version: 1,
    minAppVersionCode: 1,
    createdAt: Date.now(),
    autoBackupCadence: "DAILY",
    preferences: {
      night_mode_pref: "-1",
      l2j4k23k4jl2kj34l3k2: "ar",
      search_platform_pref: "https://www.youtube.com/results?search_query=",
      j6lk456j54lk6j54l6kj54k6: false,
      jl345j34lk5j34lk5j43lk5j34lk5j43: true, // تفعيل Pro تلقائياً
      onboarding_completed_v1: true
    },
    favorites: favorites.map(f => ({
      videoId: f.id || f.videoId,
      name: f.title || f.name,
      url: f.url || `https://www.youtube.com/watch?v=${f.id || f.videoId}`,
      important: !!f.important,
      created: f.created || Date.now(),
      isSelected: false
    })),
    history: history.map(h => ({
      videoId: h.id || h.videoId,
      name: h.title || h.name,
      url: h.url || `https://www.youtube.com/watch?v=${h.id || h.videoId}`,
      created: h.created || Date.now(),
      isSelected: false
    }))
  };
}

// ===================== CLI Execution =====================
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMainModule) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                   PlayBack Engine CLI                         ║
║      أداة سطر الأوامر لمشغل واستنساخ PlayBack                 ║
╚═══════════════════════════════════════════════════════════════╝

الاستخدام:
  node playback-cli.mjs search <query>       - البحث عن فيديوهات في يوتيوب
  node playback-cli.mjs suggest <query>      - جلب اقتراحات الإكمال التلقائي
  node playback-cli.mjs info <url_or_id>     - استخراج معلومات الفيديو وصورة الغلاف
  node playback-cli.mjs m3u <query> [file]   - البحث وتوليد ملف قائمة قنوات M3U لـ VLC
  node playback-cli.mjs backup-export [file] - تصدير نموذج نسخ احتياطي PlayBack متوافق
`);
    process.exit(0);
  }

  run(command, args);
}

async function run(command, args) {
  try {
    switch (command) {
      case 'search': {
        const query = args.slice(1).join(' ');
        if (!query) throw new Error('يرجى تحديد عبارة البحث');
        console.log(`🔍 جارٍ البحث عن: "${query}"...\n`);
        const results = await searchVideos(query);
        console.log(`✅ تم العثور على ${results.length} فيديو:\n`);
        results.forEach((v, i) => {
          console.log(`[${i + 1}] ${v.title}`);
          console.log(`    📺 القناة: ${v.channel} | ⏱️ المدة: ${v.duration} | 👁️ ${v.views}`);
          console.log(`    🔗 الرابط: ${v.url}`);
          console.log(`    🖼️ الغلاف: ${v.thumbnail}\n`);
        });
        break;
      }

      case 'suggest': {
        const query = args.slice(1).join(' ');
        if (!query) throw new Error('يرجى تحديد عبارة البحث');
        const suggestions = await getSuggestions(query);
        console.log(`💡 اقتراحات البحث لـ "${query}":\n`);
        suggestions.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
        break;
      }

      case 'info': {
        const input = args[1];
        if (!input) throw new Error('يرجى تحديد رابط أو معرف الفيديو');
        const id = extractVideoId(input);
        if (!id) throw new Error('معرف فيديو غير صالح');
        console.log(`🎥 معلومات الفيديو:`);
        console.log(`  معرف الفيديو (ID): ${id}`);
        console.log(`  الرابط المباشر: https://www.youtube.com/watch?v=${id}`);
        console.log(`  رابط التضمين (Embed): https://www.youtube.com/embed/${id}?autoplay=1`);
        console.log(`  صورة الغلاف (High): https://img.youtube.com/vi/${id}/hqdefault.jpg`);
        console.log(`  صورة الغلاف (Max): https://img.youtube.com/vi/${id}/maxresdefault.jpg`);
        break;
      }

      case 'm3u': {
        const query = args[1];
        const outPath = args[2] || 'playback_playlist.m3u';
        if (!query) throw new Error('يرجى تحديد عبارة البحث لتوليد القائمة');
        console.log(`⏳ جارٍ جلب الفيديوهات وتوليد ملف M3U لـ "${query}"...`);
        const videos = await searchVideos(query);
        const m3uContent = generateM3U(videos, `PlayBack - ${query}`);
        fs.writeFileSync(outPath, m3uContent, 'utf-8');
        console.log(`✅ تم حفظ ملف M3U بنجاح في: ${path.resolve(outPath)} (${videos.length} عنصر)`);
        break;
      }

      case 'backup-export': {
        const outPath = args[1] || 'playback_backup.json';
        const sampleFavs = [
          { id: 'dQw4w9WgXcQ', title: 'Rick Astley - Never Gonna Give You Up', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }
        ];
        const payload = createBackupPayload(sampleFavs, sampleFavs);
        fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf-8');
        console.log(`✅ تم تصدير ملف النسخة الاحتياطية بنجاح إلى: ${path.resolve(outPath)}`);
        break;
      }

      default:
      console.log(`أمر غير معروف: ${command}`);
  }
} catch (err) {
  console.error(`❌ خطأ: ${err.message}`);
  process.exit(1);
}
}

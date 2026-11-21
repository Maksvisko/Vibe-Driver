#!/usr/bin/env node
/**
 * Scan public/music/ for audio files → public/music/playlist.json
 *
 * Naming convention: "Artist - Title.mp3"  →  { artist, title }
 * Or any other name → title = filename without ext, artist = "Unknown"
 */
import { readdir, writeFile, access } from 'node:fs/promises';
import { join, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const musicDir = join(__dirname, '..', 'public', 'music');
const outFile = join(musicDir, 'playlist.json');

const AUDIO_EXT = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.flac', '.aac', '.opus']);

try {
  await access(musicDir);
} catch {
  console.error('❌ Папка public/music/ не найдена. Создай её и положи треки.');
  process.exit(1);
}

const files = (await readdir(musicDir))
  .filter((f) => AUDIO_EXT.has(extname(f).toLowerCase()))
  .sort((a, b) => a.localeCompare(b, 'ru'));

const tracks = files.map((file) => {
  const name = basename(file, extname(file));
  // "Artist - Title" or "01. Artist - Title" or "01 - Artist - Title"
  const cleaned = name.replace(/^\d{1,3}\s*[.\-–—]\s*/, '');
  let artist = 'Unknown';
  let title = cleaned;
  const parts = cleaned.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    artist = parts[0].trim();
    title = parts.slice(1).join(' - ').trim();
  }
  return { artist, title, url: `./music/${encodeURIComponent(file)}` };
});

await writeFile(outFile, JSON.stringify({ generated: Date.now(), tracks }, null, 2), 'utf8');

if (tracks.length === 0) {
  console.log('📻 Плейлист пуст — положи аудио в public/music/ и запусти снова.');
} else {
  console.log(`✅ Плейлист: ${tracks.length} трек(ов) → ${outFile}`);
  tracks.forEach((t, i) => console.log(`   ${String(i + 1).padStart(2, '0')}. ${t.artist} — ${t.title}`));
}

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ZipArchive } from 'archiver';
import type { SpotifyUrlInfoModule } from 'spotify-url-info';
import type {
  AudioBitrate,
  DownloadMode,
  ExtractedCollection,
  MediaFormat,
  MediaPlatform,
  MediaTrackItem,
  PreparedFileResponse,
  VideoQuality,
} from '../src/types/media.ts';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const createSpotifyUrlInfo = require('spotify-url-info') as SpotifyUrlInfoModule;
const spotifyInfo = createSpotifyUrlInfo(fetch);

const ffmpegStaticPath = (() => {
  try {
    const p = require('ffmpeg-static') as string | null;
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
})();

export function getFfmpegPath(): string | null {
  if (fs.existsSync('/usr/bin/ffmpeg')) return '/usr/bin/ffmpeg';
  if (ffmpegStaticPath && fs.existsSync(ffmpegStaticPath)) return ffmpegStaticPath;
  return null;
}

const isServerless = Boolean(
  process.env.VERCEL ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.NETLIFY,
);

const SERVERLESS_MAX_INLINE_BYTES = 3_100_000;
const SEGMENT_SECRET =
  process.env.SEGMENT_SECRET ||
  process.env.VERCEL_PROJECT_ID ||
  process.env.GEMINI_API_KEY ||
  'valhiem-segment-secret-v1';

const ALLOWED_SEGMENT_HOSTS = [
  'soundcloud.cloud',
  'sndcdn.com',
  'audius.co',
  'scdn.co',
];

export function signSegmentUrl(targetUrl: string): string {
  const payload = Buffer.from(
    JSON.stringify({ u: targetUrl, exp: Date.now() + 30 * 60_000 }),
    'utf8',
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', SEGMENT_SECRET)
    .update(payload)
    .digest('hex')
    .slice(0, 24);
  return `${payload}.${sig}`;
}

export function verifySegmentToken(token: string): string | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto
    .createHmac('sha256', SEGMENT_SECRET)
    .update(payload)
    .digest('hex')
    .slice(0, 24);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { u?: string; exp?: number };
    if (!parsed.u || !parsed.exp || parsed.exp < Date.now()) return null;
    const u = new URL(parsed.u);
    if (u.protocol !== 'https:') return null;
    const hostAllowed = ALLOWED_SEGMENT_HOSTS.some(
      (h) => u.hostname === h || u.hostname.endsWith(`.${h}`),
    );
    return hostAllowed ? u.toString() : null;
  } catch {
    return null;
  }
}

interface YtsVideoResult {
  title?: string;
  description?: string;
  seconds?: number;
  thumbnail?: string;
  author?: { name?: string };
}

const yts = require('yt-search') as (opts: {
  videoId: string;
}) => Promise<YtsVideoResult>;

export class MediaEngineError extends Error {
  status: number;
  code: string;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'MediaEngineError';
    this.code = code;
    this.status = status;
  }
}

export interface StoredFileEntry {
  fileId: string;
  filePath: string;
  tempDir: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  resolvedSource: PreparedFileResponse['resolvedSource'];
  createdAt: number;
}

const storedFiles = new Map<string, StoredFileEntry>();
const FILE_TTL_MS = 20 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of storedFiles.entries()) {
    if (now - entry.createdAt > FILE_TTL_MS) {
      storedFiles.delete(id);
      fs.rmSync(entry.tempDir, { recursive: true, force: true });
    }
  }
}, 60 * 1000).unref();

export function getStoredFile(fileId: string): StoredFileEntry | undefined {
  return storedFiles.get(fileId);
}

let cachedYtDlpPath: string | null = null;

export async function ensureYtDlp(): Promise<string> {
  if (cachedYtDlpPath && fs.existsSync(cachedYtDlpPath)) {
    return cachedYtDlpPath;
  }

  const localBin = path.resolve(
    process.cwd(),
    'node_modules/yt-dlp-exec/bin/yt-dlp',
  );
  if (fs.existsSync(localBin)) {
    cachedYtDlpPath = localBin;
    return localBin;
  }

  const tmpBin = path.join(os.tmpdir(), 'soundpress-yt-dlp');
  if (fs.existsSync(tmpBin)) {
    cachedYtDlpPath = tmpBin;
    return tmpBin;
  }

  const res = await fetch(
    'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
  );
  if (!res.ok) {
    throw new MediaEngineError(
      'YTDLP_UNAVAILABLE',
      'Unable to initialize media extractor binary.',
      500,
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tmpBin, buffer);
  fs.chmodSync(tmpBin, 0o755);
  cachedYtDlpPath = tmpBin;
  return tmpBin;
}

export function detectPlatform(rawUrl: string): MediaPlatform {
  const lower = rawUrl.toLowerCase();
  if (
    lower.includes('spotify.com') ||
    lower.includes('spotify.link') ||
    lower.startsWith('spotify:')
  ) {
    return 'spotify';
  }
  if (
    lower.includes('youtube.com') ||
    lower.includes('youtu.be') ||
    lower.includes('music.youtube.com')
  ) {
    return 'youtube';
  }
  if (lower.includes('soundcloud.com')) {
    return 'soundcloud';
  }
  if (lower.includes('bandcamp.com')) {
    return 'bandcamp';
  }
  if (lower.includes('vimeo.com')) {
    return 'vimeo';
  }
  return 'other';
}

function sanitizeFilename(input: string): string {
  return input
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'media-download';
}

function buildSearchQueries(title: string, artist?: string): string[] {
  const beforePipe = title.split(/\s*\|\s*|\s*\/\/\s*/)[0] || title;
  const stripped = beforePipe
    .replace(/\((official|music|lyric|lyrics|audio|video|hd|4k|remaster|remastered|live|visualizer|full|song)[^)]*\)/gi, '')
    .replace(/\[(official|music|lyric|lyrics|audio|video|hd|4k|remaster|remastered|live|visualizer|full|song)[^\]]*\]/gi, '')
    .replace(/\b(official music video|official video|official audio|music video|lyric video|4k remaster|visualizer)\b/gi, '')
    .replace(/\((with|feat\.?|ft\.?)\s+([^)]+)\)/gi, ' $2 ')
    .replace(/[|,•]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const cleanArtist = (artist || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .trim();

  const titleHasArtistDash = /\s[-–—]\s/.test(beforePipe);
  const genericChannel =
    !cleanArtist ||
    cleanArtist === 'Unknown Artist' ||
    cleanArtist === 'YouTube Creator' ||
    cleanArtist === 'YouTube' ||
    /\b(records|music|official|channel|entertainment|t-series)\b/i.test(cleanArtist);

  const primary =
    !titleHasArtistDash &&
    !genericChannel &&
    !stripped.toLowerCase().includes(cleanArtist.toLowerCase())
      ? `${cleanArtist} ${stripped}`.trim()
      : stripped;

  const words = stripped
    .replace(/[-–—:]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  const shortQuery = words.slice(0, 5).join(' ').trim();

  const queries = [primary];
  if (shortQuery && shortQuery.toLowerCase() !== primary.toLowerCase()) {
    queries.push(shortQuery);
  }
  return queries;
}

function extractYouTubeIds(rawUrl: string): {
  videoId?: string;
  listId?: string;
  isExplicitPlaylist: boolean;
} {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const listId = parsed.searchParams.get('list') || undefined;
    let videoId = parsed.searchParams.get('v') || undefined;

    if (host === 'youtu.be') {
      videoId = parsed.pathname.split('/').filter(Boolean)[0] || videoId;
    } else if (parsed.pathname.startsWith('/shorts/')) {
      videoId = parsed.pathname.split('/')[2] || videoId;
    } else if (parsed.pathname.startsWith('/embed/')) {
      videoId = parsed.pathname.split('/')[2] || videoId;
    }

    const isExplicitPlaylist =
      parsed.pathname === '/playlist' ||
      (Boolean(listId) &&
        !listId!.startsWith('RD') &&
        !videoId);

    return { videoId, listId, isExplicitPlaylist };
  } catch {
    return { isExplicitPlaylist: false };
  }
}

async function resolveShortUrl(rawUrl: string): Promise<string> {
  try {
    const parsed = new URL(rawUrl);
    if (
      parsed.hostname.includes('spotify.link') ||
      parsed.hostname.includes('on.soundcloud.com')
    ) {
      const res = await fetch(rawUrl, { method: 'GET', redirect: 'follow' });
      return res.url || rawUrl;
    }
  } catch {
    // ignore
  }
  return rawUrl;
}

function findNodesByKey(obj: unknown, key: string, results: unknown[] = []): unknown[] {
  if (!obj || typeof obj !== 'object') return results;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      findNodesByKey(item, key, results);
    }
    return results;
  }
  const record = obj as Record<string, unknown>;
  if (key in record) {
    results.push(record[key]);
  }
  for (const val of Object.values(record)) {
    if (val && typeof val === 'object') {
      findNodesByKey(val, key, results);
    }
  }
  return results;
}

function readYtText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { simpleText?: string; runs?: Array<{ text?: string }> };
  if (n.simpleText) return n.simpleText;
  if (Array.isArray(n.runs)) {
    return n.runs.map((r) => r.text || '').join('').trim();
  }
  return '';
}

function parseDurationText(text: string): number {
  const parts = text
    .trim()
    .split(':')
    .map((p) => Number.parseInt(p, 10))
    .filter((n) => !Number.isNaN(n));
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

async function extractYouTubePlaylistViaHtml(
  listId: string,
  sourceUrl: string,
): Promise<ExtractedCollection> {
  const playlistUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`;
  const res = await fetch(playlistUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) {
    throw new MediaEngineError(
      'PLAYLIST_FETCH_FAILED',
      'Could not load this YouTube playlist. Make sure it is public or unlisted.',
      400,
    );
  }
  const html = await res.text();
  const match =
    html.match(/var ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/) ||
    html.match(/window\["ytInitialData"\]\s*=\s*(\{[\s\S]*?\});/);

  if (!match?.[1]) {
    throw new MediaEngineError(
      'PLAYLIST_PARSE_FAILED',
      'Could not parse YouTube playlist metadata. Ensure the playlist URL is public.',
      400,
    );
  }

  const data = JSON.parse(match[1]) as Record<string, unknown>;
  const metaNodes = findNodesByKey(data, 'playlistMetadataRenderer') as Array<{
    title?: string;
  }>;
  const headerNodes = findNodesByKey(data, 'playlistHeaderRenderer') as Array<{
    title?: unknown;
    ownerText?: unknown;
    descriptionText?: unknown;
    playlistHeaderBanner?: {
      heroPlaylistThumbnailRenderer?: {
        thumbnail?: { thumbnails?: Array<{ url?: string }> };
      };
    };
  }>;

  const pageHeaderNodes = findNodesByKey(data, 'pageHeaderViewModel') as Array<{
    title?: { dynamicTextViewModel?: { text?: { content?: string } } };
  }>;

  const videoNodes = findNodesByKey(data, 'playlistVideoRenderer') as Array<{
    videoId?: string;
    title?: unknown;
    shortBylineText?: unknown;
    lengthSeconds?: string;
    lengthText?: unknown;
    thumbnail?: { thumbnails?: Array<{ url?: string }> };
  }>;

  const lockupNodes = findNodesByKey(data, 'lockupViewModel') as Array<{
    contentId?: string;
    contentType?: string;
    contentImage?: {
      thumbnailViewModel?: {
        image?: { sources?: Array<{ url?: string }> };
        overlays?: Array<{
          thumbnailBottomOverlayViewModel?: {
            badges?: Array<{
              thumbnailBadgeViewModel?: { text?: string };
            }>;
          };
        }>;
      };
    };
    metadata?: {
      lockupMetadataViewModel?: {
        title?: { content?: string };
        metadata?: {
          contentMetadataViewModel?: {
            metadataRows?: Array<{
              metadataParts?: Array<{ text?: { content?: string } }>;
            }>;
          };
        };
      };
    };
  }>;

  const seen = new Set<string>();
  const tracks: MediaTrackItem[] = [];

  for (const node of videoNodes) {
    if (!node.videoId || seen.has(node.videoId)) continue;
    seen.add(node.videoId);
    const title = readYtText(node.title) || `Track ${tracks.length + 1}`;
    const artist = readYtText(node.shortBylineText) || 'YouTube Creator';
    const durationSec = node.lengthSeconds
      ? Number.parseInt(node.lengthSeconds, 10) || 0
      : parseDurationText(readYtText(node.lengthText));
    const thumbs = node.thumbnail?.thumbnails || [];
    const thumbnail =
      thumbs[thumbs.length - 1]?.url ||
      `https://i.ytimg.com/vi/${node.videoId}/hqdefault.jpg`;

    tracks.push({
      id: node.videoId,
      index: tracks.length + 1,
      title,
      artist,
      durationSec,
      thumbnail,
      url: `https://www.youtube.com/watch?v=${node.videoId}`,
      platform: 'youtube',
      isVideoCapable: true,
    });
  }

  for (const lv of lockupNodes) {
    const vid = lv.contentId;
    if (!vid || seen.has(vid)) continue;
    if (lv.contentType && lv.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') {
      continue;
    }
    seen.add(vid);
    const meta = lv.metadata?.lockupMetadataViewModel;
    const title = meta?.title?.content || `Track ${tracks.length + 1}`;
    const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows || [];
    const artist =
      rows[0]?.metadataParts?.[0]?.text?.content || 'YouTube Creator';
    const overlays = lv.contentImage?.thumbnailViewModel?.overlays || [];
    const badgeText =
      overlays[0]?.thumbnailBottomOverlayViewModel?.badges?.[0]
        ?.thumbnailBadgeViewModel?.text || '';
    const durationSec = parseDurationText(badgeText);
    const sources = lv.contentImage?.thumbnailViewModel?.image?.sources || [];
    const thumbnail =
      sources[sources.length - 1]?.url ||
      `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;

    tracks.push({
      id: vid,
      index: tracks.length + 1,
      title,
      artist,
      durationSec,
      thumbnail,
      url: `https://www.youtube.com/watch?v=${vid}`,
      platform: 'youtube',
      isVideoCapable: true,
    });
  }

  if (!tracks.length) {
    throw new MediaEngineError(
      'PLAYLIST_EMPTY',
      'No playable videos found in this YouTube playlist (it may be private or empty).',
      404,
    );
  }

  const header = headerNodes[0];
  const playlistTitle =
    metaNodes[0]?.title ||
    readYtText(header?.title) ||
    pageHeaderNodes[0]?.title?.dynamicTextViewModel?.text?.content ||
    'YouTube Playlist';
  const creator = readYtText(header?.ownerText) || 'YouTube';
  const bannerThumbs =
    header?.playlistHeaderBanner?.heroPlaylistThumbnailRenderer?.thumbnail
      ?.thumbnails || [];
  const thumbnail =
    bannerThumbs[bannerThumbs.length - 1]?.url || tracks[0]?.thumbnail;

  const totalDurationSec = tracks.reduce((acc, t) => acc + t.durationSec, 0);

  return {
    id: listId,
    kind: 'playlist',
    platform: 'youtube',
    title: playlistTitle,
    creator,
    description: readYtText(header?.descriptionText) || undefined,
    thumbnail,
    sourceUrl,
    totalDurationSec,
    trackCount: tracks.length,
    isVideoCapable: true,
    tracks,
  };
}

async function extractSpotifyCollection(
  url: string,
): Promise<ExtractedCollection> {
  const details = await spotifyInfo.getDetails(url);
  const preview = details.preview || ({} as Record<string, unknown>);
  const rawTracks = Array.isArray(details.tracks)
    ? (details.tracks as unknown as Array<Record<string, unknown>>)
    : [];

  const type = String(preview.type || '').toLowerCase();
  const kind: ExtractedCollection['kind'] =
    type === 'playlist'
      ? 'playlist'
      : type === 'album'
        ? 'album'
        : rawTracks.length > 1
          ? 'playlist'
          : 'track';

  const tracks: MediaTrackItem[] = rawTracks.map((t: Record<string, unknown>, idx: number) => {
    const uri = String(t.uri || '');
    const spotifyId = uri.split(':').pop() || `sp-${idx + 1}`;
    const artist =
      typeof t.artist === 'string' && t.artist.trim()
        ? t.artist.trim()
        : Array.isArray(t.artists)
          ? (t.artists as Array<{ name?: string }>)
              .map((a) => a.name)
              .filter(Boolean)
              .join(', ')
          : String(preview.artist || 'Unknown Artist');

    const durationMs = Number(t.duration || 0);
    const durationSec = durationMs > 1000 ? Math.round(durationMs / 1000) : Math.round(durationMs);

    const coverSources =
      (t.coverArt as { sources?: Array<{ url?: string }> } | undefined)?.sources || [];
    const thumbnail =
      coverSources[0]?.url ||
      (typeof preview.image === 'string' ? preview.image : undefined);

    const previewUrl =
      typeof t.previewUrl === 'string'
        ? t.previewUrl
        : (t.audioPreview as { url?: string } | undefined)?.url ||
          (rawTracks.length === 1 && typeof preview.audio === 'string'
            ? preview.audio
            : undefined);

    const trackUrl =
      uri.startsWith('spotify:track:')
        ? `https://open.spotify.com/track/${spotifyId}`
        : url;

    return {
      id: spotifyId,
      index: idx + 1,
      title: String(t.name || preview.title || `Track ${idx + 1}`),
      artist: artist || 'Unknown Artist',
      album:
        kind === 'album'
          ? String(preview.title || '')
          : undefined,
      durationSec,
      thumbnail,
      url: trackUrl,
      previewUrl,
      platform: 'spotify',
      isVideoCapable: false,
    };
  });

  if (tracks.length === 0) {
    const single = (await spotifyInfo.getData(url)) as {
      id?: string;
      name?: string;
      title?: string;
      duration?: number;
      artists?: Array<{ name?: string }>;
      coverArt?: { sources?: Array<{ url?: string }> };
      audioPreview?: { url?: string };
    };
    const artists = Array.isArray(single.artists)
      ? single.artists.map((a) => a.name).filter(Boolean).join(', ')
      : String(preview.artist || 'Unknown Artist');
    const coverSources = single.coverArt?.sources || [];
    const durationSec = single.duration ? Math.round(single.duration / 1000) : 0;

    tracks.push({
      id: single.id || crypto.randomUUID(),
      index: 1,
      title: single.name || single.title || String(preview.title || 'Spotify Track'),
      artist: artists || 'Unknown Artist',
      durationSec,
      thumbnail:
        coverSources[0]?.url ||
        (typeof preview.image === 'string' ? preview.image : undefined),
      url,
      previewUrl: single.audioPreview?.url || (typeof preview.audio === 'string' ? preview.audio : undefined),
      platform: 'spotify',
      isVideoCapable: false,
    });
  }

  const totalDurationSec = tracks.reduce((acc, t) => acc + t.durationSec, 0);

  return {
    id: crypto.createHash('sha1').update(url).digest('hex').slice(0, 12),
    kind,
    platform: 'spotify',
    title: String(preview.title || tracks[0]?.title || 'Spotify Media'),
    creator: String(preview.artist || tracks[0]?.artist || 'Spotify'),
    description:
      typeof preview.description === 'string' ? preview.description : undefined,
    thumbnail:
      (typeof preview.image === 'string' ? preview.image : undefined) ||
      tracks[0]?.thumbnail,
    sourceUrl: url,
    totalDurationSec,
    trackCount: tracks.length,
    isVideoCapable: false,
    tracks,
  };
}

async function runYtDlpJson(
  target: string,
  args: string[] = [],
  cookiesPath?: string,
): Promise<Record<string, unknown>> {
  const bin = await ensureYtDlp();
  const cmdArgs = [
    '--dump-single-json',
    '--no-warnings',
    '--ignore-errors',
    ...args,
  ];
  if (cookiesPath) {
    cmdArgs.push('--cookies', cookiesPath);
  }
  cmdArgs.push(target);

  const { stdout } = await execFileAsync(bin, cmdArgs, {
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
  });

  return JSON.parse(stdout) as Record<string, unknown>;
}

export async function extractMediaInfo(
  rawUrl: string,
  cookiesText?: string,
): Promise<ExtractedCollection> {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new MediaEngineError('INVALID_URL', 'Please paste a media URL.', 400);
  }

  let normalizedUrl = trimmed;
  if (normalizedUrl.startsWith('spotify:')) {
    const parts = normalizedUrl.split(':');
    if (parts.length === 3) {
      normalizedUrl = `https://open.spotify.com/${parts[1]}/${parts[2]}`;
    }
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Unsupported protocol');
    }
  } catch {
    throw new MediaEngineError(
      'INVALID_URL',
      'Please enter a valid http/https URL from Spotify, YouTube, SoundCloud, or another supported site.',
      400,
    );
  }

  normalizedUrl = await resolveShortUrl(parsedUrl.toString());
  const platform = detectPlatform(normalizedUrl);

  if (platform === 'spotify') {
    try {
      return await extractSpotifyCollection(normalizedUrl);
    } catch (err) {
      throw new MediaEngineError(
        'SPOTIFY_EXTRACT_FAILED',
        err instanceof Error
          ? `Could not extract Spotify URL: ${err.message}`
          : 'Could not extract Spotify URL. Ensure the track or playlist is public.',
        400,
      );
    }
  }

  if (platform === 'youtube') {
    const { videoId, listId, isExplicitPlaylist } = extractYouTubeIds(normalizedUrl);

    if (isExplicitPlaylist && listId) {
      return await extractYouTubePlaylistViaHtml(listId, normalizedUrl);
    }

    // Try yt-dlp first if cookies provided, otherwise fast yt-search + oEmbed
    if (cookiesText?.trim()) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ext-'));
      try {
        const cookieFile = path.join(tempDir, 'cookies.txt');
        fs.writeFileSync(cookieFile, cookiesText, 'utf8');
        const info = await runYtDlpJson(
          normalizedUrl,
          ['--flat-playlist'],
          cookieFile,
        );
        return normalizeYtDlpInfo(info, normalizedUrl, platform);
      } catch {
        // fallback below
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }

    if (listId && !videoId) {
      return await extractYouTubePlaylistViaHtml(listId, normalizedUrl);
    }

    if (videoId) {
      try {
        const video = await yts({ videoId });
        const track: MediaTrackItem = {
          id: videoId,
          index: 1,
          title: video.title || 'YouTube Video',
          artist: video.author?.name || 'YouTube Creator',
          durationSec: video.seconds || 0,
          thumbnail:
            video.thumbnail ||
            `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          platform: 'youtube',
          isVideoCapable: true,
        };
        return {
          id: videoId,
          kind: 'video',
          platform: 'youtube',
          title: track.title,
          creator: track.artist,
          description: video.description || undefined,
          thumbnail: track.thumbnail,
          sourceUrl: normalizedUrl,
          totalDurationSec: track.durationSec,
          trackCount: 1,
          isVideoCapable: true,
          tracks: [track],
        };
      } catch {
        // fallback to oEmbed
        const oembedRes = await fetch(
          `https://www.youtube.com/oembed?url=${encodeURIComponent(normalizedUrl)}&format=json`,
        );
        if (oembedRes.ok) {
          const oembed = (await oembedRes.json()) as {
            title?: string;
            author_name?: string;
            thumbnail_url?: string;
          };
          const track: MediaTrackItem = {
            id: videoId,
            index: 1,
            title: oembed.title || 'YouTube Video',
            artist: oembed.author_name || 'YouTube Creator',
            durationSec: 0,
            thumbnail:
              oembed.thumbnail_url ||
              `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            url: `https://www.youtube.com/watch?v=${videoId}`,
            platform: 'youtube',
            isVideoCapable: true,
          };
          return {
            id: videoId,
            kind: 'video',
            platform: 'youtube',
            title: track.title,
            creator: track.artist,
            thumbnail: track.thumbnail,
            sourceUrl: normalizedUrl,
            totalDurationSec: 0,
            trackCount: 1,
            isVideoCapable: true,
            tracks: [track],
          };
        }
      }
    }

    if (listId) {
      return await extractYouTubePlaylistViaHtml(listId, normalizedUrl);
    }
  }

  if (platform === 'soundcloud') {
    try {
      const scCollection = await resolveSoundCloudUrlPureJs(normalizedUrl);
      if (scCollection) return scCollection;
    } catch {
      // fall through to yt-dlp if available
    }
  }

  // Generic yt-dlp extractor for SoundCloud, Bandcamp, Vimeo, etc.
  try {
    const info = await runYtDlpJson(normalizedUrl, ['--flat-playlist']);
    return normalizeYtDlpInfo(info, normalizedUrl, platform);
  } catch (err) {
    throw new MediaEngineError(
      'EXTRACT_FAILED',
      err instanceof Error
        ? `Could not extract media metadata: ${err.message}`
        : 'Could not extract media metadata from this URL.',
      400,
    );
  }
}

function normalizeYtDlpInfo(
  info: Record<string, unknown>,
  sourceUrl: string,
  platform: MediaPlatform,
): ExtractedCollection {
  const entries = Array.isArray(info.entries)
    ? (info.entries as Array<Record<string, unknown>>).filter(Boolean)
    : [];

  if (entries.length > 0) {
    const tracks: MediaTrackItem[] = entries.map((e, idx) => {
      const url = String(e.webpage_url || e.url || sourceUrl);
      const vcodec = String(e.vcodec || '');
      const isVideoCapable =
        platform === 'youtube' ||
        platform === 'vimeo' ||
        (Boolean(vcodec) && vcodec !== 'none');

      return {
        id: String(e.id || `item-${idx + 1}`),
        index: idx + 1,
        title: String(e.title || e.track || `Track ${idx + 1}`),
        artist: String(e.artist || e.uploader || e.channel || 'Creator'),
        album: e.album ? String(e.album) : undefined,
        durationSec: Math.round(Number(e.duration || 0)),
        thumbnail:
          typeof e.thumbnail === 'string'
            ? e.thumbnail
            : Array.isArray(e.thumbnails) && e.thumbnails.length > 0
              ? String((e.thumbnails[e.thumbnails.length - 1] as { url?: string }).url || '')
              : undefined,
        url,
        platform,
        isVideoCapable,
      };
    });

    const totalDurationSec = tracks.reduce((acc, t) => acc + t.durationSec, 0);
    return {
      id: String(info.id || crypto.randomUUID()),
      kind: 'playlist',
      platform,
      title: String(info.title || 'Media Playlist'),
      creator: String(info.uploader || info.channel || platform),
      description:
        typeof info.description === 'string'
          ? info.description.slice(0, 300)
          : undefined,
      thumbnail:
        typeof info.thumbnail === 'string'
          ? info.thumbnail
          : tracks[0]?.thumbnail,
      sourceUrl,
      totalDurationSec,
      trackCount: tracks.length,
      isVideoCapable: tracks.some((t) => t.isVideoCapable),
      tracks,
    };
  }

  const vcodec = String(info.vcodec || '');
  const isVideoCapable =
    platform === 'youtube' ||
    platform === 'vimeo' ||
    (Boolean(vcodec) && vcodec !== 'none');

  const singleTrack: MediaTrackItem = {
    id: String(info.id || crypto.randomUUID()),
    index: 1,
    title: String(info.title || info.track || 'Media Item'),
    artist: String(info.artist || info.uploader || info.channel || 'Creator'),
    album: info.album ? String(info.album) : undefined,
    durationSec: Math.round(Number(info.duration || 0)),
    thumbnail: typeof info.thumbnail === 'string' ? info.thumbnail : undefined,
    url: String(info.webpage_url || sourceUrl),
    platform,
    isVideoCapable,
  };

  return {
    id: singleTrack.id,
    kind: isVideoCapable ? 'video' : 'track',
    platform,
    title: singleTrack.title,
    creator: singleTrack.artist,
    description:
      typeof info.description === 'string'
        ? info.description.slice(0, 300)
        : undefined,
    thumbnail: singleTrack.thumbnail,
    sourceUrl,
    totalDurationSec: singleTrack.durationSec,
    trackCount: 1,
    isVideoCapable,
    tracks: [singleTrack],
  };
}

function getMimeType(format: MediaFormat): string {
  switch (format) {
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
      return 'audio/mp4';
    case 'flac':
      return 'audio/flac';
    case 'wav':
      return 'audio/wav';
    case 'mp4':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
  }
}

async function transcodeAndTagAudio(params: {
  inputFile: string;
  outputFile: string;
  format: 'mp3' | 'm4a' | 'flac' | 'wav';
  bitrate: AudioBitrate | '96';
  title: string;
  artist: string;
  album?: string;
  coverFile?: string;
}): Promise<boolean> {
  const ffmpegBin = getFfmpegPath();
  if (!ffmpegBin) return false;

  const runFfmpeg = async (withCover: boolean) => {
    const args: string[] = ['-y', '-loglevel', 'error', '-i', params.inputFile];
    const canEmbedArt =
      withCover &&
      params.coverFile &&
      fs.existsSync(params.coverFile) &&
      (params.format === 'mp3' || params.format === 'm4a');

    if (canEmbedArt) {
      args.push('-i', params.coverFile!);
      args.push('-map', '0:a:0', '-map', '1:v:0');
      args.push('-disposition:v:0', 'attached_pic');
      if (params.format === 'mp3') {
        args.push('-id3v2_version', '3');
      }
    } else {
      args.push('-vn');
    }

    if (params.format === 'mp3') {
      args.push('-c:a', 'libmp3lame', '-b:a', `${params.bitrate}k`);
    } else if (params.format === 'm4a') {
      args.push('-c:a', 'aac', '-b:a', `${params.bitrate}k`);
      if (canEmbedArt) {
        args.push('-c:v', 'mjpeg');
      }
    } else if (params.format === 'flac') {
      args.push('-c:a', 'flac');
    } else if (params.format === 'wav') {
      args.push('-c:a', 'pcm_s16le');
    }

    args.push('-metadata', `title=${params.title}`);
    args.push('-metadata', `artist=${params.artist}`);
    if (params.album) {
      args.push('-metadata', `album=${params.album}`);
    }

    args.push(params.outputFile);

    await execFileAsync(ffmpegBin, args, {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 180_000,
    });
  };

  try {
    await runFfmpeg(true);
    return true;
  } catch {
    if (params.coverFile) {
      try {
        await runFfmpeg(false);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

async function downloadCoverImage(
  thumbnailUrl: string | undefined,
  tempDir: string,
): Promise<string | undefined> {
  if (!thumbnailUrl) return undefined;
  try {
    const res = await fetch(thumbnailUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) return undefined;
    const coverPath = path.join(tempDir, 'cover.jpg');
    fs.writeFileSync(coverPath, buf);
    return coverPath;
  } catch {
    return undefined;
  }
}

interface ScTranscoding {
  url?: string;
  preset?: string;
  duration?: number;
  snipped?: boolean;
  format?: { protocol?: string; mime_type?: string };
  is_legacy_transcoding?: boolean;
}

interface ScTrackPayload {
  id?: number;
  kind?: string;
  title?: string;
  description?: string;
  duration?: number;
  policy?: string;
  permalink_url?: string;
  artwork_url?: string;
  track_authorization?: string;
  user?: { username?: string };
  media?: { transcodings?: ScTranscoding[] };
  tracks?: ScTrackPayload[];
}

let cachedScClientId: { value: string; fetchedAt: number } | null = null;
const SC_CLIENT_ID_TTL_MS = 6 * 60 * 60 * 1000;

async function getSoundCloudClientId(forceRefresh = false): Promise<string | null> {
  if (
    !forceRefresh &&
    cachedScClientId &&
    Date.now() - cachedScClientId.fetchedAt < SC_CLIENT_ID_TTL_MS
  ) {
    return cachedScClientId.value;
  }

  try {
    const htmlRes = await fetch('https://soundcloud.com', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!htmlRes.ok) return null;
    const html = await htmlRes.text();
    const jsUrls = [
      ...html.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js/g),
    ].map((m) => m[0]);

    for (const jsUrl of jsUrls.slice(-6).reverse()) {
      const jsRes = await fetch(jsUrl, { signal: AbortSignal.timeout(6000) });
      if (!jsRes.ok) continue;
      const js = await jsRes.text();
      const match = js.match(/client_id\s*[:=]\s*["']([a-zA-Z0-9]{20,40})["']/);
      if (match?.[1]) {
        cachedScClientId = { value: match[1], fetchedAt: Date.now() };
        return match[1];
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function formatScArtwork(url?: string): string | undefined {
  if (!url) return undefined;
  return url.replace('-large.', '-t500x500.');
}

async function resolveSoundCloudUrlPureJs(
  sourceUrl: string,
): Promise<ExtractedCollection | null> {
  let clientId = await getSoundCloudClientId();
  if (!clientId) return null;

  let res = await fetch(
    `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(sourceUrl)}&client_id=${clientId}`,
    { signal: AbortSignal.timeout(8000) },
  );
  if (res.status === 401 || res.status === 403) {
    clientId = await getSoundCloudClientId(true);
    if (!clientId) return null;
    res = await fetch(
      `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(sourceUrl)}&client_id=${clientId}`,
      { signal: AbortSignal.timeout(8000) },
    );
  }
  if (!res.ok) return null;

  const data = (await res.json()) as ScTrackPayload;

  if (data.kind === 'playlist' && Array.isArray(data.tracks)) {
    const rawTracks = data.tracks;
    const missingIds = rawTracks
      .filter((t) => t.id && !t.title)
      .map((t) => t.id!)
      .slice(0, 50);

    const hydratedMap = new Map<number, ScTrackPayload>();
    if (missingIds.length > 0) {
      try {
        const batchRes = await fetch(
          `https://api-v2.soundcloud.com/tracks?ids=${missingIds.join(',')}&client_id=${clientId}`,
          { signal: AbortSignal.timeout(8000) },
        );
        if (batchRes.ok) {
          const list = (await batchRes.json()) as ScTrackPayload[];
          for (const item of list) {
            if (item.id) hydratedMap.set(item.id, item);
          }
        }
      } catch {
        // ignore partial hydration errors
      }
    }

    const tracks: MediaTrackItem[] = rawTracks
      .map((item, idx) => {
        const full = item.title ? item : (item.id ? hydratedMap.get(item.id) : undefined);
        if (!full?.title) return null;
        return {
          id: String(full.id || `sc-${idx + 1}`),
          index: idx + 1,
          title: full.title,
          artist: full.user?.username || data.user?.username || 'SoundCloud Creator',
          durationSec: Math.round((full.duration || 0) / 1000),
          thumbnail: formatScArtwork(full.artwork_url || data.artwork_url),
          url: full.permalink_url || sourceUrl,
          platform: 'soundcloud' as const,
          isVideoCapable: false,
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);

    if (tracks.length === 0) return null;
    const totalDurationSec = tracks.reduce((acc, t) => acc + t.durationSec, 0);

    return {
      id: String(data.id || crypto.randomUUID()),
      kind: 'playlist',
      platform: 'soundcloud',
      title: data.title || 'SoundCloud Playlist',
      creator: data.user?.username || 'SoundCloud',
      description: data.description?.slice(0, 300),
      thumbnail: formatScArtwork(data.artwork_url) || tracks[0]?.thumbnail,
      sourceUrl,
      totalDurationSec,
      trackCount: tracks.length,
      isVideoCapable: false,
      tracks,
    };
  }

  if (data.kind === 'track' && data.title) {
    const track: MediaTrackItem = {
      id: String(data.id || crypto.randomUUID()),
      index: 1,
      title: data.title,
      artist: data.user?.username || 'SoundCloud Artist',
      durationSec: Math.round((data.duration || 0) / 1000),
      thumbnail: formatScArtwork(data.artwork_url),
      url: data.permalink_url || sourceUrl,
      platform: 'soundcloud',
      isVideoCapable: false,
    };

    return {
      id: track.id,
      kind: 'track',
      platform: 'soundcloud',
      title: track.title,
      creator: track.artist,
      description: data.description?.slice(0, 300),
      thumbnail: track.thumbnail,
      sourceUrl,
      totalDurationSec: track.durationSec,
      trackCount: 1,
      isVideoCapable: false,
      tracks: [track],
    };
  }

  return null;
}

interface CandidateMatch {
  url: string;
  score: number;
  source: 'soundcloud-match' | 'audius-match';
  scTrackId?: number;
  scTrackAuth?: string;
  scTranscodings?: ScTranscoding[];
}

function scoreMatch(
  candidateTitle: string,
  candidateArtist: string,
  candidateDurationSec: number,
  targetTitle: string,
  targetArtist: string,
  targetDurationSec: number,
): number {
  let score = 0;
  const normCand = `${candidateTitle} ${candidateArtist}`.toLowerCase();
  const stopWords = new Set(['official', 'video', 'audio', 'music', 'lyric', 'lyrics', 'visualizer', 'remaster', 'remastered', 'full', 'song']);
  const targetTokens = `${targetTitle} ${targetArtist}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w));

  for (const token of targetTokens) {
    if (normCand.includes(token)) score += 12;
  }

  if (targetDurationSec > 60 && candidateDurationSec > 0 && candidateDurationSec <= 35) {
    // Likely SoundCloud Go+ 30s preview
    score -= 200;
  }

  if (targetDurationSec > 0 && targetDurationSec < 600 && candidateDurationSec > 900) {
    // Avoid 2-hour mixes when looking for a regular song
    score -= 120;
  }

  if (targetDurationSec > 0 && candidateDurationSec > 0) {
    const diff = Math.abs(candidateDurationSec - targetDurationSec);
    if (diff <= 5) score += 35;
    else if (diff <= 15) score += 20;
    else if (diff <= 40) score += 5;
    else score -= Math.min(40, Math.floor(diff / 10));
  }

  return score;
}

async function searchSoundCloudPureJs(
  query: string,
  targetTitle: string,
  targetArtist: string,
  targetDurationSec: number,
): Promise<CandidateMatch[]> {
  let clientId = await getSoundCloudClientId();
  if (!clientId) return [];

  let res = await fetch(
    `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=8`,
    { signal: AbortSignal.timeout(8000) },
  );
  if (res.status === 401 || res.status === 403) {
    clientId = await getSoundCloudClientId(true);
    if (!clientId) return [];
    res = await fetch(
      `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=8`,
      { signal: AbortSignal.timeout(8000) },
    );
  }
  if (!res.ok) return [];

  const json = (await res.json()) as { collection?: ScTrackPayload[] };
  const results: CandidateMatch[] = [];

  for (const entry of json.collection || []) {
    if (!entry.permalink_url) continue;
    const scDuration = Math.round(Number(entry.duration || 0) / 1000);
    if (
      targetDurationSec > 60 &&
      (entry.policy === 'SNIP' || scDuration <= 35)
    ) {
      continue;
    }
    const score = scoreMatch(
      entry.title || '',
      entry.user?.username || '',
      scDuration,
      targetTitle,
      targetArtist,
      targetDurationSec,
    );
    results.push({
      url: entry.permalink_url,
      score,
      source: 'soundcloud-match',
      scTrackId: entry.id,
      scTrackAuth: entry.track_authorization,
      scTranscodings: entry.media?.transcodings,
    });
  }

  return results;
}

async function downloadSoundCloudTrackPureJs(
  candidate: CandidateMatch,
  tempDir: string,
  prefix: string,
): Promise<{
  filePath: string;
  ext: 'mp3' | 'm4a';
  segmentUrls?: string[];
} | null> {
  let clientId = await getSoundCloudClientId();
  if (!clientId) return null;

  let trackAuth = candidate.scTrackAuth;
  let transcodings = candidate.scTranscodings;

  if (candidate.scTrackId && (!trackAuth || !transcodings?.length)) {
    const trRes = await fetch(
      `https://api-v2.soundcloud.com/tracks/${candidate.scTrackId}?client_id=${clientId}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (trRes.ok) {
      const trData = (await trRes.json()) as ScTrackPayload;
      trackAuth = trData.track_authorization || trackAuth;
      transcodings = trData.media?.transcodings || transcodings;
    }
  } else if (!candidate.scTrackId && candidate.url.includes('soundcloud.com')) {
    const resRes = await fetch(
      `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(candidate.url)}&client_id=${clientId}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (resRes.ok) {
      const trData = (await resRes.json()) as ScTrackPayload;
      trackAuth = trData.track_authorization;
      transcodings = trData.media?.transcodings;
    }
  }

  if (!transcodings?.length) return null;

  const usable = transcodings
    .filter((t) => t.url && !t.snipped)
    .sort((a, b) => {
      const rank = (t: ScTranscoding) => {
        if (t.format?.protocol === 'progressive') return 0;
        if (t.format?.mime_type?.includes('mpeg') && !t.is_legacy_transcoding) return 1;
        if (t.preset?.includes('aac_160')) return 2;
        if (t.format?.mime_type?.includes('mp4')) return 3;
        return 4;
      };
      return rank(a) - rank(b);
    });

  for (const tr of usable) {
    try {
      const sep = tr.url!.includes('?') ? '&' : '?';
      const authPart = trackAuth
        ? `&track_authorization=${encodeURIComponent(trackAuth)}`
        : '';
      const resolveRes = await fetch(
        `${tr.url}${sep}client_id=${clientId}${authPart}`,
        { signal: AbortSignal.timeout(8000) },
      );
      if (!resolveRes.ok) continue;
      const resolvedJson = (await resolveRes.json()) as { url?: string };
      if (!resolvedJson.url) continue;

      if (tr.format?.protocol === 'progressive') {
        const audioRes = await fetch(resolvedJson.url, {
          signal: AbortSignal.timeout(30_000),
        });
        if (!audioRes.ok) continue;
        const buf = Buffer.from(await audioRes.arrayBuffer());
        if (buf.length < 32_768) continue;
        const filePath = path.join(tempDir, `${prefix}mp3`);
        fs.writeFileSync(filePath, buf);
        return { filePath, ext: 'mp3' };
      }

      // HLS playlist download & assembly in pure Node.js
      const m3u8Res = await fetch(resolvedJson.url, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!m3u8Res.ok) continue;
      const m3u8 = await m3u8Res.text();

      const segmentUrls: string[] = [];
      const initMatch = m3u8.match(/#EXT-X-MAP:URI="([^"]+)"/);
      if (initMatch?.[1]) {
        segmentUrls.push(initMatch[1]);
      }
      for (const line of m3u8.split(/\r?\n/)) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('http://') || trimmedLine.startsWith('https://')) {
          segmentUrls.push(trimmedLine);
        }
      }
      if (segmentUrls.length === 0) continue;

      const chunks: Buffer[] = new Array(segmentUrls.length);
      let cursor = 0;
      const concurrency = Math.min(6, segmentUrls.length);
      let failed = false;

      const worker = async () => {
        while (cursor < segmentUrls.length && !failed) {
          const i = cursor++;
          const segRes = await fetch(segmentUrls[i], {
            signal: AbortSignal.timeout(15_000),
          });
          if (!segRes.ok) {
            failed = true;
            return;
          }
          chunks[i] = Buffer.from(await segRes.arrayBuffer());
        }
      };

      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      if (failed || chunks.some((c) => !c)) continue;

      const combined = Buffer.concat(chunks);
      if (combined.length < 32_768) continue;

      const ext: 'mp3' | 'm4a' =
        Boolean(initMatch) || Boolean(tr.format?.mime_type?.includes('mp4'))
          ? 'm4a'
          : 'mp3';
      const filePath = path.join(tempDir, `${prefix}${ext}`);
      fs.writeFileSync(filePath, combined);
      return { filePath, ext, segmentUrls };
    } catch {
      // try next transcoding
    }
  }

  return null;
}

async function searchSourcesForQuery(
  query: string,
  targetTitle: string,
  targetArtist: string,
  targetDurationSec: number,
): Promise<CandidateMatch[]> {
  const candidates: CandidateMatch[] = [];

  const searchSoundCloud = async () => {
    try {
      const pureResults = await searchSoundCloudPureJs(
        query,
        targetTitle,
        targetArtist,
        targetDurationSec,
      );
      if (pureResults.length > 0) {
        candidates.push(...pureResults);
        return;
      }
    } catch {
      // fall through to optional yt-dlp
    }

    try {
      const bin = await ensureYtDlp();
      const { stdout } = await execFileAsync(
        bin,
        [
          '--dump-single-json',
          '--flat-playlist',
          '--ignore-errors',
          '--no-warnings',
          `scsearch6:${query}`,
        ],
        { maxBuffer: 16 * 1024 * 1024, timeout: 18_000 },
      );
      const parsed = JSON.parse(stdout) as {
        entries?: Array<{
          title?: string;
          uploader?: string;
          duration?: number;
          webpage_url?: string;
          url?: string;
        }>;
      };
      for (const entry of parsed.entries || []) {
        const entryUrl = entry?.webpage_url || entry?.url;
        if (!entryUrl) continue;
        const scDuration = Math.round(Number(entry.duration || 0));
        const score = scoreMatch(
          entry.title || '',
          entry.uploader || '',
          scDuration,
          targetTitle,
          targetArtist,
          targetDurationSec,
        );
        candidates.push({
          url: entryUrl,
          score,
          source: 'soundcloud-match',
        });
      }
    } catch {
      // yt-dlp may be unavailable in serverless environments
    }
  };

  const searchAudius = async () => {
    try {
      const audiusRes = await fetch(
        `https://discoveryprovider.audius.co/v1/tracks/search?query=${encodeURIComponent(query)}&app_name=soundpress`,
        { signal: AbortSignal.timeout(6000) },
      );
      if (audiusRes.ok) {
        const json = (await audiusRes.json()) as {
          data?: Array<{
            id?: string;
            title?: string;
            duration?: number;
            user?: { name?: string };
          }>;
        };
        for (const item of (json.data || []).slice(0, 5)) {
          if (!item.id) continue;
          const score = scoreMatch(
            item.title || '',
            item.user?.name || '',
            Number(item.duration || 0),
            targetTitle,
            targetArtist,
            targetDurationSec,
          );
          candidates.push({
            url: `https://discoveryprovider.audius.co/v1/tracks/${item.id}/stream?app_name=soundpress`,
            score,
            source: 'audius-match',
          });
        }
      }
    } catch {
      // ignore Audius errors
    }
  };

  await Promise.all([searchSoundCloud(), searchAudius()]);
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

async function findFallbackAudioCandidates(params: {
  title: string;
  artist: string;
  durationSec: number;
}): Promise<CandidateMatch[]> {
  const queries = buildSearchQueries(params.title, params.artist);
  const collected: CandidateMatch[] = [];

  for (const query of queries) {
    const candidates = await searchSourcesForQuery(
      query,
      params.title,
      params.artist,
      params.durationSec,
    );
    const viable = candidates.filter((c) => c.score >= -40);
    if (viable.length > 0) {
      collected.push(...viable);
      break;
    }
  }

  const seen = new Set<string>();
  const deduped = collected.filter((c) => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });

  const scTop = deduped
    .filter((c) => c.source === 'soundcloud-match')
    .slice(0, 3);
  const audiusTop = deduped
    .filter((c) => c.source === 'audius-match')
    .slice(0, 2);

  // Interleave SoundCloud and Audius so one provider never crowds out the other
  const merged: CandidateMatch[] = [];
  const maxLen = Math.max(scTop.length, audiusTop.length);
  for (let i = 0; i < maxLen; i++) {
    if (scTop[i]) merged.push(scTop[i]);
    if (audiusTop[i]) merged.push(audiusTop[i]);
  }
  return merged;
}

export interface PrepareDownloadInput {
  url: string;
  title: string;
  artist: string;
  album?: string;
  thumbnail?: string;
  durationSec?: number;
  previewUrl?: string;
  platform: MediaPlatform;
  mode: DownloadMode;
  format: MediaFormat;
  bitrate?: AudioBitrate;
  quality?: VideoQuality;
  cookiesText?: string;
}

export async function prepareMediaDownload(
  input: PrepareDownloadInput,
): Promise<PreparedFileResponse> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soundpress-job-'));
  const bitrate = String(input.bitrate || '320').replace(/k$/i, '') as AudioBitrate;
  const quality: VideoQuality = input.quality || '1080';
  const safeBase = sanitizeFilename(
    input.artist &&
      input.artist !== 'Unknown Artist' &&
      !input.title.toLowerCase().includes(input.artist.toLowerCase())
      ? `${input.artist} - ${input.title}`
      : input.title,
  );
  const finalFilename = `${safeBase}.${input.format}`;
  const finalPath = path.join(tempDir, finalFilename);

  let cookiesPath: string | undefined;
  if (input.cookiesText?.trim()) {
    cookiesPath = path.join(tempDir, 'cookies.txt');
    fs.writeFileSync(cookiesPath, input.cookiesText, 'utf8');
  }

  const registerFile = (
    filePath: string,
    resolvedSource: PreparedFileResponse['resolvedSource'],
    opts?: {
      filenameOverride?: string;
      mimeTypeOverride?: string;
      segmentUrls?: string[];
    },
  ): PreparedFileResponse => {
    const stat = fs.statSync(filePath);
    const fileId = crypto.randomUUID();
    const outFilename = opts?.filenameOverride || finalFilename;
    const outMime = opts?.mimeTypeOverride || getMimeType(input.format);

    if (isServerless) {
      if (stat.size <= SERVERLESS_MAX_INLINE_BYTES) {
        const buf = fs.readFileSync(filePath);
        const inlineDataUrl = `data:${outMime};base64,${buf.toString('base64')}`;
        fs.rmSync(tempDir, { recursive: true, force: true });
        return {
          fileId,
          filename: outFilename,
          mimeType: outMime,
          sizeBytes: stat.size,
          resolvedSource,
          resolvedTitle: input.title,
          downloadUrl: `/api/file/${fileId}`,
          inlineDataUrl,
        };
      }

      if (opts?.segmentUrls && opts.segmentUrls.length > 0) {
        const proxiedSegments = opts.segmentUrls.map(
          (u) => `/api/proxy-segment?token=${encodeURIComponent(signSegmentUrl(u))}`,
        );
        fs.rmSync(tempDir, { recursive: true, force: true });
        return {
          fileId,
          filename: outFilename,
          mimeType: outMime,
          sizeBytes: stat.size,
          resolvedSource,
          resolvedTitle: input.title,
          downloadUrl: `/api/file/${fileId}`,
          proxiedSegments,
        };
      }
    }

    storedFiles.set(fileId, {
      fileId,
      filePath,
      tempDir,
      filename: outFilename,
      mimeType: outMime,
      sizeBytes: stat.size,
      resolvedSource,
      createdAt: Date.now(),
    });
    return {
      fileId,
      filename: outFilename,
      mimeType: outMime,
      sizeBytes: stat.size,
      resolvedSource,
      resolvedTitle: input.title,
      downloadUrl: `/api/file/${fileId}`,
    };
  };

  const finalizeAudio = async (params: {
    rawInput: string;
    rawExt: 'mp3' | 'm4a';
    audioFormat: 'mp3' | 'm4a' | 'flac' | 'wav';
    coverFile?: string;
    resolvedSource: PreparedFileResponse['resolvedSource'];
    segmentUrls?: string[];
  }): Promise<PreparedFileResponse> => {
    const ffmpegBin = getFfmpegPath();
    if (ffmpegBin) {
      const ok = await transcodeAndTagAudio({
        inputFile: params.rawInput,
        outputFile: finalPath,
        format: params.audioFormat,
        bitrate,
        title: input.title,
        artist: input.artist,
        album: input.album,
        coverFile: params.coverFile,
      });
      if (ok && fs.existsSync(finalPath)) {
        const outSize = fs.statSync(finalPath).size;
        if (
          isServerless &&
          outSize > SERVERLESS_MAX_INLINE_BYTES &&
          (params.audioFormat === 'mp3' || params.audioFormat === 'm4a')
        ) {
          // Compress to 96k on serverless so full songs fit inside Vercel's inline payload budget
          const compactPath = path.join(tempDir, `${safeBase}-compact.${params.audioFormat}`);
          const compactOk = await transcodeAndTagAudio({
            inputFile: params.rawInput,
            outputFile: compactPath,
            format: params.audioFormat,
            bitrate: '96',
            title: input.title,
            artist: input.artist,
            album: input.album,
            coverFile: params.coverFile,
          });
          if (compactOk && fs.existsSync(compactPath)) {
            if (fs.statSync(compactPath).size <= SERVERLESS_MAX_INLINE_BYTES) {
              return registerFile(compactPath, params.resolvedSource);
            }
          }
        }

        if (
          isServerless &&
          outSize > SERVERLESS_MAX_INLINE_BYTES &&
          params.segmentUrls?.length
        ) {
          return registerFile(params.rawInput, params.resolvedSource, {
            filenameOverride: `${safeBase}.${params.rawExt}`,
            mimeTypeOverride: getMimeType(params.rawExt),
            segmentUrls: params.segmentUrls,
          });
        }

        return registerFile(finalPath, params.resolvedSource);
      }
    }

    // No ffmpeg binary or transcode skipped -> serve valid raw audio file directly
    return registerFile(params.rawInput, params.resolvedSource, {
      filenameOverride: `${safeBase}.${params.rawExt}`,
      mimeTypeOverride: getMimeType(params.rawExt),
      segmentUrls: params.segmentUrls,
    });
  };

  try {
    // Pure-JS direct download for SoundCloud URLs (no yt-dlp/python required)
    if (input.platform === 'soundcloud' && input.mode === 'audio') {
      const audioFormat = input.format as 'mp3' | 'm4a' | 'flac' | 'wav';
      const coverFile = await downloadCoverImage(input.thumbnail, tempDir);
      const scDirect = await downloadSoundCloudTrackPureJs(
        { url: input.url, score: 100, source: 'soundcloud-match' },
        tempDir,
        'sc-direct.',
      );
      if (scDirect) {
        return await finalizeAudio({
          rawInput: scDirect.filePath,
          rawExt: scDirect.ext,
          audioFormat,
          coverFile,
          resolvedSource: 'direct',
          segmentUrls: scDirect.segmentUrls,
        });
      }
    }

    // Optional direct yt-dlp path for non-Spotify URLs when runtime supports yt-dlp + python + ffmpeg
    const ffmpegForYtDlp = getFfmpegPath();
    const shouldTryYtDlp =
      input.platform !== 'spotify' &&
      (input.mode === 'video' || Boolean(cookiesPath) || !isServerless);

    if (shouldTryYtDlp && ffmpegForYtDlp) {
      try {
        const bin = await ensureYtDlp();
        const rawOutputTemplate = path.join(tempDir, 'raw.%(ext)s');
        const ytArgs: string[] = [
          '--ffmpeg-location',
          ffmpegForYtDlp,
          '--no-playlist',
          '--no-progress',
          '--max-filesize',
          '250M',
          '-o',
          rawOutputTemplate,
        ];

        if (cookiesPath) {
          ytArgs.push('--cookies', cookiesPath);
        }

        if (input.mode === 'video') {
          const formatSelector =
            input.format === 'webm'
              ? `bestvideo[height<=${quality}][ext=webm]+bestaudio[ext=webm]/bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`
              : `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`;
          ytArgs.push('-f', formatSelector, '--merge-output-format', input.format);
        } else {
          ytArgs.push(
            '-x',
            '--audio-format',
            input.format,
            '--audio-quality',
            `${bitrate}K`,
            '--add-metadata',
          );
          if (input.format === 'mp3' || input.format === 'm4a') {
            ytArgs.push('--embed-thumbnail');
          }
        }

        ytArgs.push(input.url);

        await execFileAsync(bin, ytArgs, {
          maxBuffer: 16 * 1024 * 1024,
          timeout: 180_000,
        });

        const files = fs.readdirSync(tempDir).filter((f) => f.startsWith('raw.'));
        const produced = files.find((f) => f.endsWith(`.${input.format}`)) || files[0];
        if (!produced) {
          throw new Error('No output file produced');
        }
        const producedPath = path.join(tempDir, produced);
        fs.renameSync(producedPath, finalPath);
        return registerFile(
          finalPath,
          input.platform === 'youtube' ? 'youtube-direct' : 'direct',
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isYouTubeBotCheck =
          input.platform === 'youtube' &&
          (errMsg.includes('Sign in to confirm') ||
            errMsg.includes('not a bot') ||
            errMsg.includes('LOGIN_REQUIRED'));

        if (isYouTubeBotCheck && input.mode === 'video') {
          throw new MediaEngineError(
            'YOUTUBE_COOKIES_REQUIRED',
            'YouTube blocked automated video extraction from this server IP. Attach your browser cookies.txt to download YouTube video directly, or switch to Audio mode.',
            403,
          );
        }

        if (!isYouTubeBotCheck && input.mode === 'video') {
          throw new MediaEngineError(
            'DOWNLOAD_FAILED',
            `Could not download video: ${errMsg.split('\n')[0]}`,
            400,
          );
        }
        // In audio mode, seamlessly fall through to pure-JS multi-source audio resolver below
      }
    }

    // Audio resolution path (Spotify tracks, SoundCloud fallback, OR YouTube Audio fallback)
    if (input.mode === 'video') {
      throw new MediaEngineError(
        'VIDEO_NOT_SUPPORTED',
        input.platform === 'youtube'
          ? 'Video download requires a Python/ffmpeg runtime or YouTube cookies. Switch to Audio mode (MP3/M4A) for instant cloud download.'
          : 'This source does not have downloadable video streams. Switch to Audio mode (MP3, M4A, FLAC, WAV).',
        400,
      );
    }

    const audioFormat = input.format as 'mp3' | 'm4a' | 'flac' | 'wav';
    const coverFile = await downloadCoverImage(input.thumbnail, tempDir);

    // If cookies were supplied and platform is spotify, try YouTube search via yt-dlp first!
    if (input.platform === 'spotify' && cookiesPath && ffmpegForYtDlp) {
      try {
        const bin = await ensureYtDlp();
        const searchQuery =
          buildSearchQueries(input.title, input.artist)[0] || input.title;
        const rawOut = path.join(tempDir, 'ytsp.%(ext)s');
        await execFileAsync(
          bin,
          [
            '--ffmpeg-location',
            ffmpegForYtDlp,
            '--cookies',
            cookiesPath,
            '-x',
            '--audio-format',
            audioFormat,
            '--audio-quality',
            `${bitrate}K`,
            '-o',
            rawOut,
            `ytsearch1:${searchQuery}`,
          ],
          { timeout: 120_000 },
        );
        const produced = fs.readdirSync(tempDir).find((f) => f.startsWith('ytsp.'));
        if (produced) {
          const producedExt = produced.endsWith('.m4a') ? 'm4a' : 'mp3';
          return await finalizeAudio({
            rawInput: path.join(tempDir, produced),
            rawExt: producedExt,
            audioFormat,
            coverFile,
            resolvedSource: 'youtube-direct',
          });
        }
      } catch {
        // continue to SoundCloud / Audius
      }
    }

    const candidates = await findFallbackAudioCandidates({
      title: input.title,
      artist: input.artist,
      durationSec: input.durationSec || 0,
    });

    for (let idx = 0; idx < candidates.length; idx++) {
      const candidate = candidates[idx];
      if (candidate.source === 'soundcloud-match') {
        try {
          const scPure = await downloadSoundCloudTrackPureJs(
            candidate,
            tempDir,
            `sc${idx}.`,
          );
          if (scPure) {
            return await finalizeAudio({
              rawInput: scPure.filePath,
              rawExt: scPure.ext,
              audioFormat,
              coverFile,
              resolvedSource: 'soundcloud-match',
              segmentUrls: scPure.segmentUrls,
            });
          }

          if (!isServerless) {
            const bin = await ensureYtDlp();
            const prefix = `scyt${idx}.`;
            const rawOut = path.join(tempDir, `scyt${idx}.%(ext)s`);
            await execFileAsync(
              bin,
              [
                ...(ffmpegForYtDlp ? ['--ffmpeg-location', ffmpegForYtDlp] : []),
                '--no-playlist',
                '--no-progress',
                '--max-filesize',
                '150M',
                '-o',
                rawOut,
                candidate.url,
              ],
              { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
            );
            const produced = fs.readdirSync(tempDir).find((f) => f.startsWith(prefix));
            if (produced) {
              const producedExt = produced.endsWith('.mp3') ? 'mp3' : 'm4a';
              return await finalizeAudio({
                rawInput: path.join(tempDir, produced),
                rawExt: producedExt,
                audioFormat,
                coverFile,
                resolvedSource: 'soundcloud-match',
              });
            }
          }
        } catch {
          // try next ranked candidate
        }
      }

      if (candidate.source === 'audius-match') {
        try {
          const streamRes = await fetch(candidate.url, {
            signal: AbortSignal.timeout(30_000),
          });
          const ctype = (streamRes.headers.get('content-type') || '').toLowerCase();
          if (streamRes.ok && !ctype.includes('text/html') && !ctype.includes('application/json')) {
            const buf = Buffer.from(await streamRes.arrayBuffer());
            if (buf.length < 32_768) continue;
            const rawInput = path.join(tempDir, `audius${idx}.mp3`);
            fs.writeFileSync(rawInput, buf);
            return await finalizeAudio({
              rawInput,
              rawExt: 'mp3',
              audioFormat,
              coverFile,
              resolvedSource: 'audius-match',
            });
          }
        } catch {
          // try next ranked candidate
        }
      }
    }

    if (input.previewUrl) {
      const previewRes = await fetch(input.previewUrl, {
        signal: AbortSignal.timeout(20_000),
      });
      if (previewRes.ok) {
        const rawPreview = path.join(tempDir, 'preview.mp3');
        fs.writeFileSync(rawPreview, Buffer.from(await previewRes.arrayBuffer()));
        return await finalizeAudio({
          rawInput: rawPreview,
          rawExt: 'mp3',
          audioFormat,
          coverFile,
          resolvedSource: 'spotify-preview',
        });
      }
    }

    throw new MediaEngineError(
      'NO_AUDIO_SOURCE_FOUND',
      `Could not find an unrestricted full audio stream for "${input.title}". If downloading from YouTube, attach browser cookies.txt to bypass datacenter IP limits.`,
      404,
    );
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (err instanceof MediaEngineError) throw err;
    throw new MediaEngineError(
      'DOWNLOAD_FAILED',
      err instanceof Error ? err.message : 'Download processing failed.',
      500,
    );
  }
}

export async function prepareZipArchive(params: {
  archiveTitle: string;
  tracks: PrepareDownloadInput[];
}): Promise<PreparedFileResponse> {
  if (!params.tracks.length) {
    throw new MediaEngineError('NO_TRACKS', 'No tracks selected for ZIP download.', 400);
  }
  if (params.tracks.length > 25) {
    throw new MediaEngineError(
      'TOO_MANY_TRACKS',
      'ZIP archive is limited to 25 tracks at once. For larger playlists, use "Download Selected Separately".',
      400,
    );
  }

  const zipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soundpress-zip-'));
  const safeArchiveName = `${sanitizeFilename(params.archiveTitle || 'playlist')}.zip`;
  const zipPath = path.join(zipDir, safeArchiveName);

  const preparedItems: Array<{ index: number; file: StoredFileEntry }> = [];
  const concurrency = 2;
  let cursor = 0;

  const worker = async () => {
    while (cursor < params.tracks.length) {
      const currentIdx = cursor++;
      const item = params.tracks[currentIdx];
      try {
        const res = await prepareMediaDownload(item);
        const stored = getStoredFile(res.fileId);
        if (stored) {
          preparedItems.push({ index: currentIdx + 1, file: stored });
        }
      } catch {
        // skip individual track failures so remaining tracks still archive
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, params.tracks.length) }, () => worker()),
  );

  if (preparedItems.length === 0) {
    fs.rmSync(zipDir, { recursive: true, force: true });
    throw new MediaEngineError(
      'ZIP_EMPTY',
      'None of the selected tracks could be downloaded. Try attaching YouTube cookies or switching to Audio mode.',
      400,
    );
  }

  preparedItems.sort((a, b) => a.index - b.index);

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 5 } });

    output.on('close', () => resolve());
    archive.on('error', (err) => reject(err));

    archive.pipe(output);
    const usedNames = new Set<string>();

    for (const item of preparedItems) {
      const prefix = String(item.index).padStart(2, '0');
      let entryName = `${prefix} - ${item.file.filename}`;
      if (usedNames.has(entryName)) {
        entryName = `${prefix} - ${item.file.fileId.slice(0, 4)} - ${item.file.filename}`;
      }
      usedNames.add(entryName);
      archive.file(item.file.filePath, { name: entryName });
    }

    void archive.finalize();
  });

  const stat = fs.statSync(zipPath);
  const fileId = crypto.randomUUID();

  if (isServerless) {
    if (stat.size <= SERVERLESS_MAX_INLINE_BYTES) {
      const buf = fs.readFileSync(zipPath);
      const inlineDataUrl = `data:application/zip;base64,${buf.toString('base64')}`;
      fs.rmSync(zipDir, { recursive: true, force: true });
      return {
        fileId,
        filename: safeArchiveName,
        mimeType: 'application/zip',
        sizeBytes: stat.size,
        resolvedSource: 'direct',
        downloadUrl: `/api/file/${fileId}`,
        inlineDataUrl,
      };
    }
    fs.rmSync(zipDir, { recursive: true, force: true });
    throw new MediaEngineError(
      'ZIP_TOO_LARGE',
      'ZIP exceeds serverless download size limit. Use "Download Selected Separately" to save each track directly.',
      413,
    );
  }

  storedFiles.set(fileId, {
    fileId,
    filePath: zipPath,
    tempDir: zipDir,
    filename: safeArchiveName,
    mimeType: 'application/zip',
    sizeBytes: stat.size,
    resolvedSource: 'direct',
    createdAt: Date.now(),
  });

  return {
    fileId,
    filename: safeArchiveName,
    mimeType: 'application/zip',
    sizeBytes: stat.size,
    resolvedSource: 'direct',
    downloadUrl: `/api/file/${fileId}`,
  };
}

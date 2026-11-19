import type { MediaPlatform, PreparedFileResponse } from '../types/media';

export function formatDuration(totalSeconds: number): string {
  if (!totalSeconds || totalSeconds <= 0) return '0:00';
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = Math.floor(totalSeconds % 60);
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatTotalDuration(totalSeconds: number): string {
  if (!totalSeconds || totalSeconds <= 0) return '—';
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  if (hrs > 0) {
    return `${hrs}h ${mins}m`;
  }
  return `${mins}m ${Math.floor(totalSeconds % 60)}s`;
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function platformLabel(platform: MediaPlatform): string {
  switch (platform) {
    case 'spotify':
      return 'Spotify';
    case 'youtube':
      return 'YouTube';
    case 'soundcloud':
      return 'SoundCloud';
    case 'bandcamp':
      return 'Bandcamp';
    case 'vimeo':
      return 'Vimeo';
    default:
      return 'Web Media';
  }
}

export function resolvedSourceLabel(
  source?: PreparedFileResponse['resolvedSource'],
): string {
  switch (source) {
    case 'youtube-direct':
      return 'YouTube stream';
    case 'soundcloud-match':
      return 'SoundCloud audio match';
    case 'audius-match':
      return 'Audius audio match';
    case 'spotify-preview':
      return '30s preview audio';
    case 'direct':
    default:
      return 'Direct stream';
  }
}

export async function triggerBrowserDownload(
  url: string,
  filename?: string,
): Promise<void> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Download stream failed');
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename || 'download';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 15_000);
  } catch {
    const anchor = document.createElement('a');
    anchor.href = url;
    if (filename) {
      anchor.download = filename;
    }
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  }
}

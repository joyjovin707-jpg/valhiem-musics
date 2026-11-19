import fs from 'node:fs';
import dotenv from 'dotenv';
import express from 'express';
import {
  MediaEngineError,
  ensureYtDlp,
  extractMediaInfo,
  getStoredFile,
  prepareMediaDownload,
  prepareZipArchive,
  verifySegmentToken,
  type PrepareDownloadInput,
} from './mediaEngine.ts';

dotenv.config();

export function createApiApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Warm up yt-dlp binary check in background when running in non-serverless environments
  if (!process.env.VERCEL && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
    void ensureYtDlp().catch(() => {});
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/extract', async (req, res) => {
    try {
      const { url, cookiesText } = req.body as {
        url?: string;
        cookiesText?: string;
      };
      const result = await extractMediaInfo(url || '', cookiesText);
      res.json(result);
    } catch (err) {
      if (err instanceof MediaEngineError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to extract media info.',
        code: 'INTERNAL_ERROR',
      });
    }
  });

  app.post('/api/prepare-download', async (req, res) => {
    try {
      const body = req.body as PrepareDownloadInput;
      if (!body?.url || !body?.title) {
        res.status(400).json({
          error: 'Missing required track URL or title.',
          code: 'INVALID_REQUEST',
        });
        return;
      }
      const prepared = await prepareMediaDownload(body);
      res.json(prepared);
    } catch (err) {
      if (err instanceof MediaEngineError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to prepare download.',
        code: 'INTERNAL_ERROR',
      });
    }
  });

  app.post('/api/prepare-zip', async (req, res) => {
    try {
      const { archiveTitle, tracks } = req.body as {
        archiveTitle?: string;
        tracks?: PrepareDownloadInput[];
      };
      const prepared = await prepareZipArchive({
        archiveTitle: archiveTitle || 'playlist',
        tracks: Array.isArray(tracks) ? tracks : [],
      });
      res.json(prepared);
    } catch (err) {
      if (err instanceof MediaEngineError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to build ZIP archive.',
        code: 'INTERNAL_ERROR',
      });
    }
  });

  app.get('/api/proxy-segment', async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const targetUrl = token ? verifySegmentToken(token) : null;
    if (!targetUrl) {
      res.status(403).json({ error: 'Invalid or expired media segment token.' });
      return;
    }

    try {
      const upstream = await fetch(targetUrl, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!upstream.ok) {
        res.status(upstream.status).json({ error: 'Segment fetch failed.' });
        return;
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader(
        'Content-Type',
        upstream.headers.get('content-type') || 'application/octet-stream',
      );
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(buf);
    } catch {
      res.status(502).json({ error: 'Upstream segment request timed out.' });
    }
  });

  app.get('/api/file/:fileId', (req, res) => {
    const entry = getStoredFile(req.params.fileId);
    if (!entry || !fs.existsSync(entry.filePath)) {
      res.status(404).json({
        error: 'Download link expired or file not found. Please prepare the track again.',
        code: 'FILE_NOT_FOUND',
      });
      return;
    }

    res.setHeader('Content-Type', entry.mimeType);
    res.setHeader('Content-Length', String(entry.sizeBytes));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(entry.filename)}`,
    );
    res.setHeader('X-Resolved-Source', entry.resolvedSource);

    const stream = fs.createReadStream(entry.filePath);
    stream.pipe(res);
  });

  return app;
}

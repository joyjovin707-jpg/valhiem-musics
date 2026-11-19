import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import {
  MediaEngineError,
  ensureYtDlp,
  extractMediaInfo,
  getStoredFile,
  prepareMediaDownload,
  prepareZipArchive,
  type PrepareDownloadInput,
} from './server/mediaEngine.ts';

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);
  const isProd = process.env.NODE_ENV === 'production';

  app.use(express.json({ limit: '2mb' }));

  // Warm up yt-dlp binary check in background
  void ensureYtDlp().catch(() => {});

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

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Soundpress server listening on http://0.0.0.0:${PORT}`);
  });
}

void startServer();

const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');
ffmpeg.setFfprobePath('/usr/bin/ffprobe');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 240000;       // 4 minutes max per file
const FILE_TTL_MS = 30 * 60 * 1000;     // 30 min — generous so polling never loses the file
const JOB_TTL_MS = 30 * 60 * 1000;

const UPLOAD_DIR = path.join(__dirname, 'tmp', 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'tmp', 'outputs');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// In-memory job store. jobId -> { status, downloadUrl, filename, error, createdAt, progress }
const jobs = new Map();

// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  [UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
    try {
      fs.readdirSync(dir).forEach(f => {
        const fp = path.join(dir, f);
        try {
          const stat = fs.statSync(fp);
          if (now - stat.mtimeMs > FILE_TTL_MS) fs.unlinkSync(fp);
        } catch (e) {}
      });
    } catch (e) {}
  });
  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}, 5 * 60 * 1000);

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname || '.bin'))
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: 50 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(mp3|wav|ogg|flac|m4a|aac|webm|opus|wma|mp4|mkv)$/i;
    if (allowed.test(file.originalname) || (file.mimetype && file.mimetype.startsWith('audio/'))) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.originalname}. Allowed: mp3, wav, ogg, flac, m4a, aac, opus`));
    }
  }
});

function uploadSingle(req, res, next) {
  upload.single('audio')(req, res, (err) => {
    if (err) return handleUploadError(err, res);
    next();
  });
}
function handleUploadError(err, res) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File too large. Max size is ${MAX_FILE_SIZE / 1024 / 1024}MB.` });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Too many files. Max is 50 per request.' });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  return res.status(400).json({ error: err.message || 'Upload failed' });
}

function safeContentDisposition(filename) {
  const fallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function makeDownloadName(originalName, spd, pch, fmt) {
  const orig = path.parse(originalName || 'audio').name;
  const suffix = [];
  if (spd !== 1.0) suffix.push(`${spd}x`);
  if (pch !== 0) suffix.push(`${pch > 0 ? '+' : ''}${pch}st`);
  return orig + (suffix.length ? '_' + suffix.join('_') : '') + '.' + fmt;
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ffmpeg: true, queueLength: jobs.size });
});

// Submit a job — returns immediately so the gateway never times out
app.post('/api/process', uploadSingle, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

  const { speed, pitch, format, volume } = req.body;
  const spd = Math.max(0.25, Math.min(4.0, parseFloat(speed) || 1.0));
  const pch = Math.max(-12, Math.min(12, parseInt(pitch) || 0));
  const vol = Math.max(0, Math.min(2.0, parseFloat(volume) || 1.0));
  const fmt = ['mp3', 'wav', 'ogg'].includes(format) ? format : 'mp3';

  const jobId = uuidv4();
  const outputName = uuidv4() + '.' + fmt;
  const outputPath = path.join(OUTPUT_DIR, outputName);
  const downloadName = makeDownloadName(req.file.originalname, spd, pch, fmt);

  jobs.set(jobId, {
    status: 'processing',
    createdAt: Date.now(),
    progress: 0,
    downloadUrl: null,
    filename: downloadName,
    error: null
  });

  // Respond immediately
  res.json({ success: true, jobId, statusUrl: `/api/status/${jobId}` });

  // Process in the background
  const inputPath = req.file.path;
  processAudio(inputPath, outputPath, spd, pch, vol, fmt)
    .then(() => {
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'done';
        job.progress = 100;
        job.downloadUrl = `/api/download/${outputName}`;
      }
    })
    .catch((err) => {
      console.error('Background processing error:', err.message);
      let msg = err.message || 'Audio processing failed';
      if (/Invalid data|moov atom not found|does not contain any stream/i.test(msg)) {
        msg = 'This file appears to be corrupted or not a valid audio file.';
      } else if (/timeout/i.test(msg)) {
        msg = 'Processing took too long. Try a smaller or shorter file.';
      } else if (/codec/i.test(msg)) {
        msg = 'Unsupported audio codec. Try converting to MP3 first.';
      }
      const job = jobs.get(jobId);
      if (job) { job.status = 'failed'; job.error = msg; }
    })
    .finally(() => {
      try { fs.unlinkSync(inputPath); } catch (e) {}
    });
});

// Poll job status — quick request, no gateway timeout risk
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });

  const response = { status: job.status, progress: job.progress };
  if (job.status === 'done') {
    response.downloadUrl = job.downloadUrl;
    response.filename = job.filename;
  } else if (job.status === 'failed') {
    response.error = job.error;
  }
  res.json(response);
});

app.get('/api/download/:filename', (req, res) => {
  const safeName = path.basename(req.params.filename);
  const filePath = path.join(OUTPUT_DIR, safeName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found or expired. Please re-export.' });
  }

  const ext = path.extname(safeName).slice(1).toLowerCase();
  const mimeMap = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg' };
  const downloadName = (req.query.name && String(req.query.name).slice(0, 200)) || safeName;

  res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', safeContentDisposition(downloadName));
  res.setHeader('Cache-Control', 'no-store');

  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: 'Download failed' });
    }
  });
});

function probeAudio(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(new Error('Could not read audio metadata. File may be corrupted.'));
      const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
      if (!audioStream) return reject(new Error('No audio stream found in file.'));
      resolve({
        sampleRate: parseInt(audioStream.sample_rate) || 44100,
        channels: audioStream.channels || 2,
        duration: parseFloat(metadata.format.duration) || 0
      });
    });
  });
}

async function processAudio(inputPath, outputPath, speed, pitchSemitones, volume, format) {
  const info = await probeAudio(inputPath);
  const outputRate = 44100;

  return new Promise((resolve, reject) => {
    const filters = [];
    if (info.sampleRate !== outputRate) filters.push(`aresample=${outputRate}`);
    if (pitchSemitones !== 0) {
      const pitchFactor = Math.pow(2, pitchSemitones / 12);
      filters.push(`asetrate=${outputRate}*${pitchFactor.toFixed(6)}`);
      filters.push(`aresample=${outputRate}`);
    }
    if (speed !== 1.0) {
      let remaining = speed;
      while (remaining > 2.0) { filters.push('atempo=2.0'); remaining /= 2.0; }
      while (remaining < 0.5) { filters.push('atempo=0.5'); remaining /= 0.5; }
      filters.push(`atempo=${remaining.toFixed(6)}`);
    }
    if (volume !== 1.0) filters.push(`volume=${volume.toFixed(2)}`);

    let cmd = ffmpeg(inputPath)
      .audioChannels(2)
      .audioFrequency(outputRate)
      .outputOptions(['-threads 0']);

    if (filters.length > 0) cmd = cmd.audioFilter(filters);

    switch (format) {
      case 'mp3': cmd = cmd.audioCodec('libmp3lame').audioBitrate('192k'); break;
      case 'ogg': cmd = cmd.audioCodec('libvorbis').audioBitrate('192k'); break;
      case 'wav': cmd = cmd.audioCodec('pcm_s16le'); break;
    }

    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        try { cmd.kill('SIGKILL'); } catch (e) {}
        reject(new Error('Processing timeout'));
      }
    }, FFMPEG_TIMEOUT_MS);

    cmd.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    }).on('end', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    }).save(outputPath);
  });
}

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Nomen Audio Studio running on port ${PORT}\n`);
});

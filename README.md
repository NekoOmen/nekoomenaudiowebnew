# ♫ Nomen Audio Studio

Roblox Audio Processor — Server-side FFmpeg with independent pitch & speed control.

## Deploy to Koyeb (Free, No Credit Card)

1. Push this repo to **GitHub**
2. Go to [koyeb.com](https://koyeb.com) → Sign up with GitHub
3. **Create Service** → **Web Service** → Select your repo
4. It auto-detects the Dockerfile → Pick **Free** CPU
5. Set port to `3000` if asked
6. Deploy → get your free `*.koyeb.app` URL

## Files

```
├── Dockerfile          ← Docker config (installs FFmpeg + Node)
├── server.js           ← Express API + FFmpeg processing
├── package.json        ← Dependencies (no ffmpeg-static needed)
├── public/
│   └── index.html      ← Frontend UI
├── .gitignore
└── .dockerignore
```

## How It Works

- **Speed** (tempo) changed independently via `atempo` filter
- **Pitch** shifted independently via `asetrate` + `aresample`
- Output: MP3 192kbps / OGG Vorbis / WAV 16bit
- All processing server-side with real FFmpeg

## Credits

Built by **Neko_Omen** — [YouTube](https://youtube.com/@Neko_Omen)

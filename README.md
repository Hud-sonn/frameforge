```mermaid
flowchart TD
    U[User Uploads<br/>Video or Image] --> V{Video or Image?}

    %% ─── Frame Extraction Flow ───
    V -->|Video| F1[Upload & Probe<br/>ffprobe extracts metadata<br/>duration, resolution, fps]
    F1 --> F2[Trim & Settings<br/>• Timeline in/out points<br/>• FPS selector (24/30/60)<br/>• Format (AVIF/JPEG/WebP/PNG)<br/>• Quality preset (CRF/Q:v)]
    F2 --> F3[Quality Preview<br/>4 sample frames × 3 quality levels<br/>side-by-side comparison grid]
    F3 --> F4[Full Encode<br/>ffmpeg extracts PNG frames<br/>then encodes to target format<br/>with progress polling]
    F4 --> F5[Results<br/>• Size comparison bar<br/>• Download .zip of frames<br/>• Copy manifest.json<br/>• Run another]

    %% ─── Image Conversion Flow ───
    V -->|Image| I1[Upload Image<br/>PNG / JPEG / WebP / AVIF]
    I1 --> I2[Configure<br/>• Target format<br/>• Quality level<br/>• Optional resize]
    I2 --> I3[Convert<br/>ffmpeg transcodes image<br/>with selected settings]
    I3 --> I4[Download<br/>preview & download<br/>converted image]

    %% ─── Job History ───
    F5 --> H[Job History<br/>• Past jobs listed<br/>• Re-run with new settings<br/>• Reuses cached PNGs<br/>• Download previous results]

    style U fill:#131110,stroke:#C4A35A,color:#E8E0D5,stroke-width:2px
    style V fill:#181512,stroke:#4a4540,color:#E8E0D5
    style F1 fill:#181512,stroke:#4a4540,color:#E8E0D5
    style F2 fill:#181512,stroke:#4a4540,color:#E8E0D5
    style F3 fill:#181512,stroke:#C4A35A,color:#E8E0D5
    style F4 fill:#181512,stroke:#4a4540,color:#E8E0D5
    style F5 fill:#181512,stroke:#4a4540,color:#E8E0D5
    style I1 fill:#181512,stroke:#4a4540,color:#E8E0D5
    style I2 fill:#181512,stroke:#4a4540,color:#E8E0D5
    style I3 fill:#181512,stroke:#C4A35A,color:#E8E0D5
    style I4 fill:#181512,stroke:#4a4540,color:#E8E0D5
    style H fill:#131110,stroke:#4a4540,color:#E8E0D5
```

# FrameForge

Local-first frame extraction & compression tool for scroll-scrubbed animations, plus a standalone image converter. Built with FastAPI (Python) + React + ffmpeg under the Solus visual identity.

## Quick Start

```bash
./start.sh
```

Open http://localhost:8000

## Features

### Frame Extraction
Upload any video, trim the range, choose output format and quality, then download a zip of compressed frames with a manifest.json for scroll-scrub components.

- Upload (MP4 / MOV / MKV / WEBM) via drag-drop or file picker
- Trim with interactive timeline range sliders
- Live frame count preview as you adjust fps/trim
- Quality preview grid: 4 sample frames × 3 quality levels side-by-side
- Output formats: **AVIF** (best compression), **JPEG** (universal), **WebP** (balanced), **PNG** (lossless)
- Progress polling during encode with circular progress ring
- Download .zip of frames + manifest.json
- Job history with re-run (reuses cached PNG intermediates)

### Image Converter
Upload any image and convert to a different format with quality and resize control.

- Input: PNG / JPEG / WebP / AVIF
- Output: AVIF / JPEG / WebP / PNG
- Quality presets per format
- Optional resize (original / 1920 / 1280 / 800 / 400 px wide)
- Preview converted image inline, download directly

### Manifest Schema

Written as `manifest.json` alongside output frames — any scroll-scrub component can read this on mount:

```json
{
  "version": 1,
  "sourceFile": "katana-intro.mp4",
  "fps": 24,
  "frameCount": 101,
  "format": "avif",
  "quality": { "crf": 30 },
  "width": 1920,
  "height": 1080,
  "filenamePattern": "frame_%04d.avif",
  "totalSizeBytes": 10485760,
  "sourceSizeBytes": 5659047
}
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | FastAPI (Python 3.12) |
| Frontend | React + Vite |
| Processing | ffmpeg / ffprobe |
| Storage | Flat JSON (`~/.frameforge/`) |
| Theming | Solus — black, ember-gold (#C4A35A), bone (#E8E0D5) |

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | ffmpeg/ffprobe availability check |
| POST | `/api/upload` | Upload video, returns metadata |
| POST | `/api/preview` | Generate quality-comparison preview grid |
| POST | `/api/encode` | Run full extraction + encode pipeline |
| POST | `/api/convert-image` | Convert single image to target format |
| GET | `/api/jobs` | List job history |
| GET | `/api/jobs/{id}/status` | Poll job progress (used during encode) |
| GET | `/api/jobs/{id}/manifest` | Fetch completed job's manifest |
| GET | `/api/jobs/{id}/download` | Download output as zip |
| POST | `/api/jobs/{id}/rerun` | Re-run encode with new settings (reuses cached PNGs) |

## Project Structure

```
frameforge/
├── backend/
│   ├── __init__.py
│   ├── app.py              # FastAPI app, static file serving
│   ├── config.py            # Paths, data dirs
│   ├── ffmpeg_utils.py      # ffmpeg/ffprobe wrappers
│   ├── jobs.py              # Job history manager
│   └── routes.py            # All API routes
├── frontend/
│   ├── src/
│   │   ├── api.js           # API client
│   │   ├── App.jsx          # Main React app
│   │   ├── App.css          # Solus theme CSS
│   │   └── main.jsx         # Entry point
│   ├── dist/                # Built frontend (served by backend)
│   └── vite.config.js
├── start.sh                 # One-command launcher
├── pyproject.toml
└── frameforge-ui.html       # Original design mockup
```

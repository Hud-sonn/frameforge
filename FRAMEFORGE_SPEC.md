# FrameForge — Local Frame Extraction & Compression Tool

A local-first tool for turning source videos into optimized image-sequence frames (PNG/AVIF/JPEG/WebP) for scroll-scrubbed animations, plus a manifest file that scrub components can consume directly. Built to be reused across projects (Bekky portfolio now, future scroll-scrub work later).

**Stack:** FastAPI backend (Python), lightweight frontend (React or plain HTML/JS — recommend React + Tailwind to match existing project conventions), ffmpeg as the processing engine, SQLite or a flat JSON index for job history. Runs locally only — no cloud, no queue, no auth.

**Theming:** Solus / Hudson Dev visual identity — pure black background, burnt ember-gold accent (`#C4A35A`-family, matching Breathe's amber-gold), bone/off-white text (`#E8E0D5`), Space Grotesk or similar for headings if available, otherwise system-ui fallback. Should feel consistent with other Solus-branded tools, not like a generic dev utility.

---

## 1. Prerequisites & environment check

On startup, the backend should verify `ffmpeg` is installed and on PATH (`ffmpeg -version` subprocess check). If missing, surface a clear error in the UI with install instructions rather than failing silently on first job. Also check for `libaom` / AV1 encoder support in the local ffmpeg build if AVIF output is selected (`ffmpeg -encoders | grep av1`) — not all ffmpeg builds include it, and this is a common failure point worth catching early.

---

## 2. Core pipeline (what happens under the hood)

Three-stage pipeline for every job:

1. **Extract** — source video → lossless intermediate PNG frames at chosen fps and trim range.
   ```
   ffmpeg -i {input} -ss {trim_start} -to {trim_end} -vf fps={fps} {tmp_dir}/frame_%04d.png
   ```
   Always extract to PNG first regardless of final target format — never re-compress an already-compressed format, this compounds quality loss.

2. **Preview** (optional, before committing to full batch) — pick 3-4 representative frame indices (evenly spaced across the trimmed range, e.g. 10%, 40%, 70%, 90% of frame count), re-encode each at 3 quality presets in the target format, return all for side-by-side comparison.

3. **Encode** — full frame set, PNG → target format at chosen quality setting:
   - AVIF: `ffmpeg -i frame_%04d.png -c:v libaom-av1 -crf {crf} -still-picture 1 frame_%04d.avif` (or shell out to `avifenc` per-frame if available — often faster than ffmpeg's AV1 still-image path)
   - JPEG: `ffmpeg -i frame_%04d.png -q:v {qv} frame_%04d.jpg`
   - WebP: `ffmpeg -i frame_%04d.png -quality {quality} frame_%04d.webp`
   - PNG (no re-encode needed, already in target format — just copy/move from tmp)

4. **Manifest write** — JSON file alongside the output frames (see schema in section 5).

5. **Cleanup** — delete tmp PNG intermediates after encode completes, unless user explicitly requests keeping them (useful for iterating on quality settings without re-extracting from video each time — see section 6 caching note).

---

## 3. Quality preview feature

**Endpoint:** `POST /api/preview`
**Input:** video file (or reference to already-uploaded temp file), fps, trim range, target format
**Output:** for each of 3-4 sample frame positions, 3 encoded versions at different quality levels (e.g. crf 24 / 30 / 36 for AVIF, q:v 2 / 5 / 8 for JPEG), returned as base64-encoded images or short-lived temp URLs the frontend can display immediately.

**UI:** a grid — rows = sample frame positions, columns = quality levels — each cell shows the image plus its file size. User clicks their preferred column (or mixes across rows if quality varies scene-to-scene, though usually one setting is picked for the whole batch). Selecting a quality level here pre-fills the crf/q:v value for the full encode step.

This step should be fast (seconds, not the full batch time) since it's only processing ~9-12 frames total, not the whole sequence. Purpose: replace blind guessing with a quick visual decision, and build intuition over repeated use for what crf/quality values mean for a given kind of footage.

---

## 4. Trim & fps controls

**UI:** video preview player with a timeline scrubber supporting in/out point selection (drag handles on a range slider under the video, or two draggable markers over a timeline). Default in/out to full video length.

**fps control:** numeric input or preset buttons (24 / 30 / 60), defaulting to 24 (recommended for scroll-scrub use — matches how these are actually consumed; scroll velocity doesn't resolve 60fps of distinct frames, and lower fps means significantly less total asset weight for the same perceived smoothness).

Show a live-computed frame count (`(trim_end - trim_start) * fps`) as the user adjusts either control, so they see the tradeoff before running anything.

---

## 5. Manifest schema

Written as `manifest.json` in the output directory alongside the frame files:

```json
{
  "version": 1,
  "sourceFile": "katana-intro.mp4",
  "createdAt": "2026-07-19T12:00:00Z",
  "fps": 24,
  "frameCount": 101,
  "trimStart": 0.0,
  "trimEnd": 4.2,
  "format": "avif",
  "quality": { "crf": 30 },
  "width": 1920,
  "height": 1080,
  "basePath": "/frames/katana-intro/",
  "filenamePattern": "frame_%04d.avif",
  "totalSizeBytes": 10485760,
  "sourceSizeBytes": 5659047,
  "fallbackFormat": "jpeg",
  "fallbackFilenamePattern": "frame_%04d.jpg"
}
```

Any scroll-scrub component (in this project or future ones) reads this once on mount, knows the exact frame count/naming/dimensions without hardcoding, and can preload accordingly. `fallbackFormat`/`fallbackFilenamePattern` are optional — populated only if the user chose to export a second format as a browser-compatibility fallback (see section 7).

---

## 6. Job history & local caching

Keep a simple local index (flat JSON file at `~/.frameforge/jobs.json` or a SQLite table — flat JSON is sufficient for a personal single-user tool, avoid over-engineering) recording: job ID, source filename, timestamp, settings used, output path, manifest reference.

**UI:** a sidebar or tab listing past jobs, each with a "re-run with new settings" action that reuses the already-extracted PNG intermediates if still present on disk (skips the extraction step entirely, jumps straight to preview/encode) — this is what makes iterating on quality genuinely fast instead of re-running ffmpeg extraction every time. Tmp PNGs should have a retention setting (e.g. keep for 24h or until explicitly cleared) rather than being deleted immediately after every job, specifically to support this re-run flow.

---

## 7. Format & fallback support

Support as encode targets: **AVIF** (primary recommendation — best compression), **JPEG** (universal fallback, fast decode), **WebP** (middle ground, good browser support), **PNG** (lossless passthrough, for cases needing transparency or zero quality loss).

**UI:** format selector with a short inline note on tradeoffs (e.g. "AVIF: smallest size, needs fallback for older Safari" / "JPEG: universal support, larger files" / "WebP: good balance, wide support"). Optional checkbox: "also export JPEG fallback" — runs a second lightweight encode pass reusing the same PNG intermediates, populates the manifest's `fallbackFormat` fields.

---

## 8. API endpoints summary

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/upload` | Upload source video, returns a job/session ID and video metadata (duration, resolution, fps) |
| `POST` | `/api/preview` | Generate quality-comparison preview grid for a given fps/trim/format selection |
| `POST` | `/api/encode` | Run full extraction + encode pipeline with confirmed settings, returns job ID |
| `GET` | `/api/jobs/{job_id}/status` | Poll or websocket-stream progress during encode (frame N of total) |
| `GET` | `/api/jobs` | List job history |
| `GET` | `/api/jobs/{job_id}/manifest` | Fetch a completed job's manifest.json |
| `POST` | `/api/jobs/{job_id}/rerun` | Re-run encode step only, reusing cached PNG intermediates, with new quality/format settings |
| `GET` | `/api/jobs/{job_id}/download` | Download output as a zip |

Progress reporting: ffmpeg writes frame-by-frame progress to stderr when given `-progress` flag pointed at a pipe/file — parse that and push updates via a simple polling endpoint or websocket, whichever is simpler to wire against the frontend's stack.

---

## 9. UI screens

1. **Upload / New Job** — drag-drop or file picker, shows video metadata once loaded
2. **Trim & Settings** — timeline scrubber for in/out points, fps control, format selector
3. **Quality Preview** — the comparison grid from section 3, with a "confirm and run full batch" action
4. **Progress** — live progress bar during full encode (frame count, elapsed/estimated time)
5. **Results** — output summary (total size, frame count, before/after size comparison vs. source video), download button, "copy manifest path" for pasting into project code
6. **Job History** — list of past jobs with re-run action

Keep navigation simple — this is a personal tool for a focused workflow, not a multi-user product. A single-page flow (upload → configure → preview → run → results) with history as a secondary tab is enough; avoid over-building navigation chrome.

---

## 10. Explicit non-goals for v1

Do not build: multi-user auth, cloud storage/upload, batch queueing of multiple videos at once, video editing beyond trim (no filters/color correction), mobile-responsive UI (this is a local dev tool run on your machine). Keep scope tight to avoid stalling on a personal tool that only needs to work well for one user on one machine.

---

## 11. Suggested build order (for opencode)

1. FastAPI skeleton + ffmpeg availability check on startup
2. `/api/upload` + video metadata extraction (ffprobe)
3. Extraction pipeline (`/api/encode` minus preview, hardcode one format first to prove the pipeline end to end)
4. Manifest writing
5. Basic frontend: upload → trim/settings → run → results (no preview grid yet, no history yet)
6. Add quality preview endpoint + UI grid
7. Add job history + re-run-with-cached-frames flow
8. Add remaining format options (WebP, PNG passthrough) + fallback export checkbox
9. Theming pass (Solus palette, typography)
10. Test against the actual katana-intro.mp4 source from the Bekky project as a real-world validation case

This order gets a working end-to-end tool fast (steps 1-5), then layers on the higher-value UX features (preview, history) before polish (theming, extra formats) — avoids getting stuck perfecting one piece before the whole pipeline is proven.

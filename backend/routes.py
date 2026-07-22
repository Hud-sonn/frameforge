from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import shutil
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .config import OUTPUT_DIR
from .ffmpeg_utils import (
    FFMPEG,
    _avif_enc_flags,
    _run_ffmpeg,
    check_ffmpeg,
    compress_video,
    convert_image,
    encode_frames,
    extract_frame_at_timestamp,
    extract_frames,
    probe_video,
    remove_background_chromakey,
    resolve_source_extension,
    segment_frame_ai,
    write_manifest,
)

_AV1_ENCODER_AVAILABLE: bool | None = None


async def _ensure_av1() -> None:
    """Lazily check and cache AV1 encoder availability. Raises if unavailable."""
    global _AV1_ENCODER_AVAILABLE
    if _AV1_ENCODER_AVAILABLE is None:
        health = await check_ffmpeg()
        _AV1_ENCODER_AVAILABLE = bool(health.get("av1_encoder"))
    if not _AV1_ENCODER_AVAILABLE:
        raise HTTPException(400, "AV1 encoder (libaom-av1) not found in ffmpeg")
from .jobs import JobsManager

logger = logging.getLogger(__name__)

router = APIRouter()
jobs = JobsManager()

def _clean_progress(job_id: str) -> None:
    _progress.pop(job_id, None)

jobs.on_trim.append(_clean_progress)

# In-memory progress tracking
_progress: dict[str, dict] = {}

# Max upload size: 4 GB
MAX_UPLOAD_SIZE = 4 * 1024 * 1024 * 1024


@router.get("/health")
async def health():
    checks = await check_ffmpeg()
    return {"status": "ok" if checks["ffmpeg"] and checks["ffprobe"] else "error", "ffmpeg": checks}


@router.post("/upload")
async def upload(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(400, "No filename provided")

    safe_name = Path(file.filename).name
    dest_dir = Path.home() / ".frameforge" / "uploads"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / safe_name

    total_read = 0
    with open(dest, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            total_read += len(chunk)
            if total_read > MAX_UPLOAD_SIZE:
                dest.unlink(missing_ok=True)
                raise HTTPException(413, f"File too large — max {MAX_UPLOAD_SIZE // (1024**3)}GB")
            f.write(chunk)

    try:
        meta = await probe_video(str(dest))
    except Exception as e:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, f"Failed to probe video: {e}")

    job = await jobs.create(
        source_filename=file.filename,
        source_path=str(dest),
        source_size=meta["size_bytes"],
    )
    await jobs.update(
        job.id,
        width=meta["width"],
        height=meta["height"],
        duration=meta["duration"],
        fps=meta["fps"],
        codec=meta["codec"],
        trim_end=meta["duration"],
    )

    # Extract a real thumbnail frame
    thumb = None
    if meta["duration"] > 0:
        thumb_path = Path(job.tmp_dir) / "thumb.jpg"
        ok = await extract_frame_at_timestamp(str(dest), str(thumb_path), meta["duration"] * 0.1)
        if ok and thumb_path.exists():
            thumb = base64.b64encode(thumb_path.read_bytes()).decode()

    return {
        "jobId": job.id,
        "filename": file.filename,
        "metadata": meta,
        "thumbnail": thumb,
    }


@router.post("/compress")
async def compress(
    file: UploadFile = File(...),
    format: str = Form(""),        # empty string = same as source
    crf: int = Form(23),
    preset: str = Form("medium"),
    keepAudio: str = Form("true"),
):
    if not file.filename:
        raise HTTPException(400, "No filename provided")

    safe_name = Path(file.filename).name
    dest_dir = Path.home() / ".frameforge" / "uploads"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"compress_{os.urandom(4).hex()}_{safe_name}"

    total_read = 0
    with open(dest, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            total_read += len(chunk)
            if total_read > MAX_UPLOAD_SIZE:
                dest.unlink(missing_ok=True)
                raise HTTPException(413, f"File too large — max {MAX_UPLOAD_SIZE // (1024**3)}GB")
            f.write(chunk)

    try:
        meta = await probe_video(str(dest))
    except Exception as e:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, f"Failed to probe video: {e}")

    # Create a proper job entry in JobsManager for progress polling
    source_ext = resolve_source_extension(file.filename, meta.get("format_name", ""))
    job = await jobs.create(source_filename=file.filename, source_path=str(dest), source_size=meta["size_bytes"])
    await jobs.update(
        job.id,
        status="compressing",
        width=meta["width"],
        height=meta["height"],
        duration=meta["duration"],
        fps=meta["fps"],
        codec=meta["codec"],
        format=format.strip() or meta.get("format_name", ""),
    )

    _progress[job.id] = {"stage": "compressing", "current": 0, "total": 100}

    async def _compress_progress(c, t):
        _progress.update({job.id: {"stage": "compressing", "current": c, "total": t}})

    async def _run_compress():
        try:
            out_path, out_size = await compress_video(
                source_path=str(dest),
                output_path=str(Path(job.tmp_dir) / "compressed"),
                target_format=format.strip() or None,
                crf=crf,
                preset=preset,
                keep_audio=keepAudio.lower() == "true",
                source_extension=source_ext,
                source_codec=meta.get("codec", "h264"),
                progress_callback=_compress_progress,
            )
            out_ext = Path(out_path).suffix.lstrip(".")
            await jobs.update(
                job.id,
                status="done",
                total_size_bytes=out_size,
                output_path=str(Path(job.tmp_dir) / "compressed"),
            )
            _progress[job.id] = {"stage": "done", "current": 100, "total": 100}
        except Exception as e:
            await jobs.update(job.id, status="failed")
            logger.error("Compression failed: %s", e)
        finally:
            Path(dest).unlink(missing_ok=True)

    asyncio.create_task(_run_compress())

    return {
        "jobId": job.id,
        "status": "compressing",
        "sourceSizeBytes": meta.get("size_bytes", 0),
        "sourceFilename": file.filename,
    }


@router.get("/jobs/{job_id}/compressed")
async def compressed_download(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.status != "done":
        raise HTTPException(400, "Compression not yet complete")
    tmp_dir = Path(job.tmp_dir)
    candidates = list(tmp_dir.glob("compressed.*"))
    if not candidates:
        raise HTTPException(404, "Compressed output not found")
    out_path = str(candidates[0])
    out_name = Path(out_path).name
    return FileResponse(
        out_path,
        media_type="application/octet-stream",
        filename=out_name,
        headers={"Content-Disposition": f"attachment; filename={out_name}"},
    )


@router.get("/jobs")
async def list_jobs():
    return [j.to_dict() for j in jobs.list_all()]


@router.get("/jobs/{job_id}/status")
async def job_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return {**job.to_dict(), "progress": _progress.get(job_id, {})}


@router.get("/jobs/{job_id}/manifest")
async def job_manifest(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if not job.manifest_path or not Path(job.manifest_path).exists():
        raise HTTPException(404, "Manifest not found")
    return json.loads(Path(job.manifest_path).read_text())


def _cleanup_temp(path: str) -> None:
    try:
        Path(path).unlink(missing_ok=True)
    except Exception:
        pass


@router.get("/jobs/{job_id}/download")
async def job_download(job_id: str, bg: BackgroundTasks):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if not job.output_path or not Path(job.output_path).exists():
        raise HTTPException(404, "Output not found")

    tmp = tempfile.NamedTemporaryFile(delete=False)
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
            output_dir = Path(job.output_path)
            for f in sorted(output_dir.iterdir()):
                if f.is_file():
                    zf.write(f, f.name)
            manifest = output_dir / "manifest.json"
            if manifest.exists():
                zf.write(manifest, "manifest.json")
        tmp.close()

        bg.add_task(_cleanup_temp, tmp.name)

        filename = f"{job.source_filename.rsplit('.', 1)[0]}-frames.zip"
        return FileResponse(
            tmp.name,
            media_type="application/zip",
            filename=filename,
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )
    except Exception:
        Path(tmp.name).unlink(missing_ok=True)
        raise


@router.post("/preview")
async def preview(
    jobId: str = Form(...),
    fps: float = Form(24.0),
    trimStart: float = Form(0.0),
    trimEnd: float = Form(0.0),
    fmt: str = Form("avif"),
    speed: int = Form(2),
    maxWidth: str = Form(""),
):
    logger.info("PREVIEW  jobId=%s  fmt=%s  trim=%.2f-%.2s  fps=%s  speed=%d  maxWidth=%s", jobId, fmt, trimStart, trimEnd, fps, speed, maxWidth)

    if fmt == "avif":
        await _ensure_av1()

    job = jobs.get(jobId)
    if not job:
        raise HTTPException(404, "Job not found")

    duration = trimEnd - trimStart
    if duration <= 0:
        raise HTTPException(400, "Trim range must be positive")

    timestamps = [
        trimStart + duration * p for p in [0.05, 0.35, 0.65, 0.95]
    ]
    logger.info("PREVIEW  sample timestamps: %s", timestamps)

    sample_dir = Path(job.tmp_dir) / "preview"
    sample_dir.mkdir(parents=True, exist_ok=True)

    extracted_indices = []
    for i, ts in enumerate(timestamps):
        out = sample_dir / f"frame_{i+1:04d}.png"
        ok = await extract_frame_at_timestamp(job.source_path, str(out), ts)
        if ok and out.exists():
            extracted_indices.append(i)
            sz = out.stat().st_size
            logger.info("PREVIEW  extracted frame %d at %.2fs  size=%d", i, ts, sz)
        else:
            logger.warning("PREVIEW  FAILED to extract frame %d at %.2fs", i, ts)

    if not extracted_indices:
        raise HTTPException(400, "No frames could be extracted")

    preview_dir = Path(job.tmp_dir) / "preview_encoded"
    preview_dir.mkdir(parents=True, exist_ok=True)

    results = []
    quality_presets = {
        "avif": [{"crf": 24}, {"crf": 30}, {"crf": 36}],
        "jpeg": [{"qv": 2}, {"qv": 5}, {"qv": 8}],
        "webp": [{"quality": 90}, {"quality": 70}, {"quality": 50}],
    }
    presets = quality_presets.get(fmt, quality_presets["avif"])
    logger.info("PREVIEW  encoding %d frames × %d quality presets (fmt=%s)", len(extracted_indices), len(presets), fmt)

    for qi, preset in enumerate(presets):
        qdir = preview_dir / f"q{qi}"
        qdir.mkdir(parents=True, exist_ok=True)
        for i in extracted_indices:
            src = sample_dir / f"frame_{i+1:04d}.png"
            if not src.exists():
                logger.warning("PREVIEW  missing source frame %d, skipping", i)
                continue
            ext_map = {"avif": "avif", "jpeg": "jpg", "webp": "webp"}
            dst = qdir / f"frame_{i+1:04d}.{ext_map.get(fmt, fmt)}"
            if fmt == "png":
                shutil.copy2(str(src), str(dst))
            else:
                cmd = [FFMPEG, "-y", "-i", str(src)]
                if maxWidth:
                    maxW = int(maxWidth)
                    cmd += ["-vf", f"scale='min({maxW},iw)':'min(trunc(oh*a/2)*2,dh)':flags=lanczos"]
                if fmt == "jpeg":
                    cmd += ["-q:v", str(preset.get("qv", 5))]
                elif fmt == "webp":
                    cmd += ["-quality", str(preset.get("quality", 80))]
                elif fmt == "avif":
                    cmd += ["-c:v", "libaom-av1", "-crf", str(preset.get("crf", 30)), *_avif_enc_flags(speed), "-still-picture", "1"]
                cmd.append(str(dst))
                logger.info("PREVIEW  ffmpeg[%d,q%d]: %s ...", i, qi, " ".join(str(a) for a in cmd[:10]))
                await _run_ffmpeg(cmd, timeout=300)
                if dst.exists():
                    logger.info("PREVIEW  encoded frame[%d,q%d] -> %s  size=%d", i, qi, dst.name, dst.stat().st_size)
                else:
                    logger.warning("PREVIEW  ffmpeg[%d,q%d] produced NO output", i, qi)

        frame_data = []
        for i in extracted_indices:
            ext_map = {"avif": "avif", "jpeg": "jpg", "webp": "webp"}
            f = qdir / f"frame_{i+1:04d}.{ext_map.get(fmt, fmt)}"
            if f.exists():
                data = f.read_bytes()
                frame_data.append({
                    "index": i,
                    "size": len(data),
                    "image": base64.b64encode(data).decode(),
                })
            else:
                frame_data.append({"index": i, "size": 0, "image": None})
        results.append({"quality": preset, "frames": frame_data})

    logger.info("PREVIEW  done  samples=%d  frame_count=%d", len(results), len(extracted_indices))
    return {"samples": results, "sampleIndices": extracted_indices}


@router.post("/encode")
async def encode(
    jobId: str = Form(...),
    fps: float = Form(24.0),
    trimStart: float = Form(0.0),
    trimEnd: float = Form(0.0),
    fmt: str = Form("avif"),
    quality: str = Form('{"crf": 30}'),
    speed: int = Form(2),
    maxWidth: str = Form(""),
    fallback: str = Form("false"),
):
    if fmt == "avif":
        await _ensure_av1()

    job = jobs.get(jobId)
    if not job:
        raise HTTPException(404, "Job not found")

    quality_dict = json.loads(quality)
    if fmt == "avif":
        quality_dict["speed"] = speed
    if maxWidth:
        quality_dict["maxWidth"] = maxWidth
    do_fallback = fallback.lower() == "true"
    await jobs.update(jobId, status="extracting", fps=fps, trim_start=trimStart, trim_end=trimEnd, format=fmt, quality=quality_dict)

    expected_total = max(1, int((trimEnd - trimStart) * fps))
    _progress[jobId] = {"stage": "extract", "current": 0, "total": expected_total}

    async def _extract_progress(c):
        _progress.update({jobId: {"stage": "extract", "current": c, "total": expected_total}})

    # Step 1: Extract PNG intermediates
    try:
        frame_count = await extract_frames(
            job.source_path,
            job.tmp_dir,
            fps,
            trimStart,
            trimEnd,
            progress_callback=_extract_progress,
        )
    except Exception as e:
        await jobs.update(jobId, status="failed")
        _progress.pop(jobId, None)
        raise HTTPException(500, f"Extraction failed: {e}")

    # Step 2: Encode
    await jobs.update(jobId, status="encoding")
    output_dir = str(OUTPUT_DIR / jobId)
    _progress[jobId] = {"stage": "encode", "current": 0, "total": frame_count}

    async def _encode_progress(c, t):
        _progress.update({jobId: {"stage": "encode", "current": c, "total": t}})

    failed_frames = []
    try:
        encoded_count, failures = await encode_frames(
            job.tmp_dir,
            output_dir,
            fmt,
            quality_dict,
            progress_callback=_encode_progress,
        )
        failed_frames.extend(failures)

        # Step 2b: JPEG fallback (if requested and primary format is not JPEG)
        fallback_count = 0
        fallback_pattern = ""
        if do_fallback and fmt != "jpeg":
            fallback_dir = str(OUTPUT_DIR / f"{jobId}_fallback")
            fc, fb_failures = await encode_frames(
                job.tmp_dir,
                fallback_dir,
                "jpeg",
                {"qv": 5},
                progress_callback=_encode_progress,
            )
            fallback_count = fc
            failed_frames.extend([f"fallback_{i}" for i in fb_failures])
            fallback_pattern = "frame_%04d.jpg"
    except Exception as e:
        await jobs.update(jobId, status="failed")
        _progress.pop(jobId, None)
        raise HTTPException(500, f"Encoding failed: {e}")

    # Step 3: Write manifest
    manifest_path = write_manifest(
        output_dir=output_dir,
        source_filename=job.source_filename,
        fps=fps,
        trim_start=trimStart,
        trim_end=trimEnd,
        frame_count=encoded_count,
        fmt=fmt,
        quality=quality_dict,
        width=job.width,
        height=job.height,
        source_size=job.source_size_bytes,
        fallback_format="jpeg" if do_fallback and fallback_count > 0 else None,
        fallback_pattern=fallback_pattern if do_fallback and fallback_count > 0 else None,
    )

    # Calculate total output size
    total_size = sum(
        f.stat().st_size
        for f in Path(output_dir).iterdir()
        if f.is_file() and f.name != "manifest.json"
    )

    await jobs.update(
        jobId,
        status="done",
        frame_count=encoded_count,
        output_path=output_dir,
        manifest_path=manifest_path,
        total_size_bytes=total_size,
    )

    _progress[jobId] = {"stage": "done", "current": encoded_count, "total": encoded_count}

    return {
        "jobId": jobId,
        "status": "done",
        "frameCount": encoded_count,
        "totalSizeBytes": total_size,
        "manifestPath": manifest_path,
    }


@router.post("/jobs/{job_id}/rerun")
async def rerun_job(
    job_id: str,
    fps: float = Form(24.0),
    trimStart: float = Form(0.0),
    trimEnd: float = Form(0.0),
    fmt: str = Form("avif"),
    quality: str = Form('{"crf": 30}'),
    fallback: str = Form("false"),
):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")

    # Check if cached PNG intermediates exist
    tmp_dir = Path(job.tmp_dir)
    cached_pngs = sorted(tmp_dir.glob("frame_*.png")) if tmp_dir.exists() else []

    quality_dict = json.loads(quality)
    do_fallback = fallback.lower() == "true"

    if not cached_pngs:
        await jobs.update(job_id, status="extracting", fps=fps, trim_start=trimStart, trim_end=trimEnd, format=fmt, quality=quality_dict)
        frame_count = await extract_frames(job.source_path, job.tmp_dir, fps, trimStart, trimEnd)
    else:
        frame_count = len(cached_pngs)
        await jobs.update(job_id, status="encoding", fps=fps, trim_start=trimStart, trim_end=trimEnd, format=fmt, quality=quality_dict)

    # Encode
    output_dir = str(OUTPUT_DIR / job_id)
    encoded_count, _ = await encode_frames(job.tmp_dir, output_dir, fmt, quality_dict)

    # JPEG fallback (if requested and primary format is not JPEG)
    fallback_count = 0
    fallback_pattern = ""
    if do_fallback and fmt != "jpeg":
        fallback_dir = str(OUTPUT_DIR / f"{job_id}_fallback")
        fc, _ = await encode_frames(job.tmp_dir, fallback_dir, "jpeg", {"qv": 5})
        fallback_count = fc
        fallback_pattern = "frame_%04d.jpg"

    # Manifest
    manifest_path = write_manifest(
        output_dir=output_dir,
        source_filename=job.source_filename,
        fps=fps,
        trim_start=trimStart,
        trim_end=trimEnd,
        frame_count=encoded_count,
        fmt=fmt,
        quality=quality_dict,
        width=job.width,
        height=job.height,
        source_size=job.source_size_bytes,
        fallback_format="jpeg" if do_fallback and fallback_count > 0 else None,
        fallback_pattern=fallback_pattern if do_fallback and fallback_count > 0 else None,
    )

    total_size = sum(
        f.stat().st_size
        for f in Path(output_dir).iterdir()
        if f.is_file() and f.name != "manifest.json"
    )

    # Include fallback frames in total size
    if fallback_count > 0:
        fallback_out = Path(fallback_dir)
        if fallback_out.exists():
            total_size += sum(f.stat().st_size for f in fallback_out.iterdir() if f.is_file())

    await jobs.update(
        job_id,
        status="done",
        frame_count=encoded_count,
        output_path=output_dir,
        manifest_path=manifest_path,
        total_size_bytes=total_size,
    )

    return {"jobId": job_id, "status": "done", "frameCount": encoded_count, "totalSizeBytes": total_size}


@router.post("/trim-export")
async def trim_export(
    bg: BackgroundTasks,
    file: UploadFile = File(...),
    fps: float = Form(24.0),
    trimStart: float = Form(0.0),
    trimEnd: float = Form(0.0),
):
    if not file.filename:
        raise HTTPException(400, "No filename provided")

    safe_name = Path(file.filename).name
    dest_dir = Path.home() / ".frameforge" / "uploads"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"trim_{os.urandom(4).hex()}_{safe_name}"

    total_read = 0
    with open(dest, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            total_read += len(chunk)
            if total_read > MAX_UPLOAD_SIZE:
                dest.unlink(missing_ok=True)
                raise HTTPException(413, f"File too large — max {MAX_UPLOAD_SIZE // (1024**3)}GB")
            f.write(chunk)

    tmp_dir = Path.home() / ".frameforge" / "tmp" / f"trim_{os.urandom(4).hex()}"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    try:
        await extract_frames(str(dest), str(tmp_dir), fps, trimStart, trimEnd)
    except Exception as e:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        dest.unlink(missing_ok=True)
        raise HTTPException(500, f"Frame extraction failed: {e}")

    zip_io = tempfile.NamedTemporaryFile(delete=False)
    with zipfile.ZipFile(zip_io, "w", zipfile.ZIP_DEFLATED) as zf:
        for png in sorted(tmp_dir.glob("frame_*.png")):
            zf.write(png, png.name)

    zip_io.close()

    bg.add_task(_cleanup_temp, zip_io.name)
    bg.add_task(lambda: shutil.rmtree(tmp_dir, ignore_errors=True))
    bg.add_task(lambda: dest.unlink(missing_ok=True))

    base_name = safe_name.rsplit(".", 1)[0]
    return FileResponse(
        zip_io.name,
        media_type="application/zip",
        filename=f"{base_name}-trimmed-frames.zip",
        headers={"Content-Disposition": f"attachment; filename={base_name}-trimmed-frames.zip"},
    )


@router.post("/convert-image")
async def convert_image_endpoint(
    file: UploadFile = File(...),
    fmt: str = Form("jpeg"),
    quality: str = Form('{"qv": 5}'),
    resize: str = Form(""),
):
    if not file.filename:
        raise HTTPException(400, "No filename provided")

    safe_name = Path(file.filename).name
    dest_dir = Path.home() / ".frameforge" / "uploads"
    dest_dir.mkdir(parents=True, exist_ok=True)
    ext = safe_name.rsplit(".", 1)[-1] if "." in safe_name else "png"
    dest = dest_dir / f"convert_{os.urandom(4).hex()}.{ext}"

    total_read = 0
    with open(dest, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            total_read += len(chunk)
            if total_read > MAX_UPLOAD_SIZE:
                dest.unlink(missing_ok=True)
                raise HTTPException(413, f"File too large — max {MAX_UPLOAD_SIZE // (1024**3)}GB")
            f.write(chunk)

    quality_dict = json.loads(quality)
    output_file = dest_dir / f"converted_{os.urandom(4).hex()}"

    try:
        out_size = await convert_image(str(dest), str(output_file), fmt, quality_dict, resize)
    except Exception as e:
        dest.unlink(missing_ok=True)
        raise HTTPException(500, f"Conversion failed: {e}")

    # Return the converted image as base64
    ext_map = {"avif": "avif", "jpeg": "jpg", "webp": "webp", "png": "png"}
    out_ext = ext_map.get(fmt, fmt)
    actual_path = str(output_file) + "." + out_ext
    data = Path(actual_path).read_bytes()

    # Cleanup
    dest.unlink(missing_ok=True)
    Path(actual_path).unlink(missing_ok=True)

    return {
        "format": fmt,
        "size": out_size,
        "image": base64.b64encode(data).decode(),
    }


@router.post("/bgremove/chromakey")
async def bgremove_chromakey(
    bg: BackgroundTasks,
    file: UploadFile = File(...),
    keyColor: str = Form("0x00FF00"),
    similarity: float = Form(0.2),
    blend: float = Form(0.3),
):
    if not file.filename:
        raise HTTPException(400, "No filename provided")

    safe_name = Path(file.filename).name
    dest_dir = Path.home() / ".frameforge" / "uploads"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"ck_{os.urandom(4).hex()}_{safe_name}"

    total_read = 0
    with open(dest, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            total_read += len(chunk)
            if total_read > MAX_UPLOAD_SIZE:
                dest.unlink(missing_ok=True)
                raise HTTPException(413, f"File too large — max {MAX_UPLOAD_SIZE // (1024**3)}GB")
            f.write(chunk)

    base_name = safe_name.rsplit(".", 1)[0]
    out_path = str(Path.home() / ".frameforge" / "tmp" / f"ck_{os.urandom(4).hex()}_{base_name}.webm")

    try:
        out_path, out_size = await remove_background_chromakey(
            str(dest), out_path,
            key_color=keyColor, similarity=similarity, blend=blend,
        )
    except Exception as e:
        dest.unlink(missing_ok=True)
        Path(out_path).unlink(missing_ok=True)
        raise HTTPException(500, f"Chroma key failed: {e}")

    bg.add_task(lambda: Path(out_path).unlink(missing_ok=True))
    bg.add_task(lambda: dest.unlink(missing_ok=True))
    return FileResponse(
        out_path,
        media_type="video/webm",
        filename=f"{base_name}-keyed.webm",
        headers={"Content-Disposition": f"attachment; filename={base_name}-keyed.webm"},
    )


@router.post("/bgremove/ai")
async def bgremove_ai(
    file: UploadFile = File(...),
    fps: float = Form(24.0),
    trimStart: float = Form(0.0),
    trimEnd: float = Form(0.0),
):
    if not file.filename:
        raise HTTPException(400, "No filename provided")

    safe_name = Path(file.filename).name
    dest_dir = Path.home() / ".frameforge" / "uploads"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"ai_{os.urandom(4).hex()}_{safe_name}"

    total_read = 0
    with open(dest, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            total_read += len(chunk)
            if total_read > MAX_UPLOAD_SIZE:
                dest.unlink(missing_ok=True)
                raise HTTPException(413, f"File too large — max {MAX_UPLOAD_SIZE // (1024**3)}GB")
            f.write(chunk)

    job = await jobs.create(source_filename=file.filename, source_path=str(dest), source_size=0)
    await jobs.update(job.id, status="segmenting", fps=fps, trim_start=trimStart, trim_end=trimEnd)

    tmp_dir = Path(job.tmp_dir)
    png_dir = tmp_dir / "frames"
    seg_dir = tmp_dir / "segmented"
    png_dir.mkdir(exist_ok=True)
    seg_dir.mkdir(exist_ok=True)

    frame_count = 0
    try:
        frame_count = await extract_frames(str(dest), str(png_dir), fps, trimStart, trimEnd)
    except Exception as e:
        await jobs.update(job.id, status="failed")
        dest.unlink(missing_ok=True)
        raise HTTPException(500, f"Frame extraction failed: {e}")

    if frame_count == 0:
        await jobs.update(job.id, status="failed")
        dest.unlink(missing_ok=True)
        raise HTTPException(400, "No frames extracted")

    _progress[job.id] = {"stage": "segmenting", "current": 0, "total": frame_count}
    await jobs.update(job.id, status="segmenting")

    pngs = sorted(png_dir.glob("frame_*.png"))
    completed = 0
    for png in pngs:
        out = seg_dir / png.name
        ok = await segment_frame_ai(str(png), str(out))
        if ok:
            completed += 1
        _progress[job.id] = {"stage": "segmenting", "current": completed, "total": frame_count}

    if completed == 0:
        await jobs.update(job.id, status="failed")
        raise HTTPException(500, "AI segmentation produced no frames")

    # Zip the segmented PNGs
    zip_io = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
    with zipfile.ZipFile(zip_io, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(seg_dir.glob("frame_*.png")):
            zf.write(f, f.name)

    zip_io.close()

    total_size = sum(f.stat().st_size for f in seg_dir.glob("frame_*.png"))
    await jobs.update(job.id, status="done", frame_count=completed, total_size_bytes=total_size)

    base_name = safe_name.rsplit(".", 1)[0]
    bg = BackgroundTasks()
    bg.add_task(_cleanup_temp, zip_io.name)
    bg.add_task(lambda: dest.unlink(missing_ok=True))

    return FileResponse(
        zip_io.name,
        media_type="application/zip",
        filename=f"{base_name}-segmented-frames.zip",
        headers={"Content-Disposition": f"attachment; filename={base_name}-segmented-frames.zip"},
    )

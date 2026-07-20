from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from .config import OUTPUT_DIR
from .ffmpeg_utils import (
    check_ffmpeg,
    convert_image,
    encode_frames,
    extract_frame_at_timestamp,
    extract_frames,
    probe_video,
    write_manifest,
)
from .jobs import JobsManager

router = APIRouter()
jobs = JobsManager()

# In-memory progress tracking
_progress: dict[str, dict] = {}


@router.get("/health")
async def health():
    checks = await check_ffmpeg()
    return {"status": "ok" if checks["ffmpeg"] and checks["ffprobe"] else "error", "ffmpeg": checks}


@router.post("/upload")
async def upload(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(400, "No filename provided")

    dest_dir = Path.home() / ".frameforge" / "uploads"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / file.filename

    with open(dest, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            f.write(chunk)

    try:
        meta = await probe_video(str(dest))
    except Exception as e:
        raise HTTPException(400, f"Failed to probe video: {e}")

    job = jobs.create(
        source_filename=file.filename,
        source_path=str(dest),
        source_size=meta["size_bytes"],
    )
    jobs.update(
        job.id,
        width=meta["width"],
        height=meta["height"],
        duration=meta["duration"],
        fps=meta["fps"],
        codec=meta["codec"],
        trim_end=meta["duration"],
    )

    return {
        "jobId": job.id,
        "filename": file.filename,
        "metadata": meta,
    }


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


@router.get("/jobs/{job_id}/download")
async def job_download(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if not job.output_path or not Path(job.output_path).exists():
        raise HTTPException(404, "Output not found")

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        output_dir = Path(job.output_path)
        for f in sorted(output_dir.iterdir()):
            if f.is_file():
                zf.write(f, f.name)
        manifest = output_dir / "manifest.json"
        if manifest.exists():
            zf.write(manifest, "manifest.json")
    buf.seek(0)

    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename={job.source_filename.rsplit('.', 1)[0]}-frames.zip"},
    )


@router.post("/preview")
async def preview(
    jobId: str = Form(...),
    fps: float = Form(24.0),
    trimStart: float = Form(0.0),
    trimEnd: float = Form(0.0),
    fmt: str = Form("avif"),
):
    job = jobs.get(jobId)
    if not job:
        raise HTTPException(404, "Job not found")

    duration = trimEnd - trimStart
    if duration <= 0:
        raise HTTPException(400, "Trim range must be positive")

    # Extract only 4 sample frames at evenly spaced timestamps
    timestamps = [
        trimStart + duration * p for p in [0.05, 0.35, 0.65, 0.95]
    ]

    sample_dir = Path(job.tmp_dir) / "preview"
    sample_dir.mkdir(parents=True, exist_ok=True)

    extracted_indices = []
    for i, ts in enumerate(timestamps):
        out = sample_dir / f"frame_{i+1:04d}.png"
        ok = await extract_frame_at_timestamp(job.source_path, str(out), ts)
        if ok and out.exists():
            extracted_indices.append(i)

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

    for qi, preset in enumerate(presets):
        qdir = preview_dir / f"q{qi}"
        qdir.mkdir(parents=True, exist_ok=True)
        for i in extracted_indices:
            src = sample_dir / f"frame_{i+1:04d}.png"
            if not src.exists():
                continue
            ext_map = {"avif": "avif", "jpeg": "jpg", "webp": "webp"}
            dst = qdir / f"frame_{i+1:04d}.{ext_map.get(fmt, fmt)}"
            if fmt == "png":
                shutil.copy2(str(src), str(dst))
            else:
                cmd = [FFMPEG, "-y", "-i", str(src)]
                if fmt == "jpeg":
                    cmd += ["-q:v", str(preset.get("qv", 5))]
                elif fmt == "webp":
                    cmd += ["-quality", str(preset.get("quality", 80))]
                elif fmt == "avif":
                    cmd += ["-c:v", "libaom-av1", "-crf", str(preset.get("crf", 30)), "-still-picture", "1"]
                cmd.append(str(dst))
                proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                await proc.wait()

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

    return {"samples": results, "sampleIndices": extracted_indices}


@router.post("/encode")
async def encode(
    jobId: str = Form(...),
    fps: float = Form(24.0),
    trimStart: float = Form(0.0),
    trimEnd: float = Form(0.0),
    fmt: str = Form("avif"),
    quality: str = Form('{"crf": 30}'),
    fallback: str = Form("false"),
):
    job = jobs.get(jobId)
    if not job:
        raise HTTPException(404, "Job not found")

    quality_dict = json.loads(quality)
    do_fallback = fallback.lower() == "true"
    jobs.update(jobId, status="extracting", fps=fps, trim_start=trimStart, trim_end=trimEnd, format=fmt, quality=quality_dict)

    _progress[jobId] = {"stage": "extract", "current": 0, "total": 0}

    async def _extract_progress(c):
        _progress.update({jobId: {"stage": "extract", "current": c, "total": 0}})

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
        jobs.update(jobId, status="failed")
        raise HTTPException(500, f"Extraction failed: {e}")

    # Step 2: Encode
    jobs.update(jobId, status="encoding")
    output_dir = str(OUTPUT_DIR / jobId)
    _progress[jobId] = {"stage": "encode", "current": 0, "total": frame_count}

    async def _encode_progress(c, t):
        _progress.update({jobId: {"stage": "encode", "current": c, "total": t}})

    try:
        encoded_count = await encode_frames(
            job.tmp_dir,
            output_dir,
            fmt,
            quality_dict,
            progress_callback=_encode_progress,
        )

        # Step 2b: JPEG fallback (if requested and primary format is not JPEG)
        fallback_count = 0
        fallback_pattern = ""
        if do_fallback and fmt != "jpeg":
            fallback_dir = str(OUTPUT_DIR / f"{jobId}_fallback")
            fallback_count = await encode_frames(
                job.tmp_dir,
                fallback_dir,
                "jpeg",
                {"qv": 5},
                progress_callback=_encode_progress,
            )
            fallback_pattern = "frame_%04d.jpg"
    except Exception as e:
        jobs.update(jobId, status="failed")
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

    jobs.update(
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
        # No cache — full extraction needed
        jobs.update(job_id, status="extracting", fps=fps, trim_start=trimStart, trim_end=trimEnd, format=fmt, quality=quality_dict)
        frame_count = await extract_frames(job.source_path, job.tmp_dir, fps, trimStart, trimEnd)
    else:
        frame_count = len(cached_pngs)
        jobs.update(job_id, status="encoding", fps=fps, trim_start=trimStart, trim_end=trimEnd, format=fmt, quality=quality_dict)

    # Encode
    output_dir = str(OUTPUT_DIR / job_id)
    encoded_count = await encode_frames(job.tmp_dir, output_dir, fmt, quality_dict)

    # JPEG fallback (if requested and primary format is not JPEG)
    fallback_count = 0
    fallback_pattern = ""
    if do_fallback and fmt != "jpeg":
        fallback_dir = str(OUTPUT_DIR / f"{job_id}_fallback")
        fallback_count = await encode_frames(job.tmp_dir, fallback_dir, "jpeg", {"qv": 5})
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

    jobs.update(
        job_id,
        status="done",
        frame_count=encoded_count,
        output_path=output_dir,
        manifest_path=manifest_path,
        total_size_bytes=total_size,
    )

    return {"jobId": job_id, "status": "done", "frameCount": encoded_count, "totalSizeBytes": total_size}


@router.post("/convert-image")
async def convert_image_endpoint(
    file: UploadFile = File(...),
    fmt: str = Form("jpeg"),
    quality: str = Form('{"qv": 5}'),
    resize: str = Form(""),
):
    import base64

    if not file.filename:
        raise HTTPException(400, "No filename provided")

    dest_dir = Path.home() / ".frameforge" / "uploads"
    dest_dir.mkdir(parents=True, exist_ok=True)
    ext = file.filename.rsplit(".", 1)[-1] if "." in file.filename else "png"
    dest = dest_dir / f"convert_{os.urandom(4).hex()}.{ext}"

    with open(dest, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            f.write(chunk)

    quality_dict = json.loads(quality)
    output_file = dest_dir / f"converted_{os.urandom(4).hex()}"

    try:
        out_size = await convert_image(str(dest), str(output_file), fmt, quality_dict, resize)
    except Exception as e:
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

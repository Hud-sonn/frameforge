from __future__ import annotations

import asyncio
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

    # Extract a few sample frames
    sample_dir = str(Path(job.tmp_dir) / "preview")
    count = await extract_frames(job.source_path, sample_dir, fps, trimStart, trimEnd)

    if count == 0:
        raise HTTPException(400, "No frames extracted")

    # Pick 4 evenly spaced samples
    sample_indices = [
        max(0, int(count * p) - 1) for p in [0.1, 0.4, 0.7, 0.9]
    ]
    sample_indices = sorted(set(min(i, count - 1) for i in sample_indices))

    preview_dir = str(Path(job.tmp_dir) / "preview_encoded")
    Path(preview_dir).mkdir(parents=True, exist_ok=True)

    results = []
    quality_presets = {
        "avif": [{"crf": 24}, {"crf": 30}, {"crf": 36}],
        "jpeg": [{"qv": 2}, {"qv": 5}, {"qv": 8}],
        "webp": [{"quality": 90}, {"quality": 70}, {"quality": 50}],
    }
    presets = quality_presets.get(fmt, quality_presets["avif"])

    for qi, preset in enumerate(presets):
        preset_dir = str(Path(preview_dir) / f"q{qi}")
        await encode_frames(sample_dir, preset_dir, fmt, preset)
        encoded_files = sorted(Path(preset_dir).glob(f"*.{fmt if fmt != 'jpeg' else 'jpg'}"))
        frame_data = []
        for idx in sample_indices:
            if idx < len(encoded_files):
                import base64
                data = encoded_files[idx].read_bytes()
                frame_data.append({
                    "index": idx,
                    "size": len(data),
                    "image": base64.b64encode(data).decode(),
                })
        results.append({"quality": preset, "frames": frame_data})

    return {"samples": results, "sampleIndices": sample_indices}


@router.post("/encode")
async def encode(
    jobId: str = Form(...),
    fps: float = Form(24.0),
    trimStart: float = Form(0.0),
    trimEnd: float = Form(0.0),
    fmt: str = Form("avif"),
    quality: str = Form('{"crf": 30}'),
):
    job = jobs.get(jobId)
    if not job:
        raise HTTPException(404, "Job not found")

    quality_dict = json.loads(quality)
    jobs.update(jobId, status="extracting", fps=fps, trim_start=trimStart, trim_end=trimEnd, format=fmt, quality=quality_dict)

    _progress[jobId] = {"stage": "extract", "current": 0, "total": 0}

    # Step 1: Extract PNG intermediates
    try:
        frame_count = await extract_frames(
            job.source_path,
            job.tmp_dir,
            fps,
            trimStart,
            trimEnd,
            progress_callback=lambda c: _progress.update({jobId: {"stage": "extract", "current": c, "total": 0}}),
        )
    except Exception as e:
        jobs.update(jobId, status="failed")
        raise HTTPException(500, f"Extraction failed: {e}")

    # Step 2: Encode
    jobs.update(jobId, status="encoding")
    output_dir = str(OUTPUT_DIR / jobId)
    _progress[jobId] = {"stage": "encode", "current": 0, "total": frame_count}

    try:
        encoded_count = await encode_frames(
            job.tmp_dir,
            output_dir,
            fmt,
            quality_dict,
            progress_callback=lambda c, t: _progress.update({jobId: {"stage": "encode", "current": c, "total": t}}),
        )
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
):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")

    # Check if cached PNG intermediates exist
    tmp_dir = Path(job.tmp_dir)
    cached_pngs = sorted(tmp_dir.glob("frame_*.png")) if tmp_dir.exists() else []

    quality_dict = json.loads(quality)

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
    )

    total_size = sum(
        f.stat().st_size
        for f in Path(output_dir).iterdir()
        if f.is_file() and f.name != "manifest.json"
    )

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

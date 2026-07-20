from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
from pathlib import Path

logger = logging.getLogger(__name__)

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"


async def check_ffmpeg() -> dict[str, str | bool]:
    """Check ffmpeg and ffprobe availability. Returns dict with status info."""
    result = {"ffmpeg": False, "ffprobe": False, "av1_encoder": False}

    for binary, key in [(FFMPEG, "ffmpeg"), (FFPROBE, "ffprobe")]:
        try:
            proc = await asyncio.create_subprocess_exec(
                binary, "-version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await proc.communicate()
            result[key] = proc.returncode == 0
        except FileNotFoundError:
            result[key] = False

    # Check AV1 encoder support (needed for AVIF)
    try:
        proc = await asyncio.create_subprocess_exec(
            FFMPEG, "-encoders",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        result["av1_encoder"] = b"av1" in stdout.lower()
    except Exception:
        pass

    return result


async def probe_video(path: str) -> dict:
    """Extract video metadata using ffprobe."""
    proc = await asyncio.create_subprocess_exec(
        FFPROBE,
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {stderr.decode()}")

    data = json.loads(stdout)
    video_stream = next(
        (s for s in data.get("streams", []) if s.get("codec_type") == "video"), None
    )
    if not video_stream:
        raise ValueError("No video stream found")

    duration = float(data.get("format", {}).get("duration", 0))
    fps_str = video_stream.get("r_frame_rate", "24/1")
    if "/" in fps_str:
        num, den = fps_str.split("/")
        fps = float(num) / float(den) if float(den) != 0 else 24.0
    else:
        fps = float(fps_str)

    return {
        "width": int(video_stream.get("width", 0)),
        "height": int(video_stream.get("height", 0)),
        "duration": duration,
        "fps": round(fps, 3),
        "codec": video_stream.get("codec_name", "unknown"),
        "size_bytes": int(data.get("format", {}).get("size", 0)),
    }


async def extract_frame_at_timestamp(
    input_path: str,
    output_path: str,
    timestamp: float,
) -> bool:
    """Extract a single frame at a given timestamp (fast - uses keyframe seek)."""
    cmd = [FFMPEG, "-y", "-ss", str(timestamp), "-i", input_path, "-vframes", "1", output_path]
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    await proc.wait()
    return Path(output_path).exists()


async def extract_frames(
    input_path: str,
    output_dir: str,
    fps: float,
    trim_start: float,
    trim_end: float,
    progress_callback=None,
) -> int:
    """Extract frames from video to PNG intermediates. Returns frame count."""
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    pattern = str(Path(output_dir) / "frame_%04d.png")

    cmd = [FFMPEG, "-y", "-i", input_path]
    if trim_start > 0:
        cmd += ["-ss", str(trim_start)]
    if trim_end > 0:
        cmd += ["-to", str(trim_end)]
    cmd += ["-vf", f"fps={fps}", "-progress", "pipe:1", pattern]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    frame_count = 0
    while True:
        line = await proc.stdout.readline()
        if not line:
            break
        decoded = line.decode().strip()
        if decoded.startswith("frame="):
            match = re.search(r"frame=\s*(\d+)", decoded)
            if match:
                frame_count = int(match.group(1))
                if progress_callback:
                    if asyncio.iscoroutinefunction(progress_callback):
                        await progress_callback(frame_count)
                    else:
                        progress_callback(frame_count)

    await proc.wait()
    if proc.returncode != 0:
        stderr = await proc.stderr.read()
        raise RuntimeError(f"ffmpeg extraction failed: {stderr.decode()}")

    # Count actual files written
    png_files = sorted(Path(output_dir).glob("frame_*.png"))
    return len(png_files)


async def encode_frames(
    input_dir: str,
    output_dir: str,
    fmt: str,
    quality: dict,
    progress_callback=None,
) -> int:
    """Encode PNG intermediates to target format. Returns count of encoded files."""
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    png_files = sorted(Path(input_dir).glob("frame_*.png"))
    total = len(png_files)

    ext_map = {"avif": "avif", "jpeg": "jpg", "webp": "webp", "png": "png"}
    ext = ext_map.get(fmt, fmt)
    count = 0

    for i, png in enumerate(png_files):
        out_name = f"frame_{i+1:04d}.{ext}"
        out_path = str(Path(output_dir) / out_name)

        if fmt == "png":
            # PNG passthrough — just copy
            shutil.copy2(str(png), out_path)
        elif fmt == "jpeg":
            qv = quality.get("qv", 5)
            cmd = [FFMPEG, "-y", "-i", str(png), "-q:v", str(qv), out_path]
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
            await proc.wait()
        elif fmt == "webp":
            q = quality.get("quality", 80)
            cmd = [FFMPEG, "-y", "-i", str(png), "-quality", str(q), out_path]
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
            await proc.wait()
        elif fmt == "avif":
            crf = quality.get("crf", 30)
            cmd = [
                FFMPEG, "-y", "-i", str(png),
                "-c:v", "libaom-av1", "-crf", str(crf),
                "-still-picture", "1", out_path,
            ]
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
            await proc.wait()

        count += 1
        if progress_callback:
            if asyncio.iscoroutinefunction(progress_callback):
                await progress_callback(count, total)
            else:
                progress_callback(count, total)

    return count


async def convert_image(
    input_path: str,
    output_path: str,
    fmt: str,
    quality: dict,
    resize: str = "",
) -> int:
    """Convert a single image to target format. Optionally resize. Returns output file size."""
    ext_map = {"avif": "avif", "jpeg": "jpg", "webp": "webp", "png": "png"}
    ext = ext_map.get(fmt, fmt)
    out_path = str(Path(output_path).with_suffix(f".{ext}"))

    if fmt == "png":
        shutil.copy2(input_path, out_path)
    else:
        cmd = [FFMPEG, "-y", "-i", input_path]
        if resize:
            cmd += ["-vf", f"scale={resize}"]
        if fmt == "jpeg":
            qv = quality.get("qv", 5)
            cmd += ["-q:v", str(qv), out_path]
        elif fmt == "webp":
            q = quality.get("quality", 80)
            cmd += ["-quality", str(q), out_path]
        elif fmt == "avif":
            crf = quality.get("crf", 30)
            cmd += ["-c:v", "libaom-av1", "-crf", str(crf), "-still-picture", "1", out_path]
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        await proc.wait()

    return Path(out_path).stat().st_size


def write_manifest(
    output_dir: str,
    source_filename: str,
    fps: float,
    trim_start: float,
    trim_end: float,
    frame_count: int,
    fmt: str,
    quality: dict,
    width: int,
    height: int,
    source_size: int,
    fallback_format: str = "",
    fallback_pattern: str = "",
) -> str:
    """Write manifest.json and return its path."""
    ext_map = {"avif": "avif", "jpeg": "jpg", "webp": "webp", "png": "png"}
    ext = ext_map.get(fmt, fmt)

    total_size = sum(
        f.stat().st_size for f in Path(output_dir).iterdir() if f.suffix == f".{ext}"
    )

    manifest = {
        "version": 1,
        "sourceFile": source_filename,
        "createdAt": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat(),
        "fps": fps,
        "frameCount": frame_count,
        "trimStart": trim_start,
        "trimEnd": trim_end,
        "format": fmt,
        "quality": quality,
        "width": width,
        "height": height,
        "basePath": f"/frames/{source_filename.rsplit('.', 1)[0]}/",
        "filenamePattern": f"frame_%04d.{ext}",
        "totalSizeBytes": total_size,
        "sourceSizeBytes": source_size,
    }

    if fallback_format:
        manifest["fallbackFormat"] = fallback_format
        manifest["fallbackFilenamePattern"] = fallback_pattern

    manifest_path = str(Path(output_dir) / "manifest.json")
    Path(manifest_path).write_text(json.dumps(manifest, indent=2))
    return manifest_path

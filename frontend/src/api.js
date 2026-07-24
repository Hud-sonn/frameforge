const API = '/api';

class AbortError extends Error {
  constructor() { super('Request cancelled'); this.name = 'AbortError'; }
}

async function fetchJson(url, opts = {}, signal) {
  const controller = new AbortController();
  const combined = signal || controller.signal;
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  const timeout = setTimeout(() => controller.abort(), 900_000); // 15 min timeout
  try {
    const res = await fetch(url, { ...opts, signal: combined });
    clearTimeout(timeout);
    if (res.status === 413) throw new Error('File too large — max 4GB');
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `Request failed (${res.status})`);
    return res.json();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new AbortError();
    throw err;
  }
}

export { AbortError };

export async function healthCheck(signal) {
  return fetchJson(`${API}/health`, {}, signal);
}

export async function uploadVideo(file, signal) {
  const form = new FormData();
  form.append('file', file);
  return fetchJson(`${API}/upload`, { method: 'POST', body: form }, signal);
}

export async function getJobs(signal) {
  return fetchJson(`${API}/jobs`, {}, signal);
}

export async function pollJobStatus(jobId, signal) {
  return fetchJson(`${API}/jobs/${jobId}/status`, {}, signal);
}

export async function getManifest(jobId, signal) {
  return fetchJson(`${API}/jobs/${jobId}/manifest`, {}, signal);
}

export async function runPreview(jobId, { fps, trimStart, trimEnd, fmt, speed, maxWidth }, signal) {
  const form = new FormData();
  form.append('jobId', jobId);
  form.append('fps', fps);
  form.append('trimStart', trimStart);
  form.append('trimEnd', trimEnd);
  form.append('fmt', fmt);
  form.append('speed', String(speed ?? 2));
  form.append('maxWidth', maxWidth || '');
  return fetchJson(`${API}/preview`, { method: 'POST', body: form }, signal);
}

export async function runEncode(jobId, { fps, trimStart, trimEnd, fmt, quality, speed, maxWidth, fallback }, signal) {
  const form = new FormData();
  form.append('jobId', jobId);
  form.append('fps', fps);
  form.append('trimStart', trimStart);
  form.append('trimEnd', trimEnd);
  form.append('fmt', fmt);
  form.append('quality', JSON.stringify(quality));
  form.append('speed', String(speed ?? 2));
  form.append('maxWidth', maxWidth || '');
  form.append('fallback', fallback ? 'true' : 'false');
  return fetchJson(`${API}/encode`, { method: 'POST', body: form }, signal);
}

export async function rerunJob(jobId, { fps, trimStart, trimEnd, fmt, quality, speed, maxWidth, fallback }, signal) {
  const form = new FormData();
  form.append('fps', fps);
  form.append('trimStart', trimStart);
  form.append('trimEnd', trimEnd);
  form.append('fmt', fmt);
  form.append('quality', JSON.stringify(quality));
  form.append('speed', String(speed ?? 2));
  form.append('maxWidth', maxWidth || '');
  form.append('fallback', fallback ? 'true' : 'false');
  return fetchJson(`${API}/jobs/${jobId}/rerun`, { method: 'POST', body: form }, signal);
}

export async function convertImage(file, { fmt, quality, resize }, signal) {
  const form = new FormData();
  form.append('file', file);
  form.append('fmt', fmt);
  form.append('quality', JSON.stringify(quality));
  form.append('resize', resize);
  return fetchJson(`${API}/convert-image`, { method: 'POST', body: form }, signal);
}

export async function deleteJob(jobId, signal) {
  return fetchJson(`${API}/jobs/${jobId}`, { method: 'DELETE' }, signal);
}

export function downloadUrl(jobId) {
  return `${API}/jobs/${jobId}/download`;
}

export function compressedUrl(jobId) {
  return `${API}/jobs/${jobId}/compressed`;
}

export async function compressVideo(file, { format, crf, preset, keepAudio }, signal) {
  const form = new FormData();
  form.append('file', file);
  form.append('format', format || '');
  form.append('crf', String(crf));
  form.append('preset', preset);
  form.append('keepAudio', keepAudio ? 'true' : 'false');
  return fetchJson(`${API}/compress`, { method: 'POST', body: form }, signal);
}

export async function bgRemoveChromakey(file, { keyColor, similarity, blend }, signal) {
  const form = new FormData();
  form.append('file', file);
  form.append('keyColor', keyColor);
  form.append('similarity', String(similarity));
  form.append('blend', String(blend));
  return fetch(`${API}/bgremove/chromakey`, { method: 'POST', body: form, signal });
}

export async function bgRemoveAI(file, { fps, trimStart, trimEnd }, signal) {
  const form = new FormData();
  form.append('file', file);
  form.append('fps', String(fps));
  form.append('trimStart', String(trimStart));
  form.append('trimEnd', String(trimEnd));
  return fetchJson(`${API}/bgremove/ai`, { method: 'POST', body: form }, signal);
}

export function bgRemoveAIResultUrl(jobId) {
  return `${API}/bgremove/ai/${jobId}/result`;
}

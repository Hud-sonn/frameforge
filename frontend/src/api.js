const API = '/api';

export async function healthCheck() {
  const res = await fetch(`${API}/health`);
  return res.json();
}

export async function uploadVideo(file) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API}/upload`, { method: 'POST', body: form });
  if (!res.ok) throw new Error((await res.json()).detail || 'Upload failed');
  return res.json();
}

export async function getJobs() {
  const res = await fetch(`${API}/jobs`);
  return res.json();
}

export async function pollJobStatus(jobId) {
  const res = await fetch(`${API}/jobs/${jobId}/status`);
  return res.json();
}

export async function getManifest(jobId) {
  const res = await fetch(`${API}/jobs/${jobId}/manifest`);
  return res.json();
}

export async function runPreview(jobId, { fps, trimStart, trimEnd, fmt }) {
  const form = new FormData();
  form.append('jobId', jobId);
  form.append('fps', fps);
  form.append('trimStart', trimStart);
  form.append('trimEnd', trimEnd);
  form.append('fmt', fmt);
  const res = await fetch(`${API}/preview`, { method: 'POST', body: form });
  if (!res.ok) throw new Error((await res.json()).detail || 'Preview failed');
  return res.json();
}

export async function runEncode(jobId, { fps, trimStart, trimEnd, fmt, quality }) {
  const form = new FormData();
  form.append('jobId', jobId);
  form.append('fps', fps);
  form.append('trimStart', trimStart);
  form.append('trimEnd', trimEnd);
  form.append('fmt', fmt);
  form.append('quality', JSON.stringify(quality));
  const res = await fetch(`${API}/encode`, { method: 'POST', body: form });
  if (!res.ok) throw new Error((await res.json()).detail || 'Encode failed');
  return res.json();
}

export async function rerunJob(jobId, { fps, trimStart, trimEnd, fmt, quality, fallback }) {
  const form = new FormData();
  form.append('fps', fps);
  form.append('trimStart', trimStart);
  form.append('trimEnd', trimEnd);
  form.append('fmt', fmt);
  form.append('quality', JSON.stringify(quality));
  form.append('fallback', fallback ? 'true' : 'false');
  const res = await fetch(`${API}/jobs/${jobId}/rerun`, { method: 'POST', body: form });
  if (!res.ok) throw new Error((await res.json()).detail || 'Re-run failed');
  return res.json();
}

export async function convertImage(file, { fmt, quality, resize }) {
  const form = new FormData();
  form.append('file', file);
  form.append('fmt', fmt);
  form.append('quality', JSON.stringify(quality));
  form.append('resize', resize);
  const res = await fetch(`${API}/convert-image`, { method: 'POST', body: form });
  if (!res.ok) throw new Error((await res.json()).detail || 'Conversion failed');
  return res.json();
}

export function downloadUrl(jobId) {
  return `${API}/jobs/${jobId}/download`;
}

import React, { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';
import * as api from './api';

function useAbortController() {
  const ref = useRef(null);
  const cancel = useCallback(() => {
    if (ref.current) { ref.current.abort(); ref.current = null; }
  }, []);
  const signal = useCallback(() => {
    cancel();
    ref.current = new AbortController();
    return ref.current.signal;
  }, [cancel]);
  useEffect(() => cancel, [cancel]);
  return { signal, cancel };
}

const FORMATS = [
  { id: 'avif', name: 'AVIF', note: 'Smallest size, needs fallback for older Safari' },
  { id: 'jpeg', name: 'JPEG', note: 'Universal support, larger files' },
  { id: 'webp', name: 'WebP', note: 'Good balance, wide support' },
  { id: 'png', name: 'PNG', note: 'Lossless, no quality loss' },
];
const FPS_OPTIONS = [24, 30, 60];

function formatSize(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function formatDuration(s) { const m = Math.floor(s / 60); const sec = Math.round(s % 60); return m > 0 ? `${m}m ${sec}s` : `${sec}s`; }
function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function SvgUpload() { return (<svg className="dropzone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>); }
function SvgPlay() { return (<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5V19L19 12L8 5Z"/></svg>); }
function SvgCopy() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>); }
function SvgDownload() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4V16M12 16L7 11M12 16L17 11M5 20H19"/></svg>); }
function SvgInfo() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>); }
function SvgCheck() { return (<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#050403" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>); }
function SvgSpinner() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>); }

/* ─── Frame Extraction Flow ─── */

function Dropzone({ onFile, uploading }) {
  const [dragging, setDragging] = useState(false);
  const ref = useRef(null);
  const handleDrop = useCallback((e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer?.files?.[0]; if (f) onFile(f); }, [onFile]);
  return (
    <div className="panel">
      <div className={`dropzone ${dragging ? 'dragging' : ''}`} onClick={() => ref.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={handleDrop}>
        <SvgUpload />
        <h3>{uploading ? 'Uploading…' : 'Drop a video file here'}</h3>
        <p>or click to browse – MP4, MOV, MKV, WEBM</p>
        <div className="formats">MP4 · MOV · MKV · WEBM</div>
      </div>
      <input ref={ref} type="file" accept="video/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
    </div>
  );
}

function VideoSummary({ job, thumbnail }) {
  const m = job.metadata;
  return (
    <div className="video-summary">
      <div className="video-thumb">{thumbnail ? <img src={`data:image/jpeg;base64,${thumbnail}`} alt="" /> : <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5V19L19 12L8 5Z"/></svg>}</div>
      <div className="video-meta">
        <div className="fname">{job.filename}</div>
        <div className="meta-chips">
          <span className="chip">{m.width}×{m.height}</span>
          <span className="chip">{formatDuration(m.duration)}</span>
          <span className="chip">{m.fps} fps</span>
          <span className="chip">{m.codec}</span>
          <span className="chip">{formatSize(m.size_bytes)}</span>
        </div>
      </div>
    </div>
  );
}

function TrimControls({ duration, trimStart, trimEnd, onChange }) {
  const pct = (v) => duration > 0 ? (v / duration) * 100 : 0;
  return (
    <div className="timeline-wrap">
      <div className="timeline-frame">
        <div className="trim-region" style={{ left: `${pct(trimStart)}%`, right: `${100 - pct(trimEnd)}%` }}>
          <div className="trim-handle left"><div className="grip" /></div>
          <div className="trim-handle right"><div className="grip" /></div>
        </div>
      </div>
      <div className="timeline-readout">
        <span>In: <span className="highlight">{trimStart.toFixed(1)}s</span></span>
        <span>Duration: <span className="highlight">{(trimEnd - trimStart).toFixed(1)}s</span></span>
        <span>Out: <span className="highlight">{trimEnd.toFixed(1)}s</span></span>
      </div>
      <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center' }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--bone-faint)', width: 70, flexShrink: 0 }}>TRIM START</span>
        <input type="range" min={0} max={duration} step={0.1} value={trimStart}
          onChange={(e) => onChange(Math.min(Number(e.target.value), trimEnd - 0.2), trimEnd)}
          style={{ flex: 1, accentColor: '#C4A35A' }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--bone-faint)', width: 30, flexShrink: 0 }}>END</span>
        <input type="range" min={0} max={duration} step={0.1} value={trimEnd}
          onChange={(e) => onChange(trimStart, Math.max(Number(e.target.value), trimStart + 0.2))}
          style={{ flex: 1, accentColor: '#C4A35A' }} />
      </div>
    </div>
  );
}

function SettingsPanel({ job, fps, setFps, trimStart, trimEnd, setTrim, fmt, setFmt, quality, setQuality, speed, setSpeed, fallback, setFallback, frameCount, onPreview, previewing, av1OK }) {
  return (
    <>
      <div className="panel">
        <VideoSummary job={job} thumbnail={job.thumbnail} />
        <TrimControls duration={job.metadata.duration} trimStart={trimStart} trimEnd={trimEnd} onChange={setTrim} />
      </div>
      <div className="panel">
        <div className="controls-grid">
          <div className="field">
            <label>FPS</label>
            <div className="segmented">{FPS_OPTIONS.map(f => (<button key={f} className={fps === f ? 'active' : ''} onClick={() => setFps(f)}>{f}</button>))}</div>
            <div className="frame-count-note">~<strong>{frameCount}</strong> frames at {fps}fps over {(trimEnd - trimStart).toFixed(1)}s</div>
          </div>
          <div className="field">
            <label>Format</label>
            <div className="radio-stack">{FORMATS.map(f => {
              const disabled = f.id === 'avif' && !av1OK;
              return (<div key={f.id} className={`radio-row ${fmt === f.id ? 'selected' : ''} ${disabled ? 'disabled' : ''}`} onClick={() => { if (!disabled) { setFmt(f.id); setQuality(f.id === 'avif' ? { crf: 30 } : f.id === 'jpeg' ? { qv: 5 } : f.id === 'webp' ? { quality: 80 } : {}); } }}><div className="rb"/><div className="rtext"><div className="rname">{f.name}{disabled && <span className="badge-warn">unavailable</span>}</div><div className="rnote">{disabled ? 'AV1 encoder not found' : f.note}</div></div></div>);
            })}</div>
          </div>
          {fmt === 'avif' && !av1OK && (<div className="prereq-banner error" style={{ marginBottom: 12, marginTop: -4 }}><span className="led" />AV1 encoder not found — AVIF will fail. Install libaom-av1 or choose another format.</div>)}
          <div className="field">
            <label>Quality</label>
            {fmt === 'avif' && (<div className="segmented">{[24, 30, 36].map(crf => (<button key={crf} className={quality.crf === crf ? 'active' : ''} onClick={() => setQuality({ crf })}>CRF {crf}</button>))}</div>)}
            {fmt === 'jpeg' && (<div className="segmented">{[2, 5, 8].map(qv => (<button key={qv} className={quality.qv === qv ? 'active' : ''} onClick={() => setQuality({ qv })}>Q:v {qv}</button>))}</div>)}
            {fmt === 'webp' && (<div className="segmented">{[90, 70, 50].map(q => (<button key={q} className={quality.quality === q ? 'active' : ''} onClick={() => setQuality({ quality: q })}>{q}%</button>))}</div>)}
            {fmt === 'png' && (<div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--bone-dim)', padding: '10px 0' }}>Lossless passthrough</div>)}
            {fmt === 'avif' && (<div className="field"><label>Speed</label><div className="segmented">{[{ v: 5, l: 'Fast' }, { v: 2, l: 'Balanced' }, { v: 0, l: 'Best' }].map(s => (<button key={s.v} className={speed === s.v ? 'active' : ''} onClick={() => setSpeed(s.v)}>{s.l}</button>))}</div><div className="tradeoff-note"><SvgInfo/><span>{{ 5: 'Fast: 3-10s/frame — quick previews and exports. Slightly larger files.', 2: 'Balanced: 15-30s/frame — good tradeoff for most use cases.', 0: 'Best: 30-120+s/frame — maximum compression, smallest files. Best for final delivery.' }[speed]}</span></div></div>)}
            {fmt !== 'png' && (<div className="checkbox-row" onClick={() => setFallback(!fallback)}><div className={`cb ${fallback ? 'checked' : ''}`}>{fallback && <SvgCheck/>}</div>Also export JPEG fallback</div>)}
            <div className="tradeoff-note mt-16"><SvgInfo/><span>{fmt === 'avif' && 'AVIF offers best compression but needs JPEG fallback for older browsers.'}{fmt === 'jpeg' && 'JPEG has universal browser support but produces larger files.'}{fmt === 'webp' && 'WebP balances size and compatibility.'}{fmt === 'png' && 'PNG is lossless — ideal when quality matters more than file size.'}</span></div>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button className="btn btn-primary" onClick={onPreview} disabled={previewing || (fmt === 'avif' && !av1OK)} title={fmt === 'avif' && !av1OK ? 'AV1 encoder unavailable' : ''}>
            {previewing && <SvgSpinner/>}{previewing ? 'Extracting samples…' : 'Preview Quality'}
          </button>
        </div>
      </div>
    </>
  );
}

function QualityPreview({ preview, selectedQuality, onSelect, onEncode, onBack, encoding, fmt }) {
  const presets = preview.samples || [];
  if (presets.length === 0) return (<div className="panel"><p>No preview data — video may be too short.</p></div>);

  const qualityLabels = presets.map(p => { const q = p.quality; if (q.crf !== undefined) return `CRF ${q.crf}`; if (q.qv !== undefined) return `Q:v ${q.qv}`; if (q.quality !== undefined) return `${q.quality}%`; return 'Default'; });

  return (
    <div className="panel">
      <div className="panel-title">Quality Preview</div>
      <div className="panel-sub">Compare quality levels. Click a column to select that quality for the full encode.</div>
      <div className="preview-grid">
        <div className="preview-header">Frame</div>
        {qualityLabels.map((l, qi) => (<div key={qi} className="preview-header">{l}</div>))}
        {(preview.sampleIndices || []).map((fi, row) => (<React.Fragment key={fi}>
          <div className="preview-row-label">Sample {row + 1}</div>
          {presets.map((preset, qi) => {
            const f = preset.frames?.[row];
            const sel = selectedQuality !== null && selectedQuality === qi;
            return (<div key={qi} className={`preview-cell ${sel ? 'selected' : ''}`} onClick={() => onSelect(qi)}>
              <span className="pick-tag">SELECTED</span>
              {f?.image ? <img src={`data:image/${fmt === 'jpeg' ? 'jpeg' : fmt};base64,${f.image}`} alt="" /> : <div style={{ height: 80, background: 'var(--char)' }} />}
              <div className="cell-info"><span>{f?.size ? formatSize(f.size) : '—'}</span></div>
            </div>);
          })}
        </React.Fragment>))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20, gap: 10 }}>
        <button className="btn btn-ghost" onClick={onBack} disabled={encoding}>Back</button>
        <button className="btn btn-primary" onClick={() => onEncode(selectedQuality !== null ? presets[selectedQuality].quality : null)} disabled={encoding}>
          {encoding && <SvgSpinner/>}{encoding ? 'Encoding…' : 'Confirm & Run Full Batch'}
        </button>
      </div>
    </div>
  );
}

function ProgressPanel({ jobId, onDone, onError }) {
  const [state, setState] = useState({ stage: 'extract', current: 0, total: 0 });
  const [startTime] = useState(Date.now());
  const [finished, setFinished] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    let timer;
    const poll = async () => {
      if (cancelled.current) return;
      try {
        const st = await api.pollJobStatus(jobId);
        const p = st.progress || {};
        setState(p);
        if (st.status === 'done' || p.stage === 'done') {
          setFinished(true);
          onDone();
          return;
        }
        if (st.status === 'failed') { onError('Job failed — check logs'); return; }
        timer = setTimeout(poll, 800);
      } catch { timer = setTimeout(poll, 1500); }
    };
    poll();
    return () => { cancelled.current = true; clearTimeout(timer); };
  }, [jobId, onDone, onError]);

  const total = state.total || 1;
  const pct = Math.min(100, Math.round((state.current / total) * 100));
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const stageLabel = state.stage === 'extract' ? 'Extracting frames from video…' : state.stage === 'encode' ? 'Encoding frames…' : state.stage === 'done' || finished ? 'Complete' : 'Processing…';
  const circumference = 2 * Math.PI * 50;
  const offset = circumference - (pct / 100) * circumference;

  return (
    <div className="panel">
      <div className="progress-block">
        <div className="progress-ring-wrap">
          <svg width="120" height="120" viewBox="0 0 120 120">
            <circle cx="60" cy="60" r="50" fill="none" stroke="var(--line)" strokeWidth="6" />
            <circle cx="60" cy="60" r="50" fill="none" stroke="var(--ember)" strokeWidth="6" strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round" style={{ transition: 'stroke-dashoffset 0.3s ease' }} />
          </svg>
          <div className="pct">{pct}%</div>
        </div>
        <div className="progress-status"><strong>{stageLabel}</strong>{state.total > 0 && !finished && ` — ${state.current} of ${state.total}`}</div>
        <div className="progress-eta">{finished ? 'Done' : `${elapsed}s`}</div>
      </div>
    </div>
  );
}

function ResultsPanel({ result, sourceSizeBytes, onReset }) {
  const [manifest, setManifest] = useState(null);
  useEffect(() => { if (result?.jobId) api.getManifest(result.jobId).then(setManifest).catch(() => {}); }, [result]);

  const outSize = result?.totalSizeBytes || 0;
  const hasSource = sourceSizeBytes > 0;
  const ratio = hasSource ? ((outSize / sourceSizeBytes) * 100).toFixed(1) : 0;
  const saved = sourceSizeBytes - outSize;

  return (
    <div className="panel">
      <div className="panel-title">Encoding Complete</div>
      <div className="panel-sub">{result?.frameCount || 0} frames · {result?.status}</div>
      <div className="results-grid" style={{ gridTemplateColumns: hasSource ? 'repeat(4, 1fr)' : 'repeat(2, 1fr)' }}>
        <div className="stat-card"><div className="stat-label">Frames</div><div className="stat-value ember">{result?.frameCount || 0}</div></div>
        <div className="stat-card"><div className="stat-label">Output Size</div><div className="stat-value">{formatSize(outSize)}</div></div>
        {hasSource && (<div className="stat-card"><div className="stat-label">Source Size</div><div className="stat-value">{formatSize(sourceSizeBytes)}</div></div>)}
        {hasSource && (<div className="stat-card"><div className="stat-label">Compression</div><div className="stat-value ember">{ratio}%</div>{saved > 0 && <div className="stat-delta">Saved {formatSize(saved)}</div>}</div>)}
      </div>
      {hasSource && (<div className="compare-bar-wrap">
        <div className="compare-row"><span className="clabel">Source</span><div className="compare-track"><div className="compare-fill before" /></div><span className="cval">{formatSize(sourceSizeBytes)}</span></div>
        <div className="compare-row"><span className="clabel">Output</span><div className="compare-track"><div className="compare-fill after" style={{ width: `${Math.min(100, Number(ratio))}%` }} /></div><span className="cval">{formatSize(outSize)}</span></div>
      </div>)}
      {manifest && (<div className="manifest-block">
        <button className="btn btn-ghost btn-sm copy-btn" onClick={() => navigator.clipboard.writeText(JSON.stringify(manifest, null, 2))}><SvgCopy/> Copy</button>
        <pre>{JSON.stringify(manifest, null, 2)}</pre>
      </div>)}
      <div className="head-actions mt-16" style={{ justifyContent: 'flex-end' }}>
        <a className="btn btn-ghost" href={api.downloadUrl(result.jobId)} download><SvgDownload/> Download .zip</a>
        <button className="btn btn-primary" onClick={onReset}>Run Another</button>
      </div>
    </div>
  );
}

function JobHistoryList({ jobs, onRerun }) {
  if (!jobs.length) return (<div className="panel"><div className="panel-title">No jobs yet</div><div className="panel-sub">Extract some frames first.</div></div>);
  return (
    <div className="panel">
      <div className="panel-title">Recent jobs</div>
      <div className="panel-sub">Re-run reuses cached frames — only the encode step runs again.</div>
      <div className="history-list">{jobs.map(j => (
        <div key={j.id} className="history-row">
          <div className="h-icon"><SvgPlay /></div>
          <div className="h-main">
            <div className="h-name">{j.source_filename} → {j.format} · {j.fps}fps</div>
            <div className="h-sub"><span>{j.frame_count} frames</span><span>{formatSize(j.total_size_bytes)}</span><span>{timeAgo(j.created_at)}</span></div>
          </div>
          <div className="h-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => onRerun(j)}>Re-run</button>
            {j.manifest_path && <a className="btn btn-ghost btn-sm" href={api.downloadUrl(j.id)} download>Download</a>}
          </div>
        </div>
      ))}</div>
    </div>
  );
}

/* ─── Quick Trim ─── */

function TrimExport() {
  const [file, setFile] = useState(null);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [duration, setDuration] = useState(0);
  const [fps, setFps] = useState(24);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const videoRef = useRef(null);

  const handleFile = (f) => {
    setError(null);
    setFile(f);
    const url = URL.createObjectURL(f);
    const vid = document.createElement('video');
    vid.preload = 'metadata';
    vid.onloadedmetadata = () => {
      setDuration(vid.duration);
      setTrimEnd(vid.duration);
      URL.revokeObjectURL(url);
    };
    vid.src = url;
    vid.load();
  };

  const handleDrop = (e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f?.type.startsWith('video/')) handleFile(f); else setError('Please drop a video file'); };
  const handleDrag = (e) => { e.preventDefault(); setDragging(true); };

  const doExport = async () => {
    if (!file || trimEnd <= trimStart) { setError('Invalid trim range'); return; }
    setExporting(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('fps', String(fps));
      form.append('trimStart', String(trimStart));
      form.append('trimEnd', String(trimEnd));
      const res = await fetch('/api/trim-export', { method: 'POST', body: form });
      if (!res.ok) { const txt = await res.text(); throw new Error(txt); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name.replace(/\.[^.]+$/, '') + '-trimmed-frames.zip';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) { setError(err.message); }
    setExporting(false);
  };

  const frameCount = trimEnd > trimStart ? Math.floor((trimEnd - trimStart) * fps) : 0;

  return (
    <div className="panel">
      <div className="panel-title">Quick Trim & Export</div>
      <div className="panel-sub">Trim a video and download raw PNG frames as a ZIP.</div>
      <input id="trim-input" type="file" accept="video/*" style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
      {!file ? (
        <div className={`dropzone ${dragging ? 'dragging' : ''}`}
          onDrop={handleDrop} onDragOver={handleDrag} onDragLeave={() => setDragging(false)}
          onClick={() => document.getElementById('trim-input')?.click()}>
          <SvgUpload /><span>{dragging ? 'Drop video here' : 'Drop a video or click to browse'}</span>
        </div>
      ) : (
        <>
          <div className="file-badge">{file.name} · {formatDuration(duration)}</div>
          <div className="trim-row">
            <label>Start<output>{formatDuration(trimStart)}</output>
              <input type="range" min="0" max={duration || 1} step="0.1" value={trimStart} onChange={(e) => setTrimStart(Math.min(Number(e.target.value), trimEnd - 0.5))} />
            </label>
            <label>End<output>{formatDuration(trimEnd)}</output>
              <input type="range" min="0" max={duration || 1} step="0.1" value={trimEnd} onChange={(e) => setTrimEnd(Math.max(Number(e.target.value), trimStart + 0.5))} />
            </label>
          </div>
          <label className="fps-row">FPS
            <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>{FPS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}</select>
          </label>
          <div className="frame-count">{frameCount} frames · {formatSize(frameCount * 100 * 1024)} estimated</div>
          {error && <div className="prereq-banner error"><span className="led" />{error}</div>}
          <button className="btn btn-primary" onClick={doExport} disabled={exporting || frameCount < 1}>
            {exporting ? 'Exporting…' : <><SvgDownload /> Export Trimmed Frames</>}
          </button>
        </>
      )}
    </div>
  );
}

/* ─── Compress / Convert Video ─── */

const COMPRESS_FORMATS = [
  { id: '', name: 'Keep original', note: 'Same container as source' },
  { id: 'mp4', name: 'MP4', note: 'H.264 + AAC' },
  { id: 'webm', name: 'WebM', note: 'VP9 + Opus' },
  { id: 'mkv', name: 'MKV', note: 'H.264 + AAC' },
  { id: 'mov', name: 'MOV', note: 'H.264 + AAC' },
  { id: 'avi', name: 'AVI', note: 'H.264 + AAC' },
];

const PRESETS = [
  { id: 'slow', name: 'Max Compression', note: 'Smallest size, slowest encode' },
  { id: 'medium', name: 'Balanced', note: 'Good size/speed tradeoff' },
  { id: 'fast', name: 'Fast', note: 'Quick encode, larger output' },
];

function CompressPanel() {
  const [file, setFile] = useState(null);
  const [meta, setMeta] = useState(null);
  const [format, setFormat] = useState('');
  const [crf, setCrf] = useState(23);
  const [preset, setPreset] = useState('medium');
  const [keepAudio, setKeepAudio] = useState(true);
  const [compressing, setCompressing] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [stage, setStage] = useState('idle');
  const [progress, setProgress] = useState({ current: 0, total: 100 });
  const progressRef = useRef(null);
  const sourceExt = meta ? '.' + (meta.filename?.split('.').pop() || 'mp4') : '.mp4';

  useEffect(() => {
    return () => { if (progressRef.current) clearInterval(progressRef.current); };
  }, []);

  const handleFile = (f) => {
    if (!f.type.startsWith('video/')) { setError('Please select a video file'); return; }
    setError(null); setResult(null);
    setFile(f); setMeta({ filename: f.name, size: f.size });
  };

  const reset = () => { setFile(null); setMeta(null); setResult(null); setError(null); setStage('idle'); };

  const pollProgress = (jobId) => {
    progressRef.current = setInterval(async () => {
      try {
        const st = await api.pollJobStatus(jobId);
        const p = st.progress || {};
        setProgress(p);
        if (p.stage === 'done' || st.status === 'done') {
          clearInterval(progressRef.current); progressRef.current = null;
          const outExt = format || (st.source_filename?.split('.').pop() || 'mp4');
          setResult({
            jobId, status: 'done',
            sourceSizeBytes: st.source_size_bytes || 0,
            outputSizeBytes: st.total_size_bytes || 0,
            outputFilename: (st.source_filename?.replace(/\.[^.]+$/, '') || 'video') + '-compressed.' + outExt,
          });
          setStage('done'); setCompressing(false);
        }
        if (st.status === 'failed') {
          clearInterval(progressRef.current); progressRef.current = null;
          setError('Compression failed'); setStage('idle'); setCompressing(false);
        }
      } catch {}
    }, 800);
  };

  const doCompress = async () => {
    if (!file) return;
    setCompressing(true); setError(null); setStage('compressing'); setProgress({ current: 0, total: 100 });
    try {
      const data = await api.compressVideo(file, { format, crf, preset, keepAudio });
      pollProgress(data.jobId);
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message);
      setStage('idle'); setCompressing(false);
    }
  };

  const pct = progress.total > 0 ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : 0;
  const reduction = result && result.sourceSizeBytes > 0 ? (((result.sourceSizeBytes - result.outputSizeBytes) / result.sourceSizeBytes) * 100).toFixed(1) : 0;
  const saved = result ? result.sourceSizeBytes - result.outputSizeBytes : 0;

  if (stage === 'done' && result) {
    return (
      <div className="panel">
        <div className="panel-title">Compression Complete</div>
        <div className="panel-title-sub">{result.outputFilename}</div>
        <div className="results-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="stat-card"><div className="stat-label">Source</div><div className="stat-value">{formatSize(result.sourceSizeBytes)}</div></div>
          <div className="stat-card"><div className="stat-label">Output</div><div className="stat-value ember">{formatSize(result.outputSizeBytes)}</div></div>
          <div className="stat-card"><div className="stat-label">Reduction</div><div className="stat-value ember">{reduction}%</div>{saved > 0 && <div className="stat-delta">–{formatSize(saved)}</div>}</div>
        </div>
        {result.sourceSizeBytes > 0 && (
          <div className="compare-bar-wrap">
            <div className="compare-row"><span className="clabel">Source</span><div className="compare-track"><div className="compare-fill before" /></div><span className="cval">{formatSize(result.sourceSizeBytes)}</span></div>
            <div className="compare-row"><span className="clabel">Output</span><div className="compare-track"><div className="compare-fill after" style={{ width: `${Math.min(100, (result.outputSizeBytes / result.sourceSizeBytes) * 100)}%` }} /></div><span className="cval">{formatSize(result.outputSizeBytes)}</span></div>
          </div>
        )}
        <div className="head-actions mt-16" style={{ justifyContent: 'flex-end' }}>
          <a className="btn btn-ghost" href={api.compressedUrl(result.jobId)} download><SvgDownload /> Download</a>
          <button className="btn btn-primary" onClick={reset}>Compress Another</button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-title">Compress / Convert Video</div>
      <div className="panel-title-sub">Drop a video to reduce size or change format.</div>
      <input id="compress-input" type="file" accept="video/*" style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
      {!file ? (
        <div className={`dropzone ${dragging ? 'dragging' : ''} dropzone-sm`}
          onClick={() => document.getElementById('compress-input')?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer?.files?.[0]; if (f) handleFile(f); }}>
          <SvgUpload /><h3>Drop a video file here</h3><p>or click to browse – MP4, MOV, MKV, WEBM</p>
        </div>
      ) : (
        <>
          <div className="file-badge">
            <span>{meta?.filename} · {formatSize(meta?.size)}</span>
            <button className="btn btn-ghost btn-xs" onClick={reset}>Change</button>
          </div>
          <div className="compress-layout">
            <div className="compress-left">
              <label className="field-label">Format</label>
              <div className="segmented">{COMPRESS_FORMATS.map(f => {
                const label = f.id ? f.name : `Original (${sourceExt})`;
                return <button key={f.id} className={format === f.id ? 'active' : ''} onClick={() => setFormat(f.id)} title={f.note}>{label}</button>;
              })}</div>
              <label className="field-label mt-12">Preset</label>
              <div className="segmented">{PRESETS.map(p => (
                <button key={p.id} className={preset === p.id ? 'active' : ''} onClick={() => setPreset(p.id)} title={p.note}>{p.name}</button>
              ))}</div>
            </div>
            <div className="compress-right">
              <label className="field-label">CRF: <strong>{crf}</strong></label>
              <input type="range" min="18" max="51" value={crf} onChange={(e) => setCrf(Number(e.target.value))} />
              <div className="crf-labels"><span>Better</span><span>Smaller</span></div>
              <div className="checkbox-row mt-12" onClick={() => setKeepAudio(!keepAudio)}>
                <div className={`cb ${keepAudio ? 'checked' : ''}`}>{keepAudio && <SvgCheck />}</div>Audio
              </div>
            </div>
          </div>
          {stage === 'compressing' && (
            <div className="compress-progress">
              <div className="compress-progress-track"><div className="compress-progress-fill" style={{ width: `${pct}%` }} /></div>
              <span className="compress-progress-label">{pct}% · Compressing…</span>
            </div>
          )}
          {error && <div className="prereq-banner error" style={{ marginTop: 8 }}><span className="led" />{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn btn-primary" onClick={doCompress} disabled={compressing}>
              {compressing ? <SvgSpinner /> : null}{compressing ? 'Compressing…' : 'Compress'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ─── Image Converter ─── */

function ImageConverter() {
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [fmt, setFmt] = useState('jpeg');
  const [quality, setQuality] = useState({ qv: 5 });
  const [resize, setResize] = useState('');
  const [converting, setConverting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const { signal: abortSignal, cancel: cancelConvert } = useAbortController();
  const previewUrlRef = useRef(null);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  const clearFile = useCallback(() => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    setFile(null); setPreviewUrl(null); setResult(null); setError(null);
  }, []);

  const handleFile = useCallback((f) => {
    if (!f.type.startsWith('image/')) { setError('Please select a valid image file'); return; }
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const url = URL.createObjectURL(f);
    previewUrlRef.current = url;
    setFile(f); setPreviewUrl(url); setResult(null); setError(null);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  }, [handleFile]);

  const doConvert = async () => {
    if (!file) return;
    setConverting(true);
    setError(null);
    try { setResult(await api.convertImage(file, { fmt, quality, resize }, abortSignal())); }
    catch (e) { if (e.name !== 'AbortError') setError(e.message); }
    setConverting(false);
  };

  const downloadData = () => {
    if (!result) return;
    const ext = { avif: 'avif', jpeg: 'jpg', webp: 'webp', png: 'png' }[fmt];
    const a = document.createElement('a');
    a.href = `data:image/${fmt === 'jpeg' ? 'jpeg' : fmt};base64,${result.image}`;
    a.download = `converted.${ext}`;
    a.click();
  };

  return (
    <>
      <div className="panel">
        <div className={`dropzone ${dragging ? 'dragging' : ''}`}
          onClick={() => !file && document.getElementById('img-input')?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          style={{ padding: file ? 16 : 56, cursor: file ? 'default' : 'pointer', border: file ? '1px solid var(--line)' : undefined  }}>
          {!file ? (<><SvgUpload /><h3>Drop an image here</h3><p>or click to browse – PNG, JPEG, WebP, AVIF</p></>) : (
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              {previewUrl && <img src={previewUrl} alt="" style={{ width: 80, height: 60, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--line)' }} />}
              <div style={{ flex: 1, textAlign: 'left' }}><div style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--bone)' }}>{file.name}</div><div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--bone-faint)', marginTop: 2 }}>{formatSize(file.size)}</div></div>
              <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); clearFile(); }}>Remove</button>
            </div>
          )}
        </div>
        <input id="img-input" type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
      </div>

      {file && (<div className="panel">
        <div className="controls-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="field"><label>Output Format</label><div className="segmented">{FORMATS.map(f => (<button key={f.id} className={fmt === f.id ? 'active' : ''} onClick={() => { setFmt(f.id); setQuality(f.id === 'avif' ? { crf: 30 } : f.id === 'jpeg' ? { qv: 5 } : f.id === 'webp' ? { quality: 80 } : {}); }}>{f.name}</button>))}</div></div>
          <div className="field"><label>Quality</label>
            {fmt === 'avif' && (<div className="segmented">{[24, 30, 36].map(crf => (<button key={crf} className={quality.crf === crf ? 'active' : ''} onClick={() => setQuality({ crf })}>CRF {crf}</button>))}</div>)}
            {fmt === 'jpeg' && (<div className="segmented">{[2, 5, 8].map(qv => (<button key={qv} className={quality.qv === qv ? 'active' : ''} onClick={() => setQuality({ qv })}>Q:v {qv}</button>))}</div>)}
            {fmt === 'webp' && (<div className="segmented">{[90, 70, 50].map(q => (<button key={q} className={quality.quality === q ? 'active' : ''} onClick={() => setQuality({ quality: q })}>{q}%</button>))}</div>)}
            {fmt === 'png' && (<div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--bone-dim)', padding: '10px 0' }}>Lossless</div>)}
          </div>
          <div className="field"><label>Resize</label><div className="segmented">{['', '1920:-1', '1280:-1', '800:-1', '400:-1'].map(r => (<button key={r || 'none'} className={resize === r ? 'active' : ''} onClick={() => setResize(r)}>{r || 'Original'}</button>))}</div></div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20, gap: 10 }}>
          <button className="btn btn-primary" onClick={doConvert} disabled={converting}>
            {converting && <SvgSpinner/>}{converting ? 'Converting…' : 'Convert'}
          </button>
        </div>
      </div>)}

      {error && (<div className="panel"><div className="panel-title" style={{ color: 'var(--danger)' }}>Error</div><div className="panel-sub">{error}</div></div>)}

      {result && (<div className="panel">
        <div className="panel-title">Conversion Complete</div>
        <div className="panel-sub">Output: {formatSize(result.size)} {file && <span>(from {formatSize(file.size)})</span>}</div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginTop: 8 }}>
          <img src={`data:image/${fmt === 'jpeg' ? 'jpeg' : fmt};base64,${result.image}`} alt="" style={{ maxWidth: 200, maxHeight: 120, borderRadius: 6, border: '1px solid var(--line)' }} />
          <div><div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--bone-dim)', marginBottom: 4 }}>{fmt.toUpperCase()} · {formatSize(result.size)}</div><button className="btn btn-primary" onClick={downloadData}><SvgDownload/> Download</button></div>
        </div>
      </div>)}
    </>
  );
}

/* ─── Main App ─── */

export default function App() {
  const [page, setPage] = useState('new');
  const [health, setHealth] = useState(null);
  const [jobs, setJobs] = useState([]);

  const [job, setJob] = useState(null);
  const [sourceSizeBytes, setSourceSizeBytes] = useState(0);
  const [step, setStep] = useState(0);
  const [fps, setFps] = useState(24);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [fmt, setFmt] = useState('avif');
  const [quality, setQuality] = useState({ crf: 30 });
  const [speed, setSpeed] = useState(2);
  const [fallback, setFallback] = useState(false);

  const [preview, setPreview] = useState(null);
  const [selectedQualityIdx, setSelectedQualityIdx] = useState(null);
  const [result, setResult] = useState(null);

  const [uploading, setUploading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [encoding, setEncoding] = useState(false);
  const [error, setError] = useState(null);

  const abortRef = useRef(null);
  const cancelRequest = useCallback(() => {
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
  }, []);

  const loadJobs = useCallback(async () => { try { setJobs(await api.getJobs()); } catch {} }, []);

  useEffect(() => {
    api.healthCheck().then(setHealth).catch(() => setHealth({ status: 'error', ffmpeg: { ffmpeg: false } }));
    loadJobs();
  }, [loadJobs]);

  const frameCount = job ? Math.floor((trimEnd - trimStart) * fps) : 0;
  const steps = ['Upload', 'Trim & Settings', 'Preview', 'Encode', 'Results'];

  const doUpload = async (file) => {
    cancelRequest();
    setUploading(true);
    setError(null);
    abortRef.current = new AbortController();
    try {
      const data = await api.uploadVideo(file, abortRef.current.signal);
      setJob(data);
      setSourceSizeBytes(data.metadata?.size_bytes || 0);
      setTrimEnd(data.metadata.duration);
      setStep(1);
    } catch (err) { if (err.name !== 'AbortError') setError(err.message); }
    setUploading(false);
  };

  const doPreview = async () => {
    if (!job) { console.warn('doPreview: no job'); return; }
    console.log('doPreview  jobId=%s  fmt=%s  trim=%.2f-%.2f  fps=%s', job.jobId, fmt, trimStart, trimEnd, fps);
    cancelRequest();
    setPreviewing(true);
    setError(null);
    abortRef.current = new AbortController();
    try {
      setPreview(null);
      setSelectedQualityIdx(null);
      console.log('doPreview  calling api.runPreview...');
      const data = await api.runPreview(job.jobId, { fps, trimStart, trimEnd, fmt, speed }, abortRef.current.signal);
      setPreview(data);
      setStep(2);
    } catch (err) { if (err.name !== 'AbortError') { console.error('doPreview  error:', err.message); setError(err.message); } else { console.log('doPreview  aborted'); } }
    setPreviewing(false);
  };

  const doEncode = async (chosenQuality) => {
    if (!job) return;
    cancelRequest();
    setEncoding(true);
    setError(null);
    abortRef.current = new AbortController();
    const q = chosenQuality || quality;
    setStep(3);
    try {
      const data = await api.runEncode(job.jobId, {
        fps, trimStart, trimEnd, fmt, quality: q, speed, fallback: fallback && fmt !== 'jpeg',
      }, abortRef.current.signal);
      setResult(data);
      setStep(4);
      loadJobs();
    } catch (err) { if (err.name !== 'AbortError') { setError(err.message); setStep(1); } }
    setEncoding(false);
  };

  const doRerun = (j) => {
    setJob({ jobId: j.id, filename: j.source_filename, metadata: { width: j.width, height: j.height, duration: j.duration, fps: j.fps, codec: j.codec || 'unknown', size_bytes: j.source_size_bytes } });
    setSourceSizeBytes(j.source_size_bytes || 0);
    setFps(j.fps || 24);
    setTrimStart(j.trim_start || 0);
    setTrimEnd(j.trim_end || j.duration || 0);
    setFmt(j.format || 'avif');
    setQuality(j.quality || { crf: 30 });
    setPage('new');
    setStep(1);
  };

  const resetJob = () => {
    cancelRequest();
    setJob(null); setSourceSizeBytes(0); setStep(0); setPreview(null);
    setSelectedQualityIdx(null); setResult(null); setError(null);
  };

  const handleEncodeDone = useCallback(async () => {
    if (!job) return;
    try {
      const st = await api.pollJobStatus(job.jobId);
      setResult({
        jobId: job.jobId,
        status: st.status || 'done',
        frameCount: st.frame_count || 0,
        totalSizeBytes: st.total_size_bytes || 0,
      });
      setStep(4);
    } catch {
      setStep(4);
    }
    loadJobs();
  }, [job, loadJobs]);

  const handleEncodeError = useCallback((msg) => {
    setError(msg);
    setStep(1);
  }, []);

  useEffect(() => {
    if (error) {
      const id = setTimeout(() => setError(null), 6000);
      return () => clearTimeout(id);
    }
  }, [error]);

  const statusOk = health?.status === 'ok';
  const ffmpegOK = health?.ffmpeg?.ffmpeg;
  const av1OK = health?.ffmpeg?.av1_encoder;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><svg viewBox="0 0 32 32" fill="none"><path d="M16 2 L27 9 V23 L16 30 L5 23 V9 Z" stroke="#C4A35A" strokeWidth="1.4" fill="none"/><path d="M16 8 L21 12 L16 24 L11 12 Z" fill="#C4A35A" opacity="0.85"/></svg></div>
          <div className="brand-text">FrameForge<span>Solus Ryuu Tools</span></div>
        </div>
        <nav className="nav-group">
          <span className="nav-label">Workspace</span>
          <div className={`nav-item ${page === 'new' ? 'active' : ''}`} onClick={() => { setPage('new'); setError(null); }}><span className="dot" />Frame Extraction</div>
          <div className={`nav-item ${page === 'image' ? 'active' : ''}`} onClick={() => { setPage('image'); setError(null); }}><span className="dot" />Image Converter</div>
          <div className={`nav-item ${page === 'trim' ? 'active' : ''}`} onClick={() => { setPage('trim'); setError(null); }}><span className="dot" />Quick Trim</div>
          <div className={`nav-item ${page === 'compress' ? 'active' : ''}`} onClick={() => { setPage('compress'); setError(null); }}><span className="dot" />Compress / Convert</div>
          <div className={`nav-item ${page === 'history' ? 'active' : ''}`} onClick={() => { setPage('history'); setError(null); loadJobs(); }}><span className="dot" />Job History</div>
        </nav>
        <div className="sidebar-footer">
          <div className="status-pip"><span className={`led ${statusOk ? '' : 'error'}`} />{ffmpegOK ? 'ffmpeg ✓' : 'ffmpeg ✗'}{av1OK ? ' · av1 ✓' : ''}</div>
          <div style={{ marginTop: 6 }}>local · v0.1</div>
        </div>
      </aside>

      <main className="main">
        <div className="page-head">
          <div>
            <span className="eyebrow">{page === 'image' ? 'Image Conversion' : page === 'history' ? 'Job History' : page === 'trim' ? 'Quick Trim' : page === 'compress' ? 'Compress / Convert' : 'Frame Extraction & Compression'}</span>
            <h1>{page === 'image' ? 'Image Converter' : page === 'history' ? 'Job History' : page === 'trim' ? 'Quick Trim & Export' : page === 'compress' ? 'Compress / Convert' : 'New Job'}</h1>
          </div>
          <div className="head-actions">
            {page === 'new' && step === 0 && <button className="btn btn-primary" disabled={uploading} onClick={() => document.getElementById('video-input')?.click()}><SvgUpload/>{uploading ? 'Uploading…' : 'Upload Video'}</button>}
            {page === 'new' && step > 0 && step < 4 && <button className="btn btn-ghost" onClick={resetJob}>Start Over</button>}
          </div>
        </div>

        <input id="video-input" type="file" accept="video/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) doUpload(f); }} />

        {!statusOk && ffmpegOK === false && (<div className="prereq-banner error"><span className="led" />ffmpeg not found — install ffmpeg and ffprobe</div>)}

        {error && (<div className="prereq-banner error" style={{ marginBottom: 12 }}><span className="led" />{error}</div>)}

        {page === 'image' && <ImageConverter />}
        {page === 'trim' && <TrimExport />}
        {page === 'compress' && <CompressPanel />}
        {page === 'history' && <JobHistoryList jobs={jobs} onRerun={doRerun} />}

        {page === 'new' && (<>
          <div className="stepper">{steps.map((s, i) => (<React.Fragment key={s}>{i > 0 && <div className="step-line" />}<div className={`step ${i < step ? 'done' : i === step ? 'active' : ''}`}><span className="num">{i < step ? '✓' : i + 1}</span> {s}</div></React.Fragment>))}</div>

          {step === 0 && <Dropzone onFile={doUpload} uploading={uploading} />}

          {step === 1 && job && <SettingsPanel job={job} fps={fps} setFps={setFps} trimStart={trimStart} trimEnd={trimEnd} setTrim={(s, e) => { setTrimStart(s); setTrimEnd(e); }} fmt={fmt} setFmt={setFmt} quality={quality} setQuality={setQuality} speed={speed} setSpeed={setSpeed} fallback={fallback} setFallback={setFallback} frameCount={frameCount} onPreview={doPreview} previewing={previewing} av1OK={av1OK} />}

          {step === 2 && preview && <QualityPreview preview={preview} selectedQuality={selectedQualityIdx} onSelect={setSelectedQualityIdx} onEncode={doEncode} onBack={() => setStep(1)} encoding={encoding} fmt={fmt} />}

          {step === 3 && <ProgressPanel jobId={job?.jobId} onDone={handleEncodeDone} onError={handleEncodeError} />}

          {step === 4 && result && <ResultsPanel result={result} sourceSizeBytes={sourceSizeBytes} onReset={resetJob} />}
        </>)}
      </main>
    </div>
  );
}

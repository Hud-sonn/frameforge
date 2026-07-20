import React, { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';
import * as api from './api';

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

function VideoSummary({ job }) {
  const m = job.metadata;
  return (
    <div className="video-summary">
      <div className="video-thumb"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5V19L19 12L8 5Z"/></svg></div>
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

function SettingsPanel({ job, fps, setFps, trimStart, trimEnd, setTrim, fmt, setFmt, quality, setQuality, fallback, setFallback, frameCount, onPreview, previewing }) {
  return (
    <>
      <div className="panel">
        <VideoSummary job={job} />
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
            <div className="radio-stack">{FORMATS.map(f => (<div key={f.id} className={`radio-row ${fmt === f.id ? 'selected' : ''}`} onClick={() => { setFmt(f.id); setQuality(f.id === 'avif' ? { crf: 30 } : f.id === 'jpeg' ? { qv: 5 } : f.id === 'webp' ? { quality: 80 } : {}); }}><div className="rb"/><div className="rtext"><div className="rname">{f.name}</div><div className="rnote">{f.note}</div></div></div>))}</div>
          </div>
          <div className="field">
            <label>Quality</label>
            {fmt === 'avif' && (<div className="segmented">{[24, 30, 36].map(crf => (<button key={crf} className={quality.crf === crf ? 'active' : ''} onClick={() => setQuality({ crf })}>CRF {crf}</button>))}</div>)}
            {fmt === 'jpeg' && (<div className="segmented">{[2, 5, 8].map(qv => (<button key={qv} className={quality.qv === qv ? 'active' : ''} onClick={() => setQuality({ qv })}>Q:v {qv}</button>))}</div>)}
            {fmt === 'webp' && (<div className="segmented">{[90, 70, 50].map(q => (<button key={q} className={quality.quality === q ? 'active' : ''} onClick={() => setQuality({ quality: q })}>{q}%</button>))}</div>)}
            {fmt === 'png' && (<div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--bone-dim)', padding: '10px 0' }}>Lossless passthrough</div>)}
            {fmt !== 'png' && (<div className="checkbox-row" onClick={() => setFallback(!fallback)}><div className={`cb ${fallback ? 'checked' : ''}`}>{fallback && <SvgCheck/>}</div>Also export JPEG fallback</div>)}
            <div className="tradeoff-note mt-16"><SvgInfo/><span>{fmt === 'avif' && 'AVIF offers best compression but needs JPEG fallback for older browsers.'}{fmt === 'jpeg' && 'JPEG has universal browser support but produces larger files.'}{fmt === 'webp' && 'WebP balances size and compatibility.'}{fmt === 'png' && 'PNG is lossless — ideal when quality matters more than file size.'}</span></div>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button className="btn btn-primary" onClick={onPreview} disabled={previewing}>
            {previewing && <SvgSpinner/>}{previewing ? 'Extracting samples…' : 'Preview Quality'}
          </button>
        </div>
      </div>
    </>
  );
}

function QualityPreview({ preview, selectedQuality, onSelect, onEncode, onBack, encoding }) {
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
              {f?.image ? <img src={`data:image/jpeg;base64,${f.image}`} alt="" /> : <div style={{ height: 80, background: 'var(--char)' }} />}
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
        <a className="btn btn-ghost" href={`/api/jobs/${result.jobId}/download`} download><SvgDownload/> Download .zip</a>
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
            {j.manifest_path && <a className="btn btn-ghost btn-sm" href={`/api/jobs/${j.id}/download`}>Open</a>}
          </div>
        </div>
      ))}</div>
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

  const handleFile = useCallback((f) => { setFile(f); setPreviewUrl(URL.createObjectURL(f)); setResult(null); setError(null); }, []);

  const doConvert = async () => {
    if (!file) return;
    setConverting(true);
    setError(null);
    try { setResult(await api.convertImage(file, { fmt, quality, resize })); }
    catch (e) { setError(e.message); }
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
        <div className={`dropzone`} onClick={() => !file && document.getElementById('img-input')?.click()}
          style={{ padding: file ? 16 : 56, cursor: file ? 'default' : 'pointer', border: file ? '1px solid var(--line)' : undefined  }}>
          {!file ? (<><SvgUpload /><h3>Drop an image here</h3><p>or click to browse – PNG, JPEG, WebP, AVIF</p></>) : (
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              {previewUrl && <img src={previewUrl} alt="" style={{ width: 80, height: 60, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--line)' }} />}
              <div style={{ flex: 1, textAlign: 'left' }}><div style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--bone)' }}>{file.name}</div><div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--bone-faint)', marginTop: 2 }}>{formatSize(file.size)}</div></div>
              <button className="btn btn-ghost btn-sm" onClick={() => { setFile(null); setPreviewUrl(null); setResult(null); }}>Remove</button>
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
          <button className="btn btn-primary" onClick={doConvert} disabled={converting}>{converting ? 'Converting…' : 'Convert'}</button>
        </div>
      </div>)}

      {error && (<div className="panel"><div className="panel-title" style={{ color: 'var(--danger)' }}>Error</div><div className="panel-sub">{error}</div></div>)}

      {result && (<div className="panel">
        <div className="panel-title">Conversion Complete</div>
        <div className="panel-sub">Output: {formatSize(result.size)}</div>
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
  const [fallback, setFallback] = useState(false);

  const [preview, setPreview] = useState(null);
  const [selectedQualityIdx, setSelectedQualityIdx] = useState(null);
  const [result, setResult] = useState(null);

  const [uploading, setUploading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [encoding, setEncoding] = useState(false);
  const [error, setError] = useState(null);

  const loadJobs = useCallback(async () => { try { setJobs(await api.getJobs()); } catch {} }, []);

  useEffect(() => {
    api.healthCheck().then(setHealth).catch(() => setHealth({ status: 'error', ffmpeg: { ffmpeg: false } }));
    loadJobs();
  }, [loadJobs]);

  const frameCount = job ? Math.floor((trimEnd - trimStart) * fps) : 0;
  const steps = ['Upload', 'Trim & Settings', 'Preview', 'Encode', 'Results'];

  const doUpload = async (file) => {
    setUploading(true);
    setError(null);
    try {
      const data = await api.uploadVideo(file);
      setJob(data);
      setSourceSizeBytes(data.metadata?.size_bytes || 0);
      setTrimEnd(data.metadata.duration);
      setStep(1);
    } catch (err) { setError(err.message); }
    setUploading(false);
  };

  const doPreview = async () => {
    if (!job) return;
    setPreviewing(true);
    setError(null);
    try {
      setPreview(null);
      setSelectedQualityIdx(null);
      const data = await api.runPreview(job.jobId, { fps, trimStart, trimEnd, fmt });
      setPreview(data);
      setStep(2);
    } catch (err) { setError(err.message); }
    setPreviewing(false);
  };

  const doEncode = async (chosenQuality) => {
    if (!job) return;
    setEncoding(true);
    setError(null);
    const q = chosenQuality || quality;
    setStep(3);
    try {
      const data = await api.runEncode(job.jobId, {
        fps, trimStart, trimEnd, fmt, quality: q, fallback: fallback && fmt !== 'jpeg',
      });
      setResult(data);
      setStep(4);
      loadJobs();
    } catch (err) { setError(err.message); setStep(1); }
    setEncoding(false);
  };

  const doRerun = (j) => {
    setJob({ jobId: j.id, filename: j.source_filename, metadata: { width: j.width, height: j.height, duration: j.duration, fps: j.fps, size_bytes: j.source_size_bytes } });
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
    setJob(null); setSourceSizeBytes(0); setStep(0); setPreview(null);
    setSelectedQualityIdx(null); setResult(null); setError(null);
  };

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
            <span className="eyebrow">{page === 'image' ? 'Image Conversion' : page === 'history' ? 'Job History' : 'Frame Extraction & Compression'}</span>
            <h1>{page === 'image' ? 'Image Converter' : page === 'history' ? 'Job History' : 'New Job'}</h1>
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
        {page === 'history' && <JobHistoryList jobs={jobs} onRerun={doRerun} />}

        {page === 'new' && (<>
          <div className="stepper">{steps.map((s, i) => (<React.Fragment key={s}>{i > 0 && <div className="step-line" />}<div className={`step ${i < step ? 'done' : i === step ? 'active' : ''}`}><span className="num">{i < step ? '✓' : i + 1}</span> {s}</div></React.Fragment>))}</div>

          {step === 0 && <Dropzone onFile={doUpload} uploading={uploading} />}

          {step === 1 && job && <SettingsPanel job={job} fps={fps} setFps={setFps} trimStart={trimStart} trimEnd={trimEnd} setTrim={(s, e) => { setTrimStart(s); setTrimEnd(e); }} fmt={fmt} setFmt={setFmt} quality={quality} setQuality={setQuality} fallback={fallback} setFallback={setFallback} frameCount={frameCount} onPreview={doPreview} previewing={previewing} />}

          {step === 2 && preview && <QualityPreview preview={preview} selectedQuality={selectedQualityIdx} onSelect={setSelectedQualityIdx} onEncode={doEncode} onBack={() => setStep(1)} encoding={encoding} />}

          {step === 3 && <ProgressPanel jobId={job?.jobId} onDone={() => {}} onError={(msg) => { setError(msg); setStep(1); }} />}

          {step === 4 && result && <ResultsPanel result={result} sourceSizeBytes={sourceSizeBytes} onReset={resetJob} />}
        </>)}
      </main>
    </div>
  );
}

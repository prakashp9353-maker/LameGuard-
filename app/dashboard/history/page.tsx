'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, CheckCircle2, Clock3, Download, Loader2, Search, Trash2, XCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { generatePredictionReport, type ReportImage, type ReportRecord } from '@/lib/predictions/report'

const STORAGE_BUCKET = process.env.NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET || 'lameguard-images'
const PAGE_SIZE = 100

type Prediction = ReportRecord & { user_id: string }

function label(value: Prediction['predicted_class']) {
  if (value === 'limping-cow') return 'Lameness Detected'
  if (value === 'healthy-cow') return 'Lameness Not Detected'
  return 'Unable to Assess Lameness'
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Date unavailable'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function recordDetails(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function frameRecords(value: unknown) {
  const frames = recordDetails(value).frames
  return Array.isArray(frames)
    ? frames.filter((frame): frame is Record<string, unknown> =>
      typeof frame === 'object' && frame !== null,
    )
    : []
}

function blobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Could not read the private image for the report.'))
    }
    reader.onerror = () => reject(new Error('Could not read the private image for the report.'))
    reader.readAsDataURL(blob)
  })
}

export default function HistoryPage() {
  const [rows, setRows] = useState<Prediction[]>([])
  const [userId, setUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [classFilter, setClassFilter] = useState('all')
  const [selected, setSelected] = useState<Prediction | null>(null)
  const [imageUrls, setImageUrls] = useState<{
    original: string | null
    annotated: string | null
    bodyPart: string | null
    frames: { original: string | null; annotated: string | null; bodyPart: string | null; timestamp: string }[]
  }>({ original: null, annotated: null, bodyPart: null, frames: [] })
  const [detailError, setDetailError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const supabase = createClient()
        const { data: { user }, error: userError } = await supabase.auth.getUser()
        if (userError) throw userError
        if (!user) {
          window.location.replace('/')
          return
        }
        if (active) setUserId(user.id)
        const { data, error: queryError } = await supabase
          .from('lameguard_predictions')
          .select('id,user_id,original_image_path,original_media_path,annotated_image_path,annotated_video_path,media_type,predicted_class,confidence,status,model_version,detection_details,analysis_details,processing_duration_ms,error_message,created_at')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .range(0, PAGE_SIZE - 1)
        if (queryError) throw queryError
        if (!data) throw new Error('Supabase did not return prediction history.')
        if (active) {
          const page = data as Prediction[]
          setRows(page)
          setHasMore(page.length === PAGE_SIZE)
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Unable to load prediction history.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [])

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase()
    return rows.filter(row => {
      const matchesStatus = statusFilter === 'all' || row.status === statusFilter
      const matchesClass =
        classFilter === 'all' ||
        (classFilter === 'none' ? row.predicted_class === null : row.predicted_class === classFilter)
      const searchable = `${row.id} ${label(row.predicted_class)} ${row.status} ${row.model_version ?? ''}`.toLowerCase()
      return matchesStatus && matchesClass && (!term || searchable.includes(term))
    })
  }, [classFilter, rows, search, statusFilter])

  async function loadMore() {
    if (!userId || loadingMore) return
    setLoadingMore(true)
    setError(null)
    try {
      const { data, error: queryError } = await createClient()
        .from('lameguard_predictions')
        .select('id,user_id,original_image_path,original_media_path,annotated_image_path,annotated_video_path,media_type,predicted_class,confidence,status,model_version,detection_details,analysis_details,processing_duration_ms,error_message,created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(rows.length, rows.length + PAGE_SIZE - 1)
      if (queryError) throw queryError
      if (!data) throw new Error('Supabase did not return additional prediction history.')
      const page = data as Prediction[]
      setRows(current => [...current, ...page])
      setHasMore(page.length === PAGE_SIZE)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load more records.')
    } finally {
      setLoadingMore(false)
    }
  }

  const showDetails = useCallback(async (row: Prediction) => {
    setSelected(row)
    setImageUrls({ original: null, annotated: null, bodyPart: null, frames: [] })
    setDetailError(null)
    try {
      const storage = createClient().storage.from(STORAGE_BUCKET)
      const originalPath = row.original_media_path ?? row.original_image_path
      const original = await storage.createSignedUrl(originalPath, 300)
      if (original.error) throw original.error
      let annotatedUrl: string | null = null
      if (row.annotated_image_path) {
        const annotated = await storage.createSignedUrl(row.annotated_image_path, 300)
        if (annotated.error) throw annotated.error
        annotatedUrl = annotated.data.signedUrl
      }
      let bodyPartUrl: string | null = null
      const topLevelBodyPart = recordDetails(recordDetails(row.analysis_details).body_part_model)
      if (typeof topLevelBodyPart.annotated_image_path === 'string') {
        const signed = await storage.createSignedUrl(topLevelBodyPart.annotated_image_path, 300)
        if (signed.error) throw signed.error
        bodyPartUrl = signed.data.signedUrl
      }
      const frames: { original: string | null; annotated: string | null; bodyPart: string | null; timestamp: string }[] = []
      if (row.media_type === 'video') {
        for (const frame of frameRecords(row.analysis_details).slice(0, 4)) {
          let originalFrame: string | null = null
          let annotatedFrame: string | null = null
          let bodyPartFrame: string | null = null
          if (typeof frame.original_frame_path === 'string') {
            const signed = await storage.createSignedUrl(frame.original_frame_path, 300)
            if (signed.error) throw signed.error
            originalFrame = signed.data.signedUrl
          }
          if (typeof frame.annotated_frame_path === 'string') {
            const signed = await storage.createSignedUrl(frame.annotated_frame_path, 300)
            if (signed.error) throw signed.error
            annotatedFrame = signed.data.signedUrl
          }
          const frameAnalysis = recordDetails(frame.analysis_details)
          const frameBodyPart = recordDetails(frameAnalysis.body_part_model)
          if (typeof frameBodyPart.annotated_image_path === 'string') {
            const signed = await storage.createSignedUrl(frameBodyPart.annotated_image_path, 300)
            if (signed.error) throw signed.error
            bodyPartFrame = signed.data.signedUrl
          }
          frames.push({
            original: originalFrame,
            annotated: annotatedFrame,
            bodyPart: bodyPartFrame,
            timestamp: typeof frame.timestamp_seconds === 'number'
              ? `${frame.timestamp_seconds.toFixed(1)}s`
              : 'Sampled frame',
          })
        }
      }
      setImageUrls({ original: original.data.signedUrl, annotated: annotatedUrl, bodyPart: bodyPartUrl, frames })
    } catch (cause) {
      setDetailError(cause instanceof Error ? cause.message : 'Unable to load private image previews.')
    }
  }, [])

  useEffect(() => {
    const targetId = new URLSearchParams(window.location.search).get('prediction')
    if (targetId && targetId !== selected?.id) {
      const row = rows.find(item => item.id === targetId)
      if (row) void showDetails(row)
    }
  }, [rows, selected?.id, showDetails])

  async function deletePrediction(row: Prediction) {
    if (!userId || !window.confirm(`Delete this ${label(row.predicted_class)} prediction? This cannot be undone.`)) return
    setDeletingId(row.id)
    setError(null)
    setNotice(null)
    try {
      const { data, error: deleteError } = await createClient()
        .from('lameguard_predictions')
        .delete()
        .eq('id', row.id)
        .eq('user_id', userId)
        .select('id')
        .maybeSingle()
      if (deleteError) throw deleteError
      if (!data) throw new Error('The prediction was not deleted. It may no longer exist or you may not own this record.')
      setRows(current => current.filter(item => item.id !== row.id))
      if (selected?.id === row.id) setSelected(null)
      const details = recordDetails(row.analysis_details)
      const bodyPart = recordDetails(details.body_part_model)
      const framePaths = frameRecords(details).flatMap(frame => [
        frame.original_frame_path,
        frame.annotated_frame_path,
        recordDetails(recordDetails(frame.analysis_details).body_part_model).annotated_image_path,
      ])
      const paths = [...new Set([
        row.original_media_path ?? row.original_image_path,
        row.annotated_image_path,
        row.annotated_video_path,
        typeof bodyPart.annotated_image_path === 'string' ? bodyPart.annotated_image_path : null,
        ...framePaths,
      ].filter((path): path is string => typeof path === 'string' && path.length > 0))]
      if (paths.length) {
        const { error: storageError } = await createClient().storage.from(STORAGE_BUCKET).remove(paths)
        if (storageError) {
          setNotice(`Prediction deleted, but private image cleanup failed: ${storageError.message}`)
          return
        }
      }
      setNotice('Prediction and its private images were deleted.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to delete the prediction.')
    } finally {
      setDeletingId(null)
    }
  }

  async function downloadReport(row: Prediction) {
    if (row.status !== 'completed' || downloadingId) return
    setDownloadingId(row.id)
    setError(null)
    setNotice(null)
    try {
      const storage = createClient().storage.from(STORAGE_BUCKET)
      const images: ReportImage[] = []
      const downloadImage = async (path: string, imageLabel: string) => {
        const { data, error: downloadError } = await storage.download(path)
        if (downloadError) throw downloadError
        if (!data || !data.type.startsWith('image/')) {
          throw new Error(`Private report image could not be loaded: ${imageLabel}.`)
        }
        images.push({ label: imageLabel, dataUrl: await blobAsDataUrl(data) })
      }

      if (row.media_type === 'image') {
        const originalPath = row.original_media_path ?? row.original_image_path
        if (!originalPath) throw new Error('The original image path is not available for this report.')
        await downloadImage(originalPath, 'Original image')
        if (row.annotated_image_path) {
          await downloadImage(row.annotated_image_path, 'Primary model annotated image')
        }
        const bodyPart = recordDetails(recordDetails(row.analysis_details).body_part_model)
        if (typeof bodyPart.annotated_image_path === 'string') {
          await downloadImage(bodyPart.annotated_image_path, 'Body-part model annotated image')
        }
      } else {
        const representative = frameRecords(row.analysis_details)
          .filter(frame => typeof frame.original_frame_path === 'string')
          .slice(0, 3)
        for (let index = 0; index < representative.length; index += 1) {
          const frame = representative[index]
          const timestamp = typeof frame.timestamp_seconds === 'number'
            ? `${frame.timestamp_seconds.toFixed(1)}s`
            : `frame ${index + 1}`
          await downloadImage(String(frame.original_frame_path), `Original video frame at ${timestamp}`)
          if (typeof frame.annotated_frame_path === 'string') {
            await downloadImage(frame.annotated_frame_path, `Annotated video frame at ${timestamp}`)
          }
          const bodyPart = recordDetails(recordDetails(frame.analysis_details).body_part_model)
          if (typeof bodyPart.annotated_image_path === 'string') {
            await downloadImage(bodyPart.annotated_image_path, `Body-part model frame at ${timestamp}`)
          }
        }

      }
      generatePredictionReport(row, images)
      setNotice(`PDF report downloaded for prediction ${row.id}.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to generate the PDF report from this saved prediction.')
    } finally {
      setDownloadingId(null)
    }
  }

  return (
    <main className="page-frame">
      <Link href="/dashboard" className="back-link"><ArrowLeft size={16} /> Back to dashboard</Link>
      <div className="page-heading"><p className="eyebrow">Workspace</p><h1>Prediction history</h1><p>Search, review, and manage your saved analyses.</p></div>
      <section className="surface-card history-card">
        <div className="history-filters">
          <label className="history-search"><Search size={16} /><span className="visually-hidden">Search loaded prediction records</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search loaded records" /></label>
          <label>Status<select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="processing">Processing</option></select></label>
          <label>Result<select value={classFilter} onChange={event => setClassFilter(event.target.value)}><option value="all">All results</option><option value="healthy-cow">Lameness Not Detected</option><option value="limping-cow">Lameness Detected</option><option value="none">Unable to Assess Lameness</option></select></label>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        {notice && <p className="auth-message" role="status">{notice}</p>}
        {loading ? <div className="empty-state"><Loader2 className="spin" /> Loading history...</div>
          : error && rows.length === 0 ? <div className="empty-state"><h2>History unavailable</h2><p>Resolve the error above and try loading this page again.</p></div>
          : rows.length === 0 && !error ? <div className="empty-state"><Clock3 size={26} /><h2>No predictions yet</h2><p>Run your first real analysis to see it here.</p><Link className="hero-button" href="/dashboard/predict">New prediction</Link></div>
            : filteredRows.length === 0 ? <div className="empty-state"><Search size={24} /><h2>No matching predictions</h2><p>Try another search term or filter.</p></div>
              : <div className="history-list">{filteredRows.map(row => (
                <article className="history-row history-record" key={row.id}>
                  <div className="result-icon">{row.status === 'completed' ? row.predicted_class === 'limping-cow' ? <XCircle /> : <CheckCircle2 /> : <Clock3 />}</div>
                  <button className="history-record-button" type="button" onClick={() => void showDetails(row)} aria-label={`View details for ${label(row.predicted_class)} prediction from ${formatDate(row.created_at)}`}>
                    <strong>{label(row.predicted_class)}</strong>
                    <span>{row.media_type} · {formatDate(row.created_at)} · {row.status}</span>
                  </button>
                  <span>{row.status !== 'completed' || row.confidence == null ? '—' : `${(row.confidence * 100).toFixed(1)}% confidence`}</span>
                  <button className="report-button" type="button" disabled={downloadingId === row.id || row.status !== 'completed'} onClick={() => void downloadReport(row)} aria-label={`Download PDF report for prediction ${row.id}`}>
                    {downloadingId === row.id ? <Loader2 className="spin" size={15} /> : <Download size={15} />}
                    <span>PDF report</span>
                  </button>
                  <button className="delete-button" type="button" disabled={deletingId === row.id} onClick={() => void deletePrediction(row)} aria-label={`Delete prediction ${row.id}`}><Trash2 size={16} /></button>
                </article>
              ))}</div>}
        {!loading && hasMore && <button className="secondary-button load-more" type="button" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore && <Loader2 className="spin" size={15} />}{loadingMore ? 'Loading...' : 'Load more records'}</button>}
      </section>
      {selected && (
        <section className="surface-card prediction-details" aria-labelledby="prediction-detail-title">
          <div className="detail-heading"><div><p className="eyebrow">Prediction details</p><h2 id="prediction-detail-title">{label(selected.predicted_class)}</h2></div><button type="button" className="secondary-button" onClick={() => setSelected(null)}>Close</button></div>
          <dl className="detail-grid">
            <div><dt>Media type</dt><dd>{selected.media_type}</dd></div>
            <div><dt>Date</dt><dd>{formatDate(selected.created_at)}</dd></div>
            <div><dt>Status</dt><dd>{selected.status}</dd></div>
            <div><dt>Confidence</dt><dd>{selected.status !== 'completed' || selected.confidence == null ? 'Not available' : `${(selected.confidence * 100).toFixed(1)}%`}</dd></div>
            <div><dt>Model version</dt><dd>{selected.model_version ?? 'Not recorded'}</dd></div>
            <div><dt>Prediction ID</dt><dd>{selected.id}</dd></div>
          </dl>
          {typeof selected.error_message === 'string' && <p className="form-error">{selected.error_message}</p>}
          {detailError && <p className="form-error" role="alert">Could not load private image previews: {detailError}</p>}
          <div className="detail-images">
            {imageUrls.original && (selected.media_type === 'video'
              ? <figure><video src={imageUrls.original} controls preload="metadata" aria-label="Saved uploaded cow video" /><figcaption>Original video</figcaption></figure>
              : <figure><img src={imageUrls.original} alt="Original uploaded cow image" /><figcaption>Original image</figcaption></figure>)}
            {imageUrls.annotated && <figure><img src={imageUrls.annotated} alt="Model-annotated cow image" /><figcaption>Model annotation</figcaption></figure>}
            {imageUrls.bodyPart && <figure><img src={imageUrls.bodyPart} alt="Body-part model annotated image" /><figcaption>Body-part model annotation</figcaption></figure>}
            {imageUrls.frames.map((frame, index) => <figure key={`${selected.id}-frame-${index}`}>
              {frame.original && <img src={frame.original} alt={`Original sampled video frame at ${frame.timestamp}`} />}
              {frame.annotated && <img src={frame.annotated} alt={`Annotated video frame at ${frame.timestamp}`} />}
              {frame.bodyPart && <img src={frame.bodyPart} alt={`Body-part model annotated frame at ${frame.timestamp}`} />}
              <figcaption>Sampled video frame · {frame.timestamp}</figcaption>
            </figure>)}
          </div>
          {selected.status === 'completed' && <button className="hero-button report-download" type="button" disabled={downloadingId === selected.id} onClick={() => void downloadReport(selected)}>{downloadingId === selected.id ? <Loader2 className="spin" size={15} /> : <Download size={15} />} Download PDF report</button>}
          {selected.detection_details !== null && selected.detection_details !== undefined && <details><summary>Detection details</summary><pre>{JSON.stringify(selected.detection_details, null, 2)}</pre></details>}
          <details><summary>Saved model analysis and sampling details</summary><pre>{JSON.stringify(selected.analysis_details, null, 2)}</pre></details>
        </section>
      )}
    </main>
  )
}

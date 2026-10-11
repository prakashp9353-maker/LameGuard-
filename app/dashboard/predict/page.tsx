'use client'

import { ChangeEvent, DragEvent, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileVideo2,
  Leaf,
  Loader2,
  ShieldCheck,
  UploadCloud,
  X,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import {
  predictCowImage,
  predictCowVideo,
  predictionLabel,
  type PredictionResponse,
  type VideoFrameProgress,
} from '@/lib/predictions/api'
import { savePrediction } from '@/lib/predictions/storage'
import { model2GeometryStatus } from '@/lib/predictions/model2-presentation'

type MediaType = 'image' | 'video'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_VIDEO_BYTES = 250 * 1024 * 1024

function imageAssessment(result: PredictionResponse) {
  return predictionLabel(result.predicted_class)
}

function toObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function encodePercentage(value: number | null) {
  return value === null ? 'Not available' : `${(value * 100).toFixed(1)}%`
}

function formatMeasurement(value: unknown, digits = 3) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(digits)
    : 'Not available'
}

function guidance(result: PredictionResponse) {
  if (result.media_type === 'video') {
    if (result.predicted_class === 'limping-cow') {
      return [
        'At least one sampled frame met the configured confidence threshold for the lame class; this video result is a screening signal, not a diagnosis.',
        'Review the qualifying frame detections and arrange veterinary assessment for persistent limping, pain, or uneven weight-bearing.',
        'Seek prompt veterinary care if the cow cannot stand or bear weight, has severe pain, or appears acutely injured or unwell.',
      ]
    }
    if (result.predicted_class === 'healthy-cow') {
      return [
        'Only healthy-class detections met the configured threshold in the sampled frames; this does not rule out lameness.',
        'Sampling can miss gait changes between frames. Persistent limping, pain, or uneven weight-bearing warrants veterinary assessment.',
        'A veterinarian should assess concerning signs and determine whether care is needed.',
      ]
    }
    return [
      'No sampled frame returned a supported class above the configured confidence threshold.',
      'If you observe persistent limping, uneven weight-bearing, pain, or other concerning signs, arrange a veterinary examination.',
      'A veterinarian should assess the cow and determine whether treatment is needed.',
    ]
  }
  if (result.predicted_class === 'limping-cow') {
    return [
      'Observe the cow walking and bearing weight without forcing unnecessary movement if it appears painful.',
      'Provide clean, dry, non-slip resting conditions while arranging veterinary assessment.',
      'Seek prompt veterinary care if the cow cannot stand or bear weight, has severe pain, or appears acutely injured or unwell.',
    ]
  }
  return [
    'A healthy-looking or inconclusive image result cannot rule out lameness or another condition.',
    'If limping, pain, uneven weight-bearing, or other symptoms persist, arrange a veterinary examination.',
  ]
}

export default function PredictPage() {
  const [mediaType, setMediaType] = useState<MediaType>('image')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [result, setResult] = useState<PredictionResponse | null>(null)
  const [predictionId, setPredictionId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [detailed, setDetailed] = useState(true)
  const [progress, setProgress] = useState<{ current: number; total: number; timestamp: number } | null>(null)
  const [progressFrames, setProgressFrames] = useState<VideoFrameProgress['frame'][]>([])

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview)
  }, [preview])

  function clearSelection() {
    setFile(null)
    setPreview(null)
    setResult(null)
    setPredictionId(null)
    setProgress(null)
    setProgressFrames([])
    setError(null)
  }

  function chooseFile(next: File | undefined) {
    if (!next) return
    setFile(null)
    setPreview(null)
    setError(null)
    setResult(null)
    setPredictionId(null)
    setProgress(null)
    setProgressFrames([])

    if (mediaType === 'image') {
      if (!['image/jpeg', 'image/png'].includes(next.type)) {
        setError('Choose a JPG, JPEG, or PNG image.')
        return
      }
      if (next.size > MAX_IMAGE_BYTES) {
        setError('Images must be 10 MB or smaller.')
        return
      }
    } else {
      const isMp4 = next.name.toLowerCase().endsWith('.mp4')
      const hasSupportedMime = !next.type || next.type === 'video/mp4' || next.type === 'application/octet-stream'
      if (!isMp4 || !hasSupportedMime) {
        setError('Choose an MP4 video.')
        return
      }
      if (next.size > MAX_VIDEO_BYTES) {
        setError('Videos must be 250 MB or smaller.')
        return
      }
    }
    if (next.size === 0) {
      setError('The selected file is empty.')
      return
    }
    setPreview(URL.createObjectURL(next))
    setFile(next)
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    chooseFile(event.target.files?.[0])
    event.target.value = ''
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    if (!loading) chooseFile(event.dataTransfer.files[0])
  }

  async function analyze() {
    if (!file || loading) return
    setLoading(true)
    setError(null)
    setResult(null)
    setPredictionId(null)
    setProgress(mediaType === 'video' ? { current: 0, total: 0, timestamp: 0 } : null)
    setProgressFrames([])
    try {
      const supabase = createClient()
      const { data: { user }, error: userError } = await supabase.auth.getUser()
      if (userError) throw new Error(`Could not verify your signed-in account: ${userError.message}`)
      if (!user) {
        window.location.assign('/')
        return
      }

      const analysis = mediaType === 'image'
        ? await predictCowImage(file, detailed)
        : await predictCowVideo(file, detailed, update => {
          setProgress({
            current: update.current,
            total: update.total,
            timestamp: update.timestamp_seconds,
          })
          setProgressFrames(frames => [...frames, update.frame])
        })
      const saved = await savePrediction(file, analysis)
      setPredictionId(saved.id)
      setResult(analysis)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The analysis could not be completed.')
    } finally {
      setLoading(false)
    }
  }

  const accept = mediaType === 'image'
    ? '.jpg,.jpeg,.png,image/jpeg,image/png'
    : '.mp4,video/mp4'
  const bodyModel = result ? toObject(result.analysis_details.body_part_model) : null
  const geometryFeatures = bodyModel ? toObject(bodyModel.geometry_features) : null
  const bodyAssessment = bodyModel ? toObject(bodyModel.experimental_assessment) : null
  const bodyDetections = Array.isArray(bodyModel?.detections)
    ? bodyModel.detections.filter((item): item is Record<string, unknown> => toObject(item) !== null)
    : []
  const videoGeometryAssessment = result
    ? toObject(result.analysis_details.experimental_geometry_assessment)
    : null
  const videoBodyModel = result
    ? toObject(result.analysis_details.body_part_model)
    : null
  const videoGeometryCounts = videoGeometryAssessment
    ? toObject(videoGeometryAssessment.class_counts)
    : null
  const videoGeometryRows = result && Array.isArray(result.analysis_details.frames)
    ? result.analysis_details.frames.flatMap(frameValue => {
      const frame = toObject(frameValue)
      const frameAnalysis = toObject(frame?.analysis_details)
      const frameBodyModel = toObject(frameAnalysis?.body_part_model)
      const frameGeometry = toObject(frameBodyModel?.geometry_features)
      const observations = frameGeometry?.observations
      const timestamp = frame?.timestamp_seconds
      if (
        typeof timestamp !== 'number' ||
        !Array.isArray(observations)
      ) return []
      return observations.flatMap(observationValue => {
        const observation = toObject(observationValue)
        return observation
          ? [{ frameIndex: frame?.frame_index, timestamp, observation }]
          : []
      })
    })
    : []
  const videoBodyDetectionRows = result && Array.isArray(result.analysis_details.frames)
    ? result.analysis_details.frames.flatMap(frameValue => {
      const frame = toObject(frameValue)
      const frameAnalysis = toObject(frame?.analysis_details)
      const frameBodyModel = toObject(frameAnalysis?.body_part_model)
      const detections = frameBodyModel?.detections
      const timestamp = frame?.timestamp_seconds
      if (typeof timestamp !== 'number' || !Array.isArray(detections)) return []
      return detections.flatMap(detectionValue => {
        const detection = toObject(detectionValue)
        return detection
          ? [{ frameIndex: frame?.frame_index, timestamp, detection }]
          : []
      })
    })
    : []
  const bodyClassCounts = geometryFeatures ? toObject(geometryFeatures.class_counts) : null
  const bodyObservations = Array.isArray(geometryFeatures?.observations)
    ? geometryFeatures.observations.filter((item): item is Record<string, unknown> => toObject(item) !== null)
    : []
  const bodyGeometryStatus = model2GeometryStatus(
    result?.predicted_class ?? null,
    typeof bodyAssessment?.valid_observation_count === 'number'
      ? bodyAssessment.valid_observation_count
      : bodyObservations.length,
  )
  const videoBodyGeometryStatus = model2GeometryStatus(
    result?.predicted_class ?? null,
    typeof videoGeometryAssessment?.valid_observation_count === 'number'
      ? videoGeometryAssessment.valid_observation_count
      : videoGeometryRows.length,
  )
  const videoSampling = result ? toObject(result.analysis_details.sampling) : null
  const videoSummary = result ? toObject(result.analysis_details.frame_summary) : null

  return (
    <main className="predict-page">
      <div className="predict-wrap">
        <Link href="/dashboard" className="back-link"><ArrowLeft size={16} /> Back to dashboard</Link>
        <div className="predict-header">
          <p className="eyebrow">New analysis</p>
          <h1>Analyze cow media</h1>
          <p>Review actual YOLO26 detections. This experimental tool is not a veterinary diagnosis.</p>
        </div>
        <section className="predict-card">
          <div className="media-tabs" role="tablist" aria-label="Analysis media type">
            <button type="button" role="tab" aria-selected={mediaType === 'image'} disabled={loading} onClick={() => { clearSelection(); setMediaType('image') }}>Image analysis</button>
            <button type="button" role="tab" aria-selected={mediaType === 'video'} disabled={loading} onClick={() => { clearSelection(); setMediaType('video') }}>Video analysis</button>
          </div>
          <p className="media-method-note">
            {mediaType === 'image'
              ? 'JPG, JPEG, or PNG up to 10 MB.'
              : 'MP4 up to 250 MB. The backend samples frames at a configured interval (2 seconds by default; up to 60 frames across at most 120 seconds). Samples do not establish temporal gait or diagnosis.'}
          </p>
          <div
            className={`predict-dropzone ${preview ? 'has-preview' : ''} ${dragging ? 'is-dragging' : ''}`}
            onDragEnter={event => { event.preventDefault(); setDragging(true) }}
            onDragOver={event => event.preventDefault()}
            onDragLeave={event => {
              const nextTarget = event.relatedTarget
              if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) setDragging(false)
            }}
            onDrop={onDrop}
          >
            <input id="cow-media" className="file-input" type="file" accept={accept} onChange={onFileChange} disabled={loading} />
            {preview && file ? (
              <div className="media-preview">
                {mediaType === 'image'
                  ? <img src={preview} alt="Preview of selected cow image" />
                  : <video src={preview} controls preload="metadata" aria-label="Preview of selected MP4 video" />}
                <div className="image-controls">
                  <label className="secondary-button" htmlFor="cow-media">Replace media</label>
                  <button type="button" className="secondary-button" onClick={clearSelection} disabled={loading}><X size={15} /> Remove</button>
                </div>
                <p className="media-file-name">{file.name} · {(file.size / (1024 * 1024)).toFixed(1)} MB</p>
              </div>
            ) : (
              <label className="dropzone-prompt" htmlFor="cow-media">
                {mediaType === 'image' ? <UploadCloud size={30} /> : <FileVideo2 size={30} />}
                <strong>Drop {mediaType === 'image' ? 'an image' : 'an MP4 video'} here or browse</strong>
                <span>{mediaType === 'image' ? 'JPG, JPEG, or PNG · up to 10 MB' : 'MP4 · up to 250 MB'}</span>
              </label>
            )}
          </div>
          <label className="detail-toggle">
            <input type="checkbox" checked={detailed} onChange={event => setDetailed(event.target.checked)} disabled={loading} />
            Run optional body-part model when configured; report measured geometry without treating it as a diagnosis.
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          {loading && mediaType === 'video' && (
            <div className="video-progress" role="status" aria-live="polite">
              <div className="progress-copy">
                <Loader2 className="spin" size={17} />
                <span>{progress?.total ? `Analyzing sampled frame ${progress.current} of ${progress.total} · ${progress.timestamp.toFixed(1)}s` : 'Uploading video and preparing frame sampling…'}</span>
              </div>
              {progress?.total ? <progress value={progress.current} max={progress.total} aria-label="Video frame analysis progress" /> : <div className="indeterminate-progress" aria-label="Video upload in progress" />}
            </div>
          )}
          
<button className="hero-button full" disabled={!file || loading} onClick={() => void analyze()}>
  {loading ? (
    <>
      <Loader2 className="spin" size={16} />
      {mediaType === 'video' ? 'Processing video…' : 'Analyzing and saving…'}
    </>
  ) : (
    `Analyze ${mediaType}`
  )}
</button>


          {loading && mediaType === 'video' && progressFrames.length > 0 && (
            <section className="live-frames" aria-label="Frame-by-frame detections">
              <h2>Sampled frame detections</h2>
              <div className="frame-detection-list">{progressFrames.slice(-8).map(frame => (
                <div className="frame-detection" key={frame.frame_index}>
                  <span>Frame {frame.frame_index + 1} · {frame.timestamp_seconds.toFixed(1)}s</span>
                  <strong>{predictionLabel(frame.predicted_class)}</strong>
                  <span>{encodePercentage(frame.confidence)}</span>
                </div>
              ))}</div>
            </section>
          )}

          {result && (
            <section className="analysis-result" aria-labelledby="analysis-result-heading">
              <div className="result-heading">
                <div className="result-check"><CheckCircle2 size={18} /></div>
                <div>
                  <p className="eyebrow">
                    Saved analysis · {result.model_version ?? 'Model identity not verified'}
                  </p>
                  <h2 id="analysis-result-heading">{imageAssessment(result)}</h2>
                  <p>Model 1 result: {predictionLabel(result.predicted_class)} · {result.media_type === 'video' ? 'Highest qualifying frame confidence' : 'Confidence'} {encodePercentage(result.confidence)}</p>
                  <p>Processed in {(result.processing_duration_ms / 1000).toFixed(2)}s · Record {predictionId}</p>
                </div>
              </div>
              {result.annotated_image_base64 && result.annotated_image_mime_type && (
                <figure className="result-annotation">
                  <img src={`data:${result.annotated_image_mime_type};base64,${result.annotated_image_base64}`} alt="Image annotated by the primary YOLO26 model" />
                  <figcaption>Primary model annotated image</figcaption>
                </figure>
              )}
              {result.media_type === 'video' && videoSampling && videoSummary && (
                <div className="video-analysis-summary">
                  <h3>Sampled-frame summary</h3>
                  <p>{String(videoSampling.method)}</p>
                  <p>{String(videoSampling.sampled_frame_count)} sampled of {String(videoSampling.source_frame_count)} source frames · {String(videoSampling.source_duration_seconds)}s duration · source {String(videoSampling.source_fps)} FPS</p>
                  <div className="stats-inline">
                    <span>Lame-class detections across frames: {String(videoSummary.frames_with_limping_cow_detection)}</span>
                    <span>Healthy-class detections across frames: {String(videoSummary.frames_with_healthy_cow_detection)}</span>
                    <span>No supported class: {String(videoSummary.frames_without_supported_class_detection)}</span>
                  </div>
                  <p className="inconclusive-note"><AlertTriangle size={16} /> Video classification uses qualifying sampled detections with lame-class priority; sampling may miss changes between frames.</p>
                  {(Number(videoGeometryAssessment?.frames_with_model_2_analysis ?? 0) > 0 ||
                    videoGeometryRows.length > 0 || videoBodyDetectionRows.length > 0 ||
                    (result.predicted_class === null && videoGeometryAssessment !== null)) && (
                    <section aria-labelledby="video-body-part-observations">
                      <h3 id="video-body-part-observations">Model 2 · Body-part observations</h3>
                      {videoBodyGeometryStatus && <p>{videoBodyGeometryStatus}</p>}
                      {videoGeometryCounts && <>
                        {Number(videoGeometryAssessment?.frames_with_model_2_analysis ?? 0) > 0 && <>
                          <h4>Detection counts</h4>
                          <ul>{Object.entries(videoGeometryCounts).map(([className, count]) => (
                            <li key={className}>{className}: {typeof count === 'number' ? count : 'Not available'}</li>
                          ))}</ul>
                        </>}
                      </>}
                      {videoGeometryRows.length > 0
                        ? <div className="table-wrap"><table>
                          <thead><tr><th>Frame</th><th>Class</th><th>Confidence</th><th>Bounds</th><th>Box center</th><th>Width</th><th>Height</th><th>Area</th></tr></thead>
                          <tbody>{videoGeometryRows.map(({ frameIndex, timestamp, observation }, index) => {
                            const bounds = toObject(observation.bbox_normalized)
                            const center = toObject(observation.bbox_center_normalized)
                            return <tr key={`${String(frameIndex)}-${String(observation.detection_index ?? index)}`}>
                              <td>{String(frameIndex ?? 'Not available')} · {timestamp.toFixed(1)}s</td>
                              <td>{String(observation.class ?? 'Unknown')}</td>
                              <td>{encodePercentage(typeof observation.confidence === 'number' ? observation.confidence : null)}</td>
                              <td>{bounds ? [bounds.x_min, bounds.y_min, bounds.x_max, bounds.y_max].map(value => formatMeasurement(value)).join(', ') : 'Not available'}</td>
                              <td>{center ? [center.x, center.y].map(value => formatMeasurement(value)).join(', ') : 'Not available'}</td>
                              <td>{formatMeasurement(observation.width)}</td>
                              <td>{formatMeasurement(observation.height)}</td>
                              <td>{formatMeasurement(observation.area)}</td>
                            </tr>
                          })}</tbody>
                        </table></div>
                        : videoBodyDetectionRows.length > 0
                          ? <ul>{videoBodyDetectionRows.map(({ frameIndex, timestamp, detection }, index) => (
                            <li key={`${String(frameIndex)}-${String(detection.class)}-${index}`}>Frame {String(frameIndex ?? 'Not available')} · {timestamp.toFixed(1)}s · {String(detection.class ?? 'Unknown')} · {encodePercentage(typeof detection.confidence === 'number' ? detection.confidence : null)}</li>
                          ))}</ul>
                          : Number(videoGeometryAssessment?.frames_with_model_2_analysis ?? 0) > 0
                            ? <p>No body-part detections returned.</p>
                            : videoBodyModel?.status === 'not_loaded'
                              ? <p>Body-part model unavailable.</p>
                              : null}
                    </section>
                  )}
                  <div className="representative-frames">{(result.analysis_details.frames as VideoFrameProgress['frame'][] | undefined)?.map((frame, index) => {
                    const storedFrame = result.analysis_details.frames as unknown as Array<Record<string, unknown>>
                    const item = storedFrame[index]
                    const frameAnalysis = toObject(item.analysis_details)
                    const frameBodyPart = toObject(frameAnalysis?.body_part_model)
                    const bodyPartAnnotated = frameBodyPart?.annotated_image_base64
                    const original = item.original_frame_base64
                    const annotated = item.annotated_frame_base64
                    return (
                      <figure key={frame.frame_index}>
                        {typeof annotated === 'string' && <img src={`data:image/jpeg;base64,${annotated}`} alt={`Annotated sampled frame at ${frame.timestamp_seconds.toFixed(1)} seconds`} />}
                        {typeof original === 'string' && <img src={`data:image/jpeg;base64,${original}`} alt={`Original sampled frame at ${frame.timestamp_seconds.toFixed(1)} seconds`} />}
                        {typeof bodyPartAnnotated === 'string' && <img src={`data:image/jpeg;base64,${bodyPartAnnotated}`} alt={`Body-part detections at ${frame.timestamp_seconds.toFixed(1)} seconds`} />}
                        <figcaption>{frame.timestamp_seconds.toFixed(1)}s · {predictionLabel(frame.predicted_class)} · {encodePercentage(frame.confidence)}</figcaption>
                      </figure>
                    )
                  })}</div>
                </div>
              )}
              {result.media_type === 'image' && (
                <div className="model-details">
                  <section aria-labelledby="primary-model-observations">
                    <h3 id="primary-model-observations">Model 1 · Lameness prediction</h3>
                    <p>Result: {predictionLabel(result.predicted_class)} · Confidence: {encodePercentage(result.confidence)}</p>
                    {result.detection_details.length > 0
                      ? <ul>{result.detection_details.map((detection, index) => (
                        <li key={`${detection.class}-${index}`}>{detection.class} · {encodePercentage(detection.confidence)}</li>
                      ))}</ul>
                      : <p>Unable to assess lameness: no supported Model 1 class was returned.</p>}
                  </section>
                  {((bodyModel && bodyModel.status !== 'not_requested') || result.predicted_class === null) && <section aria-labelledby="body-part-observations">
                    <h3 id="body-part-observations">Model 2 · Body-part observations</h3>
                    {bodyGeometryStatus && <p>{bodyGeometryStatus}</p>}
                    {bodyModel?.status === 'unavailable' && <p>Body-part model unavailable.</p>}
                    {bodyModel?.status === 'completed' && bodyDetections.length === 0 && <p>No body-part detections returned.</p>}
                    {typeof bodyModel?.annotated_image_base64 === 'string' && (
                      <figure className="result-annotation">
                        <img src={`data:image/jpeg;base64,${bodyModel.annotated_image_base64}`} alt="Image annotated by the body-part model" />
                        <figcaption>Body-part model annotations</figcaption>
                      </figure>
                    )}
                    {geometryFeatures && <>
                      {bodyClassCounts && <>
                        <h4>Detection counts by class</h4>
                        <ul>{Object.entries(bodyClassCounts).map(([className, count]) => (
                          <li key={className}>{className}: {typeof count === 'number' ? count : 'Not available'}</li>
                        ))}</ul>
                      </>}
                      {bodyObservations.length > 0
                        ? <div className="table-wrap"><table>
                          <thead><tr><th>Class</th><th>Confidence</th><th>Bounds (x1, y1, x2, y2)</th><th>Box center (x, y)</th><th>Width</th><th>Height</th><th>Area</th></tr></thead>
                          <tbody>{bodyObservations.map((observation, index) => {
                            const bounds = toObject(observation.bbox_normalized)
                            const center = toObject(observation.bbox_center_normalized)
                            return <tr key={`${String(observation.detection_index ?? index)}-${String(observation.class)}`}>
                              <td>{String(observation.class ?? 'Unknown')}</td>
                              <td>{encodePercentage(typeof observation.confidence === 'number' ? observation.confidence : null)}</td>
                              <td>{bounds
                                ? [bounds.x_min, bounds.y_min, bounds.x_max, bounds.y_max].map(value => formatMeasurement(value)).join(', ')
                                : 'Not available'}</td>
                              <td>{center
                                ? [center.x, center.y].map(value => formatMeasurement(value)).join(', ')
                                : 'Not available'}</td>
                              <td>{formatMeasurement(observation.width)}</td>
                              <td>{formatMeasurement(observation.height)}</td>
                              <td>{formatMeasurement(observation.area)}</td>
                            </tr>
                          })}</tbody>
                        </table></div>
                        : null}
                    </>}
                    {bodyObservations.length === 0 && bodyDetections.length > 0 && <ul>{bodyDetections.map((detection, index) => (
                      <li key={`${String(detection.class)}-${index}`}>{String(detection.class ?? 'Unknown')} · {encodePercentage(typeof detection.confidence === 'number' ? detection.confidence : null)}</li>
                    ))}</ul>}
                  </section>}
                </div>
              )}
             
<div className="care-guidance">
  <h3>Care guidance</h3>
  <ul>
    {guidance(result).map(item => (
      <li key={item}>{item}</li>
    ))}
  </ul>
</div>

<Link className="secondary-button" href={`/dashboard/history?prediction=${encodeURIComponent(predictionId ?? '')}`}>
  View saved record and download PDF report
</Link>
</section>
)}

          <Link className="history-shortcut" href="/dashboard/history">View prediction history</Link>
        </section>
        <p className="predict-brand"><Leaf size={14} /> LameGuard AI</p>
      </div>
    </main>
  )
}

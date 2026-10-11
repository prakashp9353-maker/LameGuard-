export type DetectionDetail = {
  class: string
  confidence: number
  bbox: number[]
  bbox_normalized?: number[]
}

export type VideoFrame = {
  frame_index: number
  timestamp_seconds: number
  predicted_class: 'healthy-cow' | 'limping-cow' | null
  confidence: number | null
  detection_details: DetectionDetail[]
  analysis_details: Record<string, unknown>
  annotated_frame_base64: string | null
  original_frame_base64: string | null
  annotated_frame_path?: string | null
  original_frame_path?: string | null
}

export type PredictionResponse = {
  media_type: 'image' | 'video'
  predicted_class: 'healthy-cow' | 'limping-cow' | null
  confidence: number | null
  annotated_image_base64: string | null
  annotated_image_mime_type: string | null
  detection_details: DetectionDetail[]
  model_version: string
  status: 'completed'
  processing_duration_ms: number
  analysis_details: Record<string, unknown>
  input_sha256: string
  signature: string
  signed_payload: string
}

export type VideoFrameProgress = {
  current: number
  total: number
  timestamp_seconds: number
  frame: Omit<VideoFrame, 'annotated_frame_base64' | 'original_frame_base64'>
}

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL
const CLASS_NAMES = new Set(['healthy-cow', 'limping-cow'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isConfidence(value: unknown): value is number | null {
  return value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)
}

function validateDetections(value: unknown): DetectionDetail[] {
  if (!Array.isArray(value)) {
    throw new Error('The prediction service returned invalid detection details.')
  }
  return value.map(detection => {
    if (
      !isRecord(detection) ||
      typeof detection.class !== 'string' ||
      typeof detection.confidence !== 'number' ||
      !Number.isFinite(detection.confidence) ||
      detection.confidence < 0 ||
      detection.confidence > 1 ||
      !Array.isArray(detection.bbox) ||
      detection.bbox.length !== 4 ||
      !detection.bbox.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate)) ||
      (detection.bbox_normalized !== undefined &&
        (!Array.isArray(detection.bbox_normalized) ||
          detection.bbox_normalized.length !== 4 ||
          !detection.bbox_normalized.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate))))
    ) {
      throw new Error('The prediction service returned invalid detection details.')
    }
    return detection as DetectionDetail
  })
}

function validateResult(
  value: unknown,
  mediaType: PredictionResponse['media_type'],
  attestation: { input_sha256: string; signature: string; signed_payload: string },
): PredictionResponse {
  if (
    !isRecord(value) ||
    value.status !== 'completed' ||
    value.media_type !== mediaType ||
    (value.predicted_class !== null && !CLASS_NAMES.has(String(value.predicted_class))) ||
    !isConfidence(value.confidence) ||
    ((value.predicted_class === null) !== (value.confidence === null)) ||
    typeof value.model_version !== 'string' ||
    typeof value.processing_duration_ms !== 'number' ||
    !Number.isFinite(value.processing_duration_ms) ||
    value.processing_duration_ms < 0 ||
    !isRecord(value.analysis_details)
  ) {
    throw new Error('The prediction service returned an invalid response.')
  }

  const annotatedImage = value.annotated_image_base64 ?? null
  const mimeType = value.annotated_image_mime_type ?? null
  if (
    (annotatedImage !== null &&
      (typeof annotatedImage !== 'string' ||
        annotatedImage.length === 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(annotatedImage))) ||
    ((annotatedImage === null) !== (mimeType === null)) ||
    (mimeType !== null && mimeType !== 'image/jpeg' && mimeType !== 'image/png')
  ) {
    throw new Error('The prediction service returned an invalid annotated image.')
  }
  if (mediaType === 'image' && !annotatedImage) {
    throw new Error('The prediction service did not return the annotated image.')
  }
  if (
    !/^[a-f0-9]{64}$/i.test(attestation.input_sha256) ||
    !/^[a-f0-9]{64}$/i.test(attestation.signature) ||
    !attestation.signed_payload
  ) {
    throw new Error('The prediction service did not provide a valid result attestation.')
  }

  return {
    media_type: mediaType,
    predicted_class: value.predicted_class as PredictionResponse['predicted_class'],
    confidence: value.confidence,
    annotated_image_base64: annotatedImage,
    annotated_image_mime_type: mimeType,
    detection_details: validateDetections(value.detection_details),
    model_version: value.model_version,
    status: 'completed',
    processing_duration_ms: value.processing_duration_ms,
    analysis_details: value.analysis_details,
    ...attestation,
  }
}

function assertApiBaseUrl() {
  const configuredUrl = apiBaseUrl?.trim()
  if (!configuredUrl) {
    throw new Error(
      'Prediction service is not configured. Set NEXT_PUBLIC_API_BASE_URL to the absolute FastAPI backend URL in the frontend build environment, then redeploy.',
    )
  }

  let backendUrl: URL
  try {
    backendUrl = new URL(configuredUrl)
  } catch {
    throw new Error(
      'NEXT_PUBLIC_API_BASE_URL must be an absolute HTTP(S) URL for the FastAPI backend.',
    )
  }
  if (backendUrl.protocol !== 'http:' && backendUrl.protocol !== 'https:') {
    throw new Error(
      'NEXT_PUBLIC_API_BASE_URL must be an absolute HTTP(S) URL for the FastAPI backend.',
    )
  }
  if (typeof window !== 'undefined' && backendUrl.origin === window.location.origin) {
    throw new Error(
      'NEXT_PUBLIC_API_BASE_URL points to the LameGuard frontend, not FastAPI. Set it to the actual backend service URL in the frontend build environment, then redeploy.',
    )
  }

  return configuredUrl.replace(/\/+$/, '')
}

function requestError(cause: unknown) {
  if (cause instanceof DOMException && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) {
    return new Error('The prediction request timed out or was cancelled. Try again or check the service.')
  }
  return new Error('Unable to reach the prediction service. Confirm the backend is running and try again.')
}

function responseError(status: number, payload: unknown) {
  const detail = isRecord(payload) ? payload.detail : null
  return new Error(typeof detail === 'string' ? detail : `Prediction service returned ${status}.`)
}

export async function predictCowImage(file: File, detailed: boolean): Promise<PredictionResponse> {
  const formData = new FormData()
  formData.append('file', file)
  let response: Response
  try {
    response = await fetch(`${assertApiBaseUrl()}/predict?detailed=${detailed}`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(60_000),
    })
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes('NEXT_PUBLIC_API_BASE_URL')) throw cause
    throw requestError(cause)
  }

  let payload: unknown
  let rawPayload: string
  try {
    rawPayload = await response.text()
    payload = JSON.parse(rawPayload)
  } catch {
    throw new Error(`The prediction service returned an unreadable response (${response.status}).`)
  }
  if (!response.ok) throw responseError(response.status, payload)
  const inputSha256 = response.headers.get('X-LameGuard-Input-SHA256')
  const signature = response.headers.get('X-LameGuard-Signature')
  if (!inputSha256 || !signature) {
    throw new Error('The prediction service response is missing its save-verification signature.')
  }
  return validateResult(payload, 'image', {
    input_sha256: inputSha256,
    signature,
    signed_payload: rawPayload,
  })
}

export async function predictCowVideo(
  file: File,
  detailed: boolean,
  onProgress: (progress: VideoFrameProgress) => void,
): Promise<PredictionResponse> {
  const formData = new FormData()
  formData.append('file', file)
  let response: Response
  try {
    response = await fetch(`${assertApiBaseUrl()}/predict-video?detailed=${detailed}`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(15 * 60_000),
    })
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes('NEXT_PUBLIC_API_BASE_URL')) throw cause
    throw requestError(cause)
  }

  if (!response.ok) {
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new Error(`The prediction service returned an unreadable response (${response.status}).`)
    }
    throw responseError(response.status, payload)
  }
  if (!response.body) throw new Error('The video service did not return a progress stream.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const completionEvents: {
    result: unknown
    input_sha256: string
    signature: string
    signed_payload: string
  }[] = []
  const consumeLine = (line: string) => {
    if (!line.trim()) return
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      throw new Error('The video service returned an invalid progress event.')
    }
    if (!isRecord(event) || typeof event.type !== 'string') {
      throw new Error('The video service returned an invalid progress event.')
    }
    if (event.type === 'error') {
      throw new Error(typeof event.detail === 'string' ? event.detail : 'Video inference failed.')
    }
    if (event.type === 'progress') {
      if (
        typeof event.current !== 'number' ||
        typeof event.total !== 'number' ||
        typeof event.timestamp_seconds !== 'number' ||
        !isRecord(event.frame)
      ) {
        throw new Error('The video service returned invalid frame progress.')
      }
      onProgress({
        current: event.current,
        total: event.total,
        timestamp_seconds: event.timestamp_seconds,
        frame: {
          frame_index: event.frame.frame_index as number,
          timestamp_seconds: event.timestamp_seconds,
          predicted_class: event.frame.predicted_class as VideoFrame['predicted_class'],
          confidence: event.frame.confidence as number | null,
          detection_details: validateDetections(event.frame.detection_details),
          analysis_details: isRecord(event.frame.analysis_details) ? event.frame.analysis_details : {},
        },
      })
      return
    }
    if (event.type === 'complete') {
      if (
        typeof event.result_json !== 'string' ||
        typeof event.input_sha256 !== 'string' ||
        typeof event.signature !== 'string'
      ) {
        throw new Error('The video service returned an invalid signed result.')
      }
      let result: unknown
      try {
        result = JSON.parse(event.result_json)
      } catch {
        throw new Error('The video service returned unreadable analysis results.')
      }
      completionEvents.push({
        result,
        input_sha256: event.input_sha256,
        signature: event.signature,
        signed_payload: event.result_json,
      })
      return
    }
    throw new Error('The video service returned an unknown progress event.')
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      lines.forEach(consumeLine)
      if (done) break
    }
    if (buffer.trim()) consumeLine(buffer)
  } catch (cause) {
    if (cause instanceof Error && !cause.message.includes('NEXT_PUBLIC_API_BASE_URL')) throw cause
    throw requestError(cause)
  } finally {
    reader.releaseLock()
  }

  if (completionEvents.length !== 1) {
    throw new Error('Video processing did not return exactly one completed analysis.')
  }
  const completed = completionEvents[0]
  if (!completed) throw new Error('Video processing ended without a completed analysis.')
  return validateResult(completed.result, 'video', {
    input_sha256: completed.input_sha256,
    signature: completed.signature,
    signed_payload: completed.signed_payload,
  })
}

export function predictionLabel(value: PredictionResponse['predicted_class']) {
  return value === 'limping-cow'
    ? 'Lameness Detected'
    : value === 'healthy-cow'
      ? 'Lameness Not Detected'
      : 'Unable to Assess Lameness'
}

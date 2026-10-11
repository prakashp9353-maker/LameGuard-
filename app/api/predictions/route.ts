import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 60

const STORAGE_BUCKET = process.env.NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET || 'lameguard-images'
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_VIDEO_BYTES = 250 * 1024 * 1024

type SignedAnalysis = {
  media_type: 'image' | 'video'
  predicted_class: 'healthy-cow' | 'limping-cow' | null
  confidence: number | null
  status: 'completed'
  model_version: string
  detection_details: unknown[]
  annotated_image_base64: string | null
  annotated_image_mime_type: 'image/jpeg' | 'image/png' | null
  processing_duration_ms: number
  analysis_details: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function removeInlineImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeInlineImages)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.endsWith('_base64'))
      .map(([key, nested]) => [key, removeInlineImages(nested)]),
  )
}

function decodeBase64Image(value: unknown, mimeType: unknown) {
  if (
    typeof value !== 'string' ||
    (mimeType !== 'image/jpeg' && mimeType !== 'image/png') ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error('The signed inference response contains an invalid image.')
  }
  return Buffer.from(value, 'base64')
}

function isAnalysis(value: unknown): value is SignedAnalysis {
  if (!isRecord(value)) return false
  return (
    (value.media_type === 'image' || value.media_type === 'video') &&
    value.status === 'completed' &&
    (value.predicted_class === null ||
      value.predicted_class === 'healthy-cow' ||
      value.predicted_class === 'limping-cow') &&
    (value.confidence === null ||
      (typeof value.confidence === 'number' &&
        Number.isFinite(value.confidence) &&
        value.confidence >= 0 &&
        value.confidence <= 1)) &&
    ((value.predicted_class === null) === (value.confidence === null)) &&
    typeof value.model_version === 'string' &&
    Array.isArray(value.detection_details) &&
    typeof value.processing_duration_ms === 'number' &&
    Number.isFinite(value.processing_duration_ms) &&
    value.processing_duration_ms >= 0 &&
    isRecord(value.analysis_details) &&
    (value.annotated_image_base64 === null ||
      typeof value.annotated_image_base64 === 'string') &&
    (value.annotated_image_mime_type === null ||
      value.annotated_image_mime_type === 'image/jpeg' ||
      value.annotated_image_mime_type === 'image/png')
  )
}

async function digestUpload(file: File) {
  const hash = createHash('sha256')
  const reader = file.stream().getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
    }
  } finally {
    reader.releaseLock()
  }
  return hash.digest('hex')
}

export async function POST(request: Request) {
  const signingSecret = process.env.PREDICTION_SIGNING_SECRET
  if (!signingSecret || Buffer.byteLength(signingSecret, 'utf8') < 32) {
    return NextResponse.json(
      { error: 'Secure prediction saving is not configured. Set the server-only PREDICTION_SIGNING_SECRET.' },
      { status: 503 },
    )
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ error: 'The prediction save request is not valid multipart form data.' }, { status: 400 })
  }

  const media = form.get('file')
  const rawResult = form.get('result')
  const inputSha256 = form.get('input_sha256')
  const signature = form.get('signature')
  if (
    typeof File === 'undefined' ||
    !(media instanceof File) ||
    typeof rawResult !== 'string' ||
    typeof inputSha256 !== 'string' ||
    typeof signature !== 'string'
  ) {
    return NextResponse.json({ error: 'The save request is missing the media or signed inference result.' }, { status: 400 })
  }

  if (!/^[a-f0-9]{64}$/i.test(inputSha256) || !/^[a-f0-9]{64}$/i.test(signature)) {
    return NextResponse.json({ error: 'The inference result signature is invalid.' }, { status: 400 })
  }

  let analysisValue: unknown
  try {
    analysisValue = JSON.parse(rawResult)
  } catch {
    return NextResponse.json({ error: 'The signed inference result is not valid JSON.' }, { status: 400 })
  }
  if (!isAnalysis(analysisValue)) {
    return NextResponse.json({ error: 'The signed inference result has an invalid structure.' }, { status: 400 })
  }
  const analysis = analysisValue

  const maxBytes = analysis.media_type === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES
  const supportedImage = ['image/jpeg', 'image/png'].includes(media.type)
  const supportedVideo = media.type === 'video/mp4' || media.type === 'application/octet-stream'
  if (
    media.size === 0 ||
    media.size > maxBytes ||
    (analysis.media_type === 'image' && !supportedImage) ||
    (analysis.media_type === 'video' && (!supportedVideo || !media.name.toLowerCase().endsWith('.mp4')))
  ) {
    return NextResponse.json({ error: 'The saved media type or size does not match the analyzed upload.' }, { status: 415 })
  }

  let actualSha256: string
  try {
    actualSha256 = await digestUpload(media)
  } catch {
    return NextResponse.json({ error: 'Could not verify the uploaded media bytes.' }, { status: 400 })
  }
  if (actualSha256.toLowerCase() !== inputSha256.toLowerCase()) {
    return NextResponse.json({ error: 'The inference signature is bound to a different media file.' }, { status: 400 })
  }
  const expectedSignature = createHmac('sha256', signingSecret)
    .update(`sha256:${actualSha256}\n${rawResult}`, 'utf8')
    .digest()
  const suppliedSignature = Buffer.from(signature, 'hex')
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    return NextResponse.json({ error: 'The inference result signature could not be verified.' }, { status: 401 })
  }

  let supabase
  let user
  try {
    supabase = await createServerSupabaseClient()
    const { data, error } = await supabase.auth.getUser()
    if (error) {
      return NextResponse.json({ error: `Could not verify the signed-in Supabase user: ${error.message}` }, { status: 503 })
    }
    user = data.user
  } catch (cause) {
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : 'Supabase authentication is unavailable.' },
      { status: 503 },
    )
  }
  if (!user) return NextResponse.json({ error: 'Sign in before saving a prediction.' }, { status: 401 })

  const uploadedPaths: string[] = []
  const upload = async (suffix: string, body: Blob | Buffer, contentType: string) => {
    const path = `${user.id}/${crypto.randomUUID()}-${suffix}`
    const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, body, {
      contentType,
      upsert: false,
    })
    if (error) throw new Error(`Could not save private analysis media: ${error.message}`)
    uploadedPaths.push(path)
    return path
  }

  try {
    const extension = analysis.media_type === 'video'
      ? 'mp4'
      : media.type === 'image/png' ? 'png' : 'jpg'
    const originalPath = await upload(`original.${extension}`, media, media.type)
    let annotatedImagePath: string | null = null

    if (analysis.media_type === 'image' && analysis.annotated_image_base64) {
      const image = decodeBase64Image(
        analysis.annotated_image_base64,
        analysis.annotated_image_mime_type,
      )
      annotatedImagePath = await upload(
        'annotated.jpg',
        image,
        analysis.annotated_image_mime_type ?? 'image/jpeg',
      )
    }

    const analysisDetails = structuredClone(analysis.analysis_details)
    analysisDetails.uploaded_filename = media.name
    if (analysis.media_type === 'image') {
      const bodyPart = analysisDetails.body_part_model
      if (
        isRecord(bodyPart) &&
        typeof bodyPart.annotated_image_base64 === 'string'
      ) {
        const bodyAnnotation = decodeBase64Image(
          bodyPart.annotated_image_base64,
          'image/jpeg',
        )
        bodyPart.annotated_image_path = await upload(
          'body-parts-annotated.jpg',
          bodyAnnotation,
          'image/jpeg',
        )
      }
    } else if (Array.isArray(analysisDetails.frames)) {
      for (const frame of analysisDetails.frames) {
        if (!isRecord(frame)) continue
        if (
          typeof frame.original_frame_base64 === 'string'
        ) {
          const originalFrame = decodeBase64Image(frame.original_frame_base64, 'image/jpeg')
          frame.original_frame_path = await upload(
            `frame-${String(frame.frame_index)}-original.jpg`,
            originalFrame,
            'image/jpeg',
          )
        }
        if (typeof frame.annotated_frame_base64 === 'string') {
          const annotatedFrame = decodeBase64Image(frame.annotated_frame_base64, 'image/jpeg')
          frame.annotated_frame_path = await upload(
            `frame-${String(frame.frame_index)}-annotated.jpg`,
            annotatedFrame,
            'image/jpeg',
          )
        }
        const frameAnalysis = isRecord(frame.analysis_details) ? frame.analysis_details : null
        const bodyPart = frameAnalysis && isRecord(frameAnalysis.body_part_model)
          ? frameAnalysis.body_part_model
          : null
        if (bodyPart && typeof bodyPart.annotated_image_base64 === 'string') {
          const bodyAnnotation = decodeBase64Image(
            bodyPart.annotated_image_base64,
            'image/jpeg',
          )
          bodyPart.annotated_image_path = await upload(
            `frame-${String(frame.frame_index)}-body-parts.jpg`,
            bodyAnnotation,
            'image/jpeg',
          )
        }
      }
    }

    const persistedAnalysis = removeInlineImages(analysisDetails) as Record<string, unknown>
    const { data, error } = await supabase
      .from('lameguard_predictions')
      .insert({
        user_id: user.id,
        original_image_path: originalPath,
        original_media_path: originalPath,
        annotated_image_path: annotatedImagePath,
        annotated_video_path: null,
        media_type: analysis.media_type,
        predicted_class: analysis.predicted_class,
        confidence: analysis.confidence,
        status: analysis.status,
        model_version: analysis.model_version,
        detection_details: analysis.detection_details,
        analysis_details: persistedAnalysis,
        processing_duration_ms: analysis.processing_duration_ms,
        error_message: null,
      })
      .select('id')
      .single()
    if (error) {
      throw new Error(`Inference succeeded, but the database save failed. Apply the media-analysis migration and verify row-level security. ${error.message}`)
    }
    if (!data) throw new Error('Supabase did not return the saved prediction ID.')
    return NextResponse.json({ id: data.id })
  } catch (cause) {
    if (uploadedPaths.length) {
      const { error: cleanupError } = await supabase.storage.from(STORAGE_BUCKET).remove(uploadedPaths)
      if (cleanupError) {
        const message = cause instanceof Error ? cause.message : 'Could not save the prediction.'
        return NextResponse.json({ error: `${message} Private upload cleanup also failed: ${cleanupError.message}` }, { status: 500 })
      }
    }
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : 'Could not persist the verified analysis.' },
      { status: 500 },
    )
  }
}

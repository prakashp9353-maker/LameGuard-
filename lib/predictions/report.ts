import { jsPDF } from 'jspdf'

export type ReportRecord = {
  id: string
  media_type: 'image' | 'video'
  original_media_path: string | null
  original_image_path: string
  annotated_image_path: string | null
  annotated_video_path: string | null
  predicted_class: 'healthy-cow' | 'limping-cow' | null
  confidence: number | null
  status: 'processing' | 'completed' | 'failed'
  model_version: string | null
  detection_details: unknown
  analysis_details: unknown
  processing_duration_ms: number | null
  error_message: string | null
  created_at: string
}

export type ReportImage = { label: string; dataUrl: string }

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function percentage(value: unknown): string {
  const number = finiteNumber(value)
  return number === null ? 'Not available' : `${(number * 100).toFixed(1)}%`
}

function model2GeometryStatus(
  primaryClass: ReportRecord['predicted_class'],
  validObservationCount: number,
): string | null {
  if (primaryClass === 'limping-cow' || primaryClass === 'healthy-cow') return null
  return validObservationCount > 0
    ? 'Geometry observations available; lameness not assessed.'
    : 'Geometry assessment unavailable'
}

function displayClass(record: ReportRecord) {
  if (record.status !== 'completed') return `Analysis ${record.status}`
  if (record.predicted_class === 'limping-cow') return 'Lameness Detected'
  if (record.predicted_class === 'healthy-cow') return 'Lameness Not Detected'
  return 'Unable to Assess Lameness'
}

function guidance(record: ReportRecord) {
  if (record.predicted_class === 'limping-cow') {
    return [
      'Observe gait and weight-bearing without forcing unnecessary movement if the cow appears painful.',
      'Provide clean, dry, non-slip resting conditions and arrange a veterinary examination.',
      'Seek prompt veterinary care if the cow cannot stand or bear weight, has severe pain, or appears acutely injured or unwell.',
    ]
  }
  if (record.predicted_class === 'healthy-cow') {
    return [
      'Continue routine observation of gait and weight-bearing.',
      'Arrange veterinary examination if limping, pain, uneven weight-bearing, or other concerning signs are present or persist.',
    ]
  }
  return [
    'If lameness or other concerning signs are present, arrange veterinary examination rather than relying on this inconclusive analysis.',
    'For another video analysis, use a clear side view with the cow walking unobstructed.',
  ]
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Not available'
    : new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date)
}

function className(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'Unknown class'
}

function detectionLines(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    const detection = asObject(item)
    if (!detection) return []
    const confidence = finiteNumber(detection.confidence)
    const bbox = Array.isArray(detection.bbox_normalized)
      ? detection.bbox_normalized
          .filter((coordinate): coordinate is number =>
            typeof coordinate === 'number' && Number.isFinite(coordinate),
          )
          .map(coordinate => coordinate.toFixed(3))
          .join(', ')
      : null
    return [
      `${index + 1}. ${className(detection.class)} — confidence ${percentage(confidence)}${bbox ? `; normalized bounds [${bbox}]` : ''}`,
    ]
  })
}

function verifiedMetricLines(value: unknown): string[] {
  const metrics = asObject(value)
  if (!metrics || metrics.verified !== true || typeof metrics.source !== 'string' || !metrics.source.trim()) {
    return []
  }
  const split = metrics.evaluation_split
  if (!['training', 'validation', 'test'].includes(String(split))) return []
  const entries: [string, unknown][] = [
    ['Accuracy', metrics.accuracy],
    ['Precision', metrics.precision],
    ['Recall', metrics.recall],
    ['F1-score', metrics.f1_score ?? metrics.f1],
    ['mAP@0.5', metrics.map50 ?? metrics.mAP50],
    ['mAP@0.5:0.95', metrics.map50_95 ?? metrics.mAP50_95],
  ]
  return entries.flatMap(([label, metric]) => {
    const number = finiteNumber(metric)
    const formatted = number !== null && number >= 0 && number <= 100
      ? number <= 1
        ? `${(number * 100).toFixed(1)}%`
        : `${number.toFixed(1)}%`
      : 'Not available'
    return [`${label}: ${formatted}`]
  })
}

function hasVerifiedMetrics(
  metricsValue: unknown,
  primaryModelValue: unknown,
): boolean {
  const metrics = asObject(metricsValue)
  const primaryModel = asObject(primaryModelValue)
  return Boolean(
    metrics &&
    primaryModel &&
    metrics.verified === true &&
    primaryModel.identity_verified === true &&
    typeof metrics.source === 'string' &&
    metrics.source.trim() &&
    metrics.evaluation_split &&
    metrics.checkpoint_sha256 === primaryModel.checkpoint_sha256 &&
    verifiedMetricLines(metrics).some(line => !line.endsWith('Not available')),
  )
}

function videoClassConfidences(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const confidences = new Map<string, number[]>()
  for (const frame of value) {
    const detections = asObject(frame)?.detection_details
    if (!Array.isArray(detections)) continue
    for (const item of detections) {
      const detection = asObject(item)
      const confidence = finiteNumber(detection?.confidence)
      if (confidence === null) continue
      const name = className(detection?.class)
      confidences.set(name, [...(confidences.get(name) ?? []), confidence])
    }
  }
  return [...confidences.entries()]
    .map(([name, values]) =>
      `${name}: ${values.length} detection${values.length === 1 ? '' : 's'}; confidence${values.length === 1 ? '' : 's'} ${values.map(value => percentage(value)).join(', ')}`,
    )
}

function videoBodyPartDetectionLines(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(frameValue => {
    const frame = asObject(frameValue)
    const analysis = asObject(frame?.analysis_details)
    const bodyPart = asObject(analysis?.body_part_model)
    if (!Array.isArray(bodyPart?.detections)) return []
    return bodyPart.detections.flatMap(detectionValue => {
      const detection = asObject(detectionValue)
      if (!detection) return []
      return [
        `Frame ${String(frame?.frame_index ?? 'Not available')} at ${String(frame?.timestamp_seconds ?? 'Not available')}s · ${className(detection.class)} · confidence ${percentage(detection.confidence)}`,
      ]
    })
  })
}

function videoGeometryObservationCount(value: unknown): number {
  if (!Array.isArray(value)) return 0
  return value.reduce((total, frameValue) => {
    const frame = asObject(frameValue)
    const analysis = asObject(frame?.analysis_details)
    const bodyPart = asObject(analysis?.body_part_model)
    const geometry = asObject(bodyPart?.geometry_features)
    return total + (Array.isArray(geometry?.observations) ? geometry.observations.length : 0)
  }, 0)
}

export function generatePredictionReport(record: ReportRecord, images: ReportImage[]) {
  if (
    images.length === 0 &&
    !(record.media_type === 'video' && record.original_media_path)
  ) {
    throw new Error('The report cannot be generated because no saved original or representative image is available.')
  }

  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  const margin = 16
  const contentWidth = pageWidth - margin * 2
  let y = margin

  const addText = (text: string, size = 10, bold = false, spacing = 1.5) => {
    pdf.setFont('helvetica', bold ? 'bold' : 'normal')
    pdf.setFontSize(size)
    const lines = pdf.splitTextToSize(text, contentWidth)
    const lineHeight = size * 0.42 + spacing
    let offset = 0
    while (offset < lines.length) {
      const availableLines = Math.floor((pageHeight - margin - y) / lineHeight)
      if (availableLines <= 0) {
        pdf.addPage()
        y = margin
        continue
      }
      const chunk = lines.slice(offset, offset + availableLines)
      pdf.text(chunk, margin, y)
      y += chunk.length * lineHeight + 2
      offset += chunk.length
    }
  }

  const addImage = (image: ReportImage) => {
    const properties = pdf.getImageProperties(image.dataUrl)
    const maxHeight = 82
    const scale = Math.min(contentWidth / properties.width, maxHeight / properties.height, 1)
    const width = properties.width * scale
    const height = properties.height * scale
    if (y + height + 12 > pageHeight - margin) {
      pdf.addPage()
      y = margin
    }
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(9)
    pdf.text(image.label, margin, y)
    y += 5
    const format = image.dataUrl.startsWith('data:image/png') ? 'PNG' : 'JPEG'
    pdf.addImage(image.dataUrl, format, margin, y, width, height, undefined, 'FAST')
    y += height + 7
  }

  const details = asObject(record.analysis_details) ?? {}
  const primary = asObject(details.primary_model)
  const bodyPart = asObject(details.body_part_model)
  const bodyPartIdentity = asObject(bodyPart?.model_identity)
  const videoGeometry = asObject(details.experimental_geometry_assessment)
  const sampling = asObject(details.sampling)
  const summary = asObject(details.frame_summary)
  const primaryIdentityVerified = primary?.identity_verified === true
  const primaryModelName = primaryIdentityVerified && typeof primary.model_name === 'string'
    ? primary.model_name
    : 'Model identity not verified'
  const primaryModelVersion = primaryIdentityVerified && typeof primary.model_version === 'string'
    ? primary.model_version
    : null
  const threshold = record.media_type === 'video'
    ? details.classification_confidence_threshold
    : primary?.configured_confidence_threshold
  const reportGeneratedAt = new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date())
  const uploadedFilename = typeof details.uploaded_filename === 'string'
    ? details.uploaded_filename.replace(/[\r\n\t]/g, ' ').trim()
    : null

  pdf.setTextColor(35, 81, 55)
  addText('LameGuard AI', 21, true)
  pdf.setTextColor(28, 35, 29)
  addText('Computer Vision-Based Animal Lameness Detection', 12, true)
  addText(`Saved analysis ID: ${record.id}`, 9)
  addText(`Prediction date: ${formatDate(record.created_at)}`, 9)
  addText(`Report generated: ${reportGeneratedAt}`, 9)
  addText(`Final result: ${displayClass(record)}`, 13, true)
  addText(`Assessment: ${String(details.assessment ?? 'Not available')}`)
  addText(
    record.media_type === 'image'
      ? `Detection confidence: ${percentage(record.confidence)}`
      : `Selected-class confidence: ${percentage(record.confidence)}`,
  )
  addText(`Confidence threshold: ${percentage(threshold)}`)
  addText(`Primary model: ${primaryModelName}`)
  if (primaryModelVersion) addText(`Primary checkpoint SHA-256: ${primaryModelVersion}`)
  else addText('Primary checkpoint version: Not available')
  addText(
    `Processing duration: ${finiteNumber(record.processing_duration_ms) === null ? 'Not available' : `${record.processing_duration_ms} ms`}`,
  )

  if (record.media_type === 'video') {
    addText('Video analysis', 12, true)
    addText(`Original video filename: ${uploadedFilename ?? 'Not available'}`)
    addText(`Original video: ${record.original_media_path ? 'saved in private storage' : 'Not available'}`)
    if (record.annotated_video_path) {
      addText('Annotated video: available in saved analysis artifacts; representative annotated frames are included when available.')
    } else {
      addText('Annotated video: Not available')
    }
    addText(`Video duration: ${finiteNumber(sampling?.source_duration_seconds) === null ? 'Not available' : `${sampling?.source_duration_seconds} seconds`}`)
    addText(`Video FPS: ${finiteNumber(sampling?.source_fps) === null ? 'Not available' : String(sampling?.source_fps)}`)
    addText(`Source-frame count: ${String(sampling?.source_frame_count ?? 'Not available')}`)
    addText(`Total sampled frames: ${String(sampling?.sampled_frame_count ?? 'Not available')}`)
    addText(`Frames with qualifying lame-class detections: ${String(summary?.frames_with_limping_cow_detection ?? 'Not available')}`)
    addText(`Frames with qualifying healthy-class detections: ${String(summary?.frames_with_healthy_cow_detection ?? 'Not available')}`)
    addText(`Frames without a supported class: ${String(summary?.frames_without_supported_class_detection ?? 'Not available')}`)
    addText(
      `Aggregation rule: ${String(details.classification_rule ?? 'A qualifying lame-class detection in any sampled frame takes priority over healthy-class detections.')}`,
    )
    const framesAnalyzedByModel2 = finiteNumber(videoGeometry?.frames_with_model_2_analysis) ?? 0
    const videoBodyDetections = videoBodyPartDetectionLines(details.frames)
    const videoObservationsAvailable = videoGeometryObservationCount(details.frames)
    const videoModel2Ran = framesAnalyzedByModel2 > 0 ||
      videoBodyDetections.length > 0 ||
      videoObservationsAvailable > 0
    const showVideoGeometry = videoModel2Ran ||
      (record.predicted_class === null && videoGeometry !== null)
    if (showVideoGeometry) {
      addText('Model 2 · Body-part observations', 12, true)
      if (videoModel2Ran && bodyPartIdentity?.identity_verified === true) {
        addText(`Body-part model: ${String(bodyPartIdentity.model_name)}`)
        addText(`Body-part checkpoint SHA-256: ${String(bodyPartIdentity.model_version ?? 'Not available')}`)
      }
      const geometryStatus = model2GeometryStatus(
        record.predicted_class,
        finiteNumber(videoGeometry?.valid_observation_count) ?? videoObservationsAvailable,
      )
      if (geometryStatus) addText(geometryStatus)
      const videoGeometryCounts = asObject(videoGeometry?.class_counts)
      if (videoModel2Ran && videoGeometryCounts) {
        addText('Detection counts across sampled frames', 11, true)
        for (const [name, count] of Object.entries(videoGeometryCounts)) {
          addText(`${name}: ${String(count)}`, 9)
        }
      }
    }
    let videoObservationCount = 0
    if (videoModel2Ran && Array.isArray(details.frames)) {
      for (const frameValue of details.frames) {
        const frame = asObject(frameValue)
        const frameAnalysis = asObject(frame?.analysis_details)
        const frameBodyPart = asObject(frameAnalysis?.body_part_model)
        const frameGeometry = asObject(frameBodyPart?.geometry_features)
        if (!Array.isArray(frameGeometry?.observations)) continue
        for (const observationValue of frameGeometry.observations) {
          const observation = asObject(observationValue)
          if (!observation) continue
          videoObservationCount += 1
          const bounds = asObject(observation.bbox_normalized)
          const center = asObject(observation.bbox_center_normalized)
          const boundsText = bounds
            ? ['x_min', 'y_min', 'x_max', 'y_max']
                .map(key => finiteNumber(bounds[key])?.toFixed(3) ?? '—')
                .join(', ')
            : 'Not available'
          const centerText = center
            ? ['x', 'y'].map(key => finiteNumber(center[key])?.toFixed(3) ?? '—').join(', ')
            : 'Not available'
          addText(
            `Frame ${String(frame?.frame_index ?? 'Not available')} at ${String(frame?.timestamp_seconds ?? 'Not available')}s · ${className(observation.class)} · confidence ${percentage(observation.confidence)} · bounds [${boundsText}] · box center [${centerText}] · width ${String(observation.width ?? 'Not available')}, height ${String(observation.height ?? 'Not available')}, area ${String(observation.area ?? 'Not available')}`,
            9,
          )
        }
      }
    }
    if (videoModel2Ran && videoObservationCount === 0 && videoBodyDetections.length > 0) {
      addText('Detected body-part classes', 11, true)
      videoBodyDetections.forEach(line => addText(line, 9))
    } else if (videoModel2Ran && videoBodyDetections.length === 0) {
      addText('No body-part detections returned.')
    } else if (showVideoGeometry && !videoModel2Ran && bodyPart?.status === 'not_loaded') {
      addText('Body-part model unavailable.')
    }
    const confidenceDetails = videoClassConfidences(details.frames)
    if (confidenceDetails.length > 0) {
      addText('Per-class detection confidence', 11, true)
      confidenceDetails.forEach(line => addText(line, 9))
    }
  } else {
    addText(`Original image filename: ${uploadedFilename ?? 'Not available'}`)
    const experimentalAssessment = asObject(bodyPart?.experimental_assessment)
    const imageGeometry = asObject(bodyPart?.geometry_features)
    const bodyDetections = detectionLines(bodyPart?.detections)
    if (bodyPart?.status !== 'not_requested' && bodyPart) {
      if (bodyPartIdentity?.identity_verified === true) {
        addText(`Body-part model: ${String(bodyPartIdentity.model_name)}`)
        addText(`Body-part checkpoint SHA-256: ${String(bodyPartIdentity.model_version ?? 'Not available')}`)
      }
    }
    if ((bodyPart && bodyPart.status !== 'not_requested') || record.predicted_class === null) {
      addText('Model 2 · Body-part observations', 12, true)
    }
    if (bodyPart?.status === 'unavailable') {
      addText('Body-part model unavailable.')
    } else if (bodyPart?.status === 'completed' && bodyDetections.length === 0) {
      addText('No body-part detections returned.')
    }
    const geometryStatus = model2GeometryStatus(
      record.predicted_class,
      finiteNumber(experimentalAssessment?.valid_observation_count) ??
        (Array.isArray(imageGeometry?.observations) ? imageGeometry.observations.length : 0),
    )
    if (geometryStatus) addText(geometryStatus)
    if (bodyPart) {
      const observations = imageGeometry?.observations
      const hasGeometryObservations = Array.isArray(observations) && observations.length > 0
      if (bodyDetections.length > 0 && !hasGeometryObservations) {
        addText('Detected body-part classes', 11, true)
        bodyDetections.forEach(line => addText(line, 9))
      }
      const geometry = imageGeometry
      const classCounts = asObject(geometry?.class_counts)
      if (classCounts) {
        addText('Detection counts', 11, true)
        for (const [name, count] of Object.entries(classCounts)) {
          addText(`${name}: ${String(count)}`, 9)
        }
      }
      if (Array.isArray(observations)) {
        for (const observation of observations) {
          const item = asObject(observation)
          if (!item) continue
          const bounds = asObject(item.bbox_normalized)
          const center = asObject(item.bbox_center_normalized)
          const boundsText = bounds
            ? ['x_min', 'y_min', 'x_max', 'y_max']
                .map(key => finiteNumber(bounds[key])?.toFixed(3) ?? '—')
                .join(', ')
            : 'Not available'
          const centerText = center
            ? ['x', 'y'].map(key => finiteNumber(center[key])?.toFixed(3) ?? '—').join(', ')
            : 'Not available'
          addText(
            `${className(item.class)} · confidence ${percentage(item.confidence)} · bounds [${boundsText}] · box center [${centerText}] · width ${String(item.width ?? 'Not available')}, height ${String(item.height ?? 'Not available')}, area ${String(item.area ?? 'Not available')}`,
            9,
          )
        }
      }
    }
    const detections = detectionLines(
      Array.isArray(record.detection_details)
        ? record.detection_details
        : primary?.detections,
    )
    if (detections.length > 0) {
      addText('Primary model detections', 11, true)
      detections.forEach(line => addText(line, 9))
    }
  }

  addText('MODEL EVALUATION METRICS', 12, true)
  const metrics = verifiedMetricLines(details.evaluation_metrics)
  if (hasVerifiedMetrics(details.evaluation_metrics, primary)) {
    const evaluation = asObject(details.evaluation_metrics)
    addText(`Evaluation split: ${String(evaluation?.evaluation_split)}`)
    addText(`Evaluation source: ${String(evaluation?.source)}`)
    addText(`Evaluation dataset: ${String(evaluation?.dataset_name ?? 'Not available')}`)
    addText(`Evaluated samples: ${String(evaluation?.sample_count ?? 'Not available')}`)
    metrics.forEach(line => addText(line, 9))
  } else {
    addText('Not evaluated')
  }

  for (const image of images) addImage(image)

  addText('Care guidance', 12, true)
  for (const item of guidance(record)) addText(`- ${item}`)

  pdf.save(`lameguard-report-${record.id}.pdf`)
}

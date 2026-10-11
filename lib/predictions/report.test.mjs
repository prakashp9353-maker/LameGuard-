import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { jsPDF } from 'jspdf'
import { predictionLabel } from './api.ts'
import { generatePredictionReport } from './report.ts'
import { model2GeometryStatus } from './model2-presentation.ts'

const originalMethods = {}
const initializationObserver = ['initialized', function () {
  const document = this
  document.text = function (text) {
    outputText.push(Array.isArray(text) ? text.join('\n') : String(text))
    return this
  }
  document.save = function (filename) {
    savedFilename = filename
    return this
  }
}]
let outputText
let embeddedImages
let savedFilename

function metadata(modelName, hash) {
  return {
    identity_verified: true,
    model_name: modelName,
    model_version: `sha256:${hash}`,
    checkpoint_sha256: hash,
  }
}

function baseRecord(overrides = {}) {
  return {
    id: 'analysis-123',
    media_type: 'image',
    original_media_path: 'private/original.jpg',
    original_image_path: 'private/original.jpg',
    annotated_image_path: 'private/annotated.jpg',
    annotated_video_path: null,
    predicted_class: 'limping-cow',
    confidence: 0.873,
    status: 'completed',
    model_version: 'YOLO26n',
    detection_details: [
      { class: 'limping-cow', confidence: 0.873, bbox_normalized: [0.1, 0.2, 0.8, 0.9] },
    ],
    analysis_details: {
      assessment: 'possible-lameness',
      uploaded_filename: 'cow-image.png',
      primary_model: {
        ...metadata('YOLO26n', 'a'.repeat(64)),
        configured_confidence_threshold: 0.25,
      },
      body_part_model: {
        status: 'completed',
        model_name: 'YOLO26s',
        model_identity: metadata('YOLO26s', 'b'.repeat(64)),
        detections: [{ class: 'hoof', confidence: 0.92, bbox_normalized: [0.2, 0.3, 0.4, 0.6] }],
        geometry_features: {
          class_counts: { hoof: 1, cow: 0 },
          observations: [
            { class: 'hoof', confidence: 0.92, bbox_normalized: { x_min: 0.2, y_min: 0.3, x_max: 0.4, y_max: 0.6 }, bbox_center_normalized: { x: 0.3, y: 0.45 }, width: 0.2, height: 0.3, area: 0.06 },
          ],
        },
        experimental_assessment: {
          status: 'unable_to_assess',
          label: 'Unable to Assess',
          evidence_status: 'descriptive_geometry_available',
          valid_observation_count: 1,
        },
      },
    },
    processing_duration_ms: 1250,
    error_message: null,
    created_at: '2026-10-11T10:00:00.000Z',
    ...overrides,
  }
}

function textOutput() {
  return outputText.join('\n')
}

beforeEach(() => {
  outputText = []
  embeddedImages = []
  savedFilename = null
  for (const method of ['getImageProperties', 'addImage']) {
    originalMethods[method] = jsPDF.API[method]
  }
  jsPDF.API.getImageProperties = () => ({ width: 1, height: 1 })
  jsPDF.API.addImage = function (...args) {
    embeddedImages.push(args)
    return this
  }
  jsPDF.API.events.push(initializationObserver)
})

afterEach(() => {
  for (const [method, original] of Object.entries(originalMethods)) {
    jsPDF.API[method] = original
  }
  const index = jsPDF.API.events.indexOf(initializationObserver)
  if (index !== -1) jsPDF.API.events.splice(index, 1)
})

test('generates image report with predictions, detections, threshold and available images', () => {
  const images = [
    { label: 'Original image', dataUrl: 'data:image/png;base64,AA==' },
    { label: 'Primary model annotated image', dataUrl: 'data:image/jpeg;base64,AA==' },
    { label: 'Body-part model annotated image', dataUrl: 'data:image/jpeg;base64,AA==' },
  ]

  generatePredictionReport(baseRecord(), images)

  const output = textOutput()
  assert.match(output, /Final result: Lameness Detected/)
  assert.match(output, /Detection confidence: 87\.3%/)
  assert.match(output, /Confidence threshold: 25\.0%/)
  assert.match(output, /Primary model: YOLO26n/)
  assert.match(output, /Body-part model: YOLO26s/)
  assert.match(output, /hoof · confidence 92\.0%/)
  assert.match(output, /Model 2 · Body-part observations/)
  assert.match(output, /hoof: 1/)
  assert.match(output, /hoof · confidence 92\.0%/)
  assert.doesNotMatch(output, /Geometry assessment unavailable|Inconclusive|Unable to Assess/)
  assert.match(output, /Saved analysis ID: analysis-123/)
  assert.match(output, /Prediction date:/)
  assert.match(output, /Report generated:/)
  assert.match(output, /Processing duration: 1250 ms/)
  assert.match(output, /MODEL EVALUATION METRICS[\s\S]*Not evaluated/)
  assert.equal(embeddedImages.length, 3)
  assert.equal(savedFilename, 'lameguard-report-analysis-123.pdf')
})

test('a lame Model 1 result with no Model 2 detections has no secondary lameness status', () => {
  const record = baseRecord({
    analysis_details: {
      primary_model: {
        ...metadata('YOLO26n', 'a'.repeat(64)),
        configured_confidence_threshold: 0.25,
      },
      body_part_model: {
        status: 'completed',
        detections: [],
        geometry_features: { class_counts: { hoof: 0 }, observations: [] },
        experimental_assessment: { evidence_status: 'insufficient', valid_observation_count: 0 },
      },
    },
  })

  generatePredictionReport(record, [{ label: 'Original image', dataUrl: 'data:image/png;base64,AA==' }])

  const output = textOutput()
  assert.match(output, /Final result: Lameness Detected/)
  assert.match(output, /No body-part detections returned/)
  assert.doesNotMatch(output, /Geometry assessment unavailable|Inconclusive|Unable to Assess/)
})

test('generates video report with saved filename, frame counts, classification and confidences', () => {
  const record = baseRecord({
    media_type: 'video',
    original_media_path: 'private/clip.mp4',
    predicted_class: 'limping-cow',
    confidence: 0.46,
    analysis_details: {
      assessment: 'possible-lameness',
      uploaded_filename: 'barn-walk.mp4',
      primary_model: {
        ...metadata('YOLO26n', 'a'.repeat(64)),
        configured_confidence_threshold: 0.25,
      },
      classification_confidence_threshold: 0.25,
      classification_rule: 'A qualifying lame-class detection in any sampled frame takes priority over healthy-class detections.',
      sampling: {
        sampled_frame_count: 22,
        source_duration_seconds: 44,
        source_fps: 30,
        source_frame_count: 1320,
      },
      frame_summary: {
        frames_with_limping_cow_detection: 3,
        frames_with_healthy_cow_detection: 0,
        frames_without_supported_class_detection: 19,
      },
      frames: [
        {
          frame_index: 1,
          timestamp_seconds: 2,
          detection_details: [{ class: 'limping-cow', confidence: 0.46 }],
          analysis_details: {
            body_part_model: {
              geometry_features: {
                observations: [
                  {
                    class: 'hoof',
                    confidence: 0.92,
                    bbox_normalized: { x_min: 0.2, y_min: 0.3, x_max: 0.4, y_max: 0.6 },
                    bbox_center_normalized: { x: 0.3, y: 0.45 },
                    width: 0.2,
                    height: 0.3,
                    area: 0.06,
                  },
                ],
              },
            },
          },
        },
        { detection_details: [{ class: 'healthy-cow', confidence: 0.81 }] },
      ],
      body_part_model: {
        model_identity: metadata('YOLO26s', 'b'.repeat(64)),
      },
      experimental_geometry_assessment: {
        label: 'Unable to Assess',
        evidence_status: 'descriptive_geometry_available',
        frames_with_model_2_analysis: 22,
        frames_with_valid_observations: 18,
        valid_observation_count: 54,
        class_counts: { hoof: 30, cow: 18 },
        decision_rule: 'Per-frame geometry only; no validated lameness reference range is configured.',
      },
    },
  })

  generatePredictionReport(record, [
    { label: 'Original video frame at 2.0s', dataUrl: 'data:image/jpeg;base64,AA==' },
    { label: 'Annotated video frame at 2.0s', dataUrl: 'data:image/jpeg;base64,AA==' },
  ])

  const output = textOutput()
  assert.match(output, /Original video filename: barn-walk\.mp4/)
  assert.match(output, /Video duration: 44 seconds/)
  assert.match(output, /Video FPS: 30/)
  assert.match(output, /Source-frame count: 1320/)
  assert.match(output, /Total sampled frames: 22/)
  assert.match(output, /Frames with qualifying lame-class detections: 3/)
  assert.match(output, /Frames with qualifying healthy-class detections: 0/)
  assert.match(output, /Frames without a supported class: 19/)
  assert.match(output, /Final result: Lameness Detected/)
  assert.match(output, /Selected-class confidence: 46\.0%/)
  assert.match(output, /qualifying lame-class detection in any sampled frame takes priority/)
  assert.match(output, /limping-cow: 1 detection; confidence 46\.0%/)
  assert.match(output, /healthy-cow: 1 detection; confidence 81\.0%/)
  assert.match(output, /Body-part model: YOLO26s/)
  assert.match(output, /Model 2 · Body-part observations/)
  assert.doesNotMatch(output, /Geometry assessment unavailable|Inconclusive|Unable to Assess/)
  assert.match(output, /hoof: 30/)
  assert.match(output, /Frame 1 at 2s · hoof · confidence 92\.0%/)
  assert.match(output, /box center \[0\.300, 0\.450\]/)
  assert.equal(embeddedImages.length, 2)
  assert.equal(savedFilename, 'lameguard-report-analysis-123.pdf')
})

test('keeps secondary geometry descriptive when Model 1 has no supported class', () => {
  const record = baseRecord({
    predicted_class: null,
    confidence: null,
    detection_details: [],
    analysis_details: {
      assessment: 'inconclusive',
      primary_model: {
        ...metadata('YOLO26n', 'a'.repeat(64)),
        configured_confidence_threshold: 0.25,
      },
      body_part_model: {
        status: 'completed',
        detections: [{ class: 'hoof', confidence: 0.92, bbox_normalized: [0.2, 0.3, 0.4, 0.6] }],
        geometry_features: {
          class_counts: { hoof: 1, cow: 0 },
          observations: [],
        },
        experimental_assessment: {
          evidence_status: 'descriptive_geometry_available',
          valid_observation_count: 1,
        },
      },
    },
  })

  generatePredictionReport(record, [{ label: 'Original image', dataUrl: 'data:image/png;base64,AA==' }])

  const output = textOutput()
  assert.match(output, /Final result: Unable to Assess Lameness/)
  assert.match(output, /Geometry observations available; lameness not assessed/)
  assert.match(output, /hoof — confidence 92\.0%/)
  assert.doesNotMatch(output, /Unvalidated research prototype result|decision rule/)
})

test('video report uses concise Model 2 geometry status when Model 1 has no supported class', () => {
  const record = baseRecord({
    media_type: 'video',
    original_media_path: 'private/clip.mp4',
    predicted_class: null,
    confidence: null,
    detection_details: [],
    analysis_details: {
      assessment: 'inconclusive',
      primary_model: {
        ...metadata('YOLO26n', 'a'.repeat(64)),
        configured_confidence_threshold: 0.25,
      },
      sampling: { sampled_frame_count: 1, source_duration_seconds: 2 },
      frame_summary: {
        frames_with_limping_cow_detection: 0,
        frames_with_healthy_cow_detection: 0,
        frames_without_supported_class_detection: 1,
      },
      body_part_model: { status: 'loaded' },
      experimental_geometry_assessment: {
        evidence_status: 'descriptive_geometry_available',
        frames_with_model_2_analysis: 1,
        valid_observation_count: 1,
        class_counts: { hoof: 1 },
      },
      frames: [{
        frame_index: 0,
        timestamp_seconds: 0,
        detection_details: [],
        analysis_details: {
          body_part_model: {
            detections: [{ class: 'hoof', confidence: 0.9 }],
            geometry_features: {
              observations: [{
                class: 'hoof',
                confidence: 0.9,
                bbox_normalized: { x_min: 0.2, y_min: 0.3, x_max: 0.4, y_max: 0.5 },
                bbox_center_normalized: { x: 0.3, y: 0.4 },
                width: 0.2,
                height: 0.2,
                area: 0.04,
              }],
            },
          },
        },
      }],
    },
  })

  generatePredictionReport(record, [{ label: 'Original video frame', dataUrl: 'data:image/jpeg;base64,AA==' }])

  const output = textOutput()
  assert.match(output, /Final result: Unable to Assess Lameness/)
  assert.match(output, /Geometry observations available; lameness not assessed/)
  assert.match(output, /Frame 0 at 0s · hoof · confidence 90\.0%/)
  assert.doesNotMatch(output, /Inconclusive|Unvalidated research prototype result/)
})

test('reports unavailable geometry concisely when Model 1 and Model 2 have no detections', () => {
  const record = baseRecord({
    predicted_class: null,
    confidence: null,
    detection_details: [],
    analysis_details: {
      assessment: 'inconclusive',
      primary_model: {
        ...metadata('YOLO26n', 'a'.repeat(64)),
        configured_confidence_threshold: 0.25,
      },
      body_part_model: {
        status: 'completed',
        detections: [],
        geometry_features: { observations: [], class_counts: { hoof: 0 } },
        experimental_assessment: {
          evidence_status: 'insufficient',
          valid_observation_count: 0,
        },
      },
    },
  })

  generatePredictionReport(record, [{ label: 'Original image', dataUrl: 'data:image/png;base64,AA==' }])

  const output = textOutput()
  assert.match(output, /Geometry assessment unavailable/)
  assert.match(output, /No body-part detections returned/)
  assert.doesNotMatch(output, /decision rule|not an anatomical landmark|confidence is not/)
})

test('Model 2 presentation never classifies when Model 1 already has a supported result', () => {
  assert.equal(model2GeometryStatus('limping-cow', 4), null)
  assert.equal(model2GeometryStatus('healthy-cow', 4), null)
  assert.equal(model2GeometryStatus(null, 4), 'Geometry observations available; lameness not assessed.')
  assert.equal(model2GeometryStatus(null, 0), 'Geometry assessment unavailable')
})

test('uses requested display labels without changing underlying class values', () => {
  assert.equal(predictionLabel('limping-cow'), 'Lameness Detected')
  assert.equal(predictionLabel('healthy-cow'), 'Lameness Not Detected')
  assert.equal(predictionLabel(null), 'Unable to Assess Lameness')

  for (const [predictedClass, expectedLabel] of [
    ['healthy-cow', 'Lameness Not Detected'],
    [null, 'Unable to Assess Lameness'],
  ]) {
    const record = baseRecord({
      predicted_class: predictedClass,
      confidence: predictedClass === null ? null : 0.81,
      analysis_details: {
        assessment: predictedClass === null ? 'inconclusive' : 'healthy-looking',
        primary_model: {
          ...metadata('YOLO26n', 'a'.repeat(64)),
          configured_confidence_threshold: 0.25,
        },
      },
    })
    generatePredictionReport(record, [{ label: 'Original image', dataUrl: 'data:image/png;base64,AA==' }])
    assert.match(textOutput(), new RegExp(`Final result: ${expectedLabel}`))
  }
})

test('includes verified evaluation metrics tied to the checkpoint and labels the data split', () => {
  const record = baseRecord({
    analysis_details: {
      ...baseRecord().analysis_details,
      evaluation_metrics: {
        verified: true,
        source: 'Documented held-out evaluation run',
        evaluation_split: 'test',
        dataset_name: 'LameGuard test set',
        sample_count: 120,
        checkpoint_sha256: 'a'.repeat(64),
        accuracy: 0.91,
        precision: 0.92,
        recall: 0.9,
        f1_score: 0.91,
        map50: 0.95,
        map50_95: 0.81,
      },
    },
  })

  generatePredictionReport(record, [{ label: 'Original image', dataUrl: 'data:image/png;base64,AA==' }])

  const output = textOutput()
  assert.match(output, /MODEL EVALUATION METRICS/)
  assert.match(output, /Evaluation split: test/)
  assert.match(output, /Evaluation dataset: LameGuard test set/)
  assert.match(output, /Evaluated samples: 120/)
  assert.match(output, /Accuracy: 91\.0%/)
  assert.match(output, /mAP@0\.5: 95\.0%/)
  assert.match(output, /mAP@0\.5:0\.95: 81\.0%/)
})

test('marks individual metrics unavailable when a verified run omits them', () => {
  const record = baseRecord({
    analysis_details: {
      ...baseRecord().analysis_details,
      evaluation_metrics: {
        verified: true,
        source: 'Documented validation run',
        evaluation_split: 'validation',
        checkpoint_sha256: 'a'.repeat(64),
        precision: 0.82,
      },
    },
  })

  generatePredictionReport(record, [{ label: 'Original image', dataUrl: 'data:image/png;base64,AA==' }])

  const output = textOutput()
  assert.match(output, /Precision: 82\.0%/)
  assert.match(output, /Accuracy: Not available/)
  assert.match(output, /Recall: Not available/)
  assert.match(output, /F1-score: Not available/)
  assert.match(output, /mAP@0\.5: Not available/)
  assert.match(output, /mAP@0\.5:0\.95: Not available/)
  assert.match(output, /Evaluation dataset: Not available/)
  assert.match(output, /Evaluated samples: Not available/)
})

test('does not show unverified metrics or trust stale model labels', () => {
  const record = baseRecord({
    model_version: 'YOLO11n',
    analysis_details: {
      uploaded_filename: 'image.png',
      primary_model: {
        model_name: 'YOLO26n',
        identity_verified: false,
      },
      evaluation_metrics: {
        verified: true,
        source: 'Unlinked metrics',
        evaluation_split: 'test',
        accuracy: 0.99,
      },
    },
  })

  generatePredictionReport(record, [{ label: 'Original image', dataUrl: 'data:image/png;base64,AA==' }])

  const output = textOutput()
  assert.match(output, /Primary model: Model identity not verified/)
  assert.doesNotMatch(output, /YOLO11n/)
  assert.doesNotMatch(output, /YOLO26n/)
  assert.match(output, /MODEL EVALUATION METRICS[\s\S]*Not evaluated/)
  assert.doesNotMatch(output, /Accuracy: 99\.0%/)
})

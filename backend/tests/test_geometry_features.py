import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import (
    BASE_DIR,
    BODY_PART_CLASSES,
    analyze_image,
    aggregate_video_predictions,
    configured_model_path,
    experimental_geometry_assessment,
    geometry_features,
    loaded_model_metadata,
    primary_class,
    video_geometry_assessment,
)


class GeometryFeaturesTests(unittest.TestCase):
    def test_loaded_checkpoint_metadata_verifies_architecture_classes_and_hash(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            checkpoint = Path(temporary_directory) / "lameness_best.pt"
            checkpoint.write_bytes(b"checkpoint fixture")
            model = SimpleNamespace(
                model=SimpleNamespace(yaml={"yaml_file": "yolo26n.yaml"}),
                names={0: "healthy-cow", 1: "limping-cow"},
            )
            with (
                patch("main.PRIMARY_MODEL_PATH", checkpoint),
                patch.dict("main._model_metadata", {}, clear=True),
            ):
                metadata = loaded_model_metadata("primary", model)

        self.assertEqual(metadata["model_name"], "YOLO26n")
        self.assertTrue(metadata["identity_verified"])
        self.assertEqual(metadata["checkpoint_filename"], "lameness_best.pt")
        self.assertTrue(metadata["checkpoint_sha256"])

    def test_loaded_body_part_metadata_normalizes_checkpoint_class_name_case(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            checkpoint = Path(temporary_directory) / "body_parts_best.pt"
            checkpoint.write_bytes(b"body checkpoint fixture")
            model = SimpleNamespace(
                model=SimpleNamespace(yaml={"yaml_file": "yolo26s.yaml"}),
                names={index: name.title() if name == "cow" else name for index, name in enumerate(BODY_PART_CLASSES)},
            )
            with (
                patch("main.BODY_PART_MODEL_PATH", checkpoint),
                patch.dict("main._model_metadata", {}, clear=True),
            ):
                metadata = loaded_model_metadata("body_part", model)

        self.assertEqual(metadata["model_name"], "YOLO26s")
        self.assertTrue(metadata["identity_verified"])

    def test_unexpected_checkpoint_classes_are_not_given_a_verified_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            checkpoint = Path(temporary_directory) / "lameness_best.pt"
            checkpoint.write_bytes(b"checkpoint fixture")
            model = SimpleNamespace(
                model=SimpleNamespace(yaml={"yaml_file": "yolo26n.yaml"}),
                names={0: "class0", 1: "class1"},
            )
            with (
                patch("main.PRIMARY_MODEL_PATH", checkpoint),
                patch.dict("main._model_metadata", {}, clear=True),
            ):
                metadata = loaded_model_metadata("primary", model)

        self.assertEqual(metadata["model_name"], "Model identity not verified")
        self.assertFalse(metadata["identity_verified"])

    def test_model_path_environment_override_is_preserved(self) -> None:
        with patch.dict("os.environ", {"TEST_MODEL_PATH": "custom/model.pt"}):
            path = configured_model_path("models/default.pt", "TEST_MODEL_PATH")

        self.assertEqual(path, BASE_DIR / "custom" / "model.pt")

    def test_missing_detections_report_every_class_as_missing(self) -> None:
        result = geometry_features([])

        self.assertEqual(result["status"], "no_detections")
        self.assertEqual(result["class_counts"], {name: 0 for name in BODY_PART_CLASSES})
        self.assertEqual(result["missing_classes"], list(BODY_PART_CLASSES))
        self.assertEqual(result["observations"], [])
        self.assertEqual(result["overlapping_box_pairs"], [])
        assessment = experimental_geometry_assessment(result)
        self.assertEqual(assessment["label"], "Unable to Assess")
        self.assertEqual(assessment["evidence_status"], "insufficient")

    def test_overlapping_boxes_report_iou_and_box_centers_not_keypoints(self) -> None:
        detections = [
            {
                "class": "cow",
                "confidence": 0.95,
                "bbox_normalized": [0.1, 0.1, 0.9, 0.9],
            },
            {
                "class": "hoof",
                "confidence": 0.71,
                "bbox_normalized": [0.5, 0.5, 0.7, 0.7],
            },
        ]

        result = geometry_features(detections)

        self.assertEqual(result["class_counts"]["cow"], 1)
        self.assertEqual(result["class_counts"]["hoof"], 1)
        self.assertEqual(len(result["overlapping_box_pairs"]), 1)
        self.assertEqual(result["overlapping_box_pairs"][0]["iou"], 0.0625)
        hoof = result["observations"][1]
        self.assertEqual(hoof["bbox_normalized"]["x_min"], 0.5)
        self.assertEqual(hoof["width"], 0.2)
        self.assertEqual(hoof["height"], 0.2)
        self.assertEqual(hoof["area"], 0.04)
        self.assertEqual(hoof["bbox_center_normalized"], {"x": 0.6, "y": 0.6})
        self.assertNotIn("keypoint", hoof)
        self.assertIn("not an anatomical landmark", result["box_center_interpretation"])

    def test_duplicate_same_class_boxes_are_not_deduplicated_or_treated_as_sides(self) -> None:
        detection = {
            "class": "hoof",
            "confidence": 0.9,
            "bbox_normalized": [0.2, 0.3, 0.4, 0.5],
        }
        result = geometry_features([detection, detection.copy()])
        assessment = experimental_geometry_assessment(result)

        self.assertEqual(result["class_counts"]["hoof"], 2)
        self.assertEqual(len(result["observations"]), 2)
        self.assertEqual(assessment["label"], "Unable to Assess")
        self.assertEqual(assessment["repeated_class_detections"], {"hoof": 2})
        self.assertTrue(
            any("distinct anatomical identities" in reason for reason in assessment["reasons"])
        )

    def test_invalid_boxes_are_excluded_from_measurements(self) -> None:
        result = geometry_features(
            [
                {
                    "class": "hoof",
                    "confidence": 0.9,
                    "bbox_normalized": [0.8, 0.2, 0.4, 0.5],
                },
                {
                    "class": "foot",
                    "confidence": 1.1,
                    "bbox_normalized": [0.1, 0.2, 0.4, 0.5],
                },
            ]
        )

        self.assertEqual(result["invalid_detection_count"], 2)
        self.assertEqual(result["observations"], [])
        self.assertEqual(result["class_counts"]["hoof"], 0)
        self.assertEqual(result["class_counts"]["foot"], 0)
        self.assertEqual(
            experimental_geometry_assessment(result)["label"], "Unable to Assess"
        )

    def test_valid_geometry_without_reference_range_remains_unassessed(self) -> None:
        result = geometry_features(
            [
                {
                    "class": "cow",
                    "confidence": 0.99,
                    "bbox_normalized": [0.1, 0.1, 0.9, 0.9],
                },
                {
                    "class": "hoof",
                    "confidence": 0.98,
                    "bbox_normalized": [0.6, 0.6, 0.8, 0.9],
                },
            ]
        )
        assessment = experimental_geometry_assessment(result)

        self.assertEqual(assessment["label"], "Unable to Assess")
        self.assertEqual(assessment["status"], "unable_to_assess")
        self.assertEqual(assessment["evidence_status"], "descriptive_geometry_available")
        self.assertEqual(assessment["reference_range_status"], "not_available")
        self.assertIn("confidence is not a lameness score", assessment["decision_rule"])

    def test_video_geometry_summarizes_boxes_without_claiming_tracking(self) -> None:
        result = video_geometry_assessment(
            [
                {
                    "analysis_details": {
                        "body_part_model": {
                            "geometry_features": {
                                "class_counts": {"hoof": 2, "cow": 1},
                                "observations": [{}, {}, {}],
                            }
                        }
                    }
                },
                {
                    "analysis_details": {
                        "body_part_model": {
                            "geometry_features": {
                                "class_counts": {"hoof": 1, "cow": 1},
                                "observations": [{}, {}],
                            }
                        }
                    }
                },
            ]
        )

        self.assertEqual(result["label"], "Unable to Assess")
        self.assertEqual(result["frames_with_model_2_analysis"], 2)
        self.assertEqual(result["frames_with_valid_observations"], 2)
        self.assertEqual(result["valid_observation_count"], 5)
        self.assertEqual(result["class_counts"]["hoof"], 3)
        self.assertEqual(result["temporal_tracking"], "not_available")

    def test_low_confidence_observation_is_preserved_without_thresholding(self) -> None:
        result = geometry_features(
            [
                {
                    "class": "hoof",
                    "confidence": 0.01,
                    "bbox_normalized": [0.2, 0.3, 0.4, 0.5],
                }
            ]
        )

        self.assertEqual(result["class_counts"]["hoof"], 1)
        self.assertEqual(result["observations"][0]["confidence"], 0.01)
        self.assertNotIn("hoof", result["missing_classes"])

    def test_primary_class_maps_lame_aliases(self) -> None:
        self.assertEqual(primary_class("limping-cow"), "limping-cow")
        self.assertEqual(primary_class("lame-cow"), "limping-cow")
        self.assertEqual(primary_class("lame"), "limping-cow")

    def test_missing_primary_prediction_keeps_overall_assessment_inconclusive(self) -> None:
        primary_result = SimpleNamespace(
            plot=lambda: Image.new("RGB", (2, 2), color="white")
        )
        with (
            patch("main.run_primary", return_value=(primary_result, [])),
            patch("main.run_body_part", return_value=None),
            patch(
                "main.loaded_model_metadata",
                return_value={
                    "model_name": "Model identity not verified",
                    "model_version": None,
                    "checkpoint_filename": None,
                    "checkpoint_sha256": None,
                    "identity_verified": False,
                },
            ),
        ):
            result = analyze_image(Image.new("RGB", (2, 2)), detailed=True)

        self.assertIsNone(result["predicted_class"])
        self.assertIsNone(result["confidence"])
        self.assertEqual(result["analysis_details"]["assessment"], "inconclusive")


class VideoAggregationTests(unittest.TestCase):
    @staticmethod
    def detection(class_name: str, confidence: float) -> dict[str, object]:
        return {"class": class_name, "confidence": confidence}

    def test_one_qualifying_lame_frame_classifies_video_as_lame(self) -> None:
        result = aggregate_video_predictions(
            [{"detection_details": [self.detection("limping-cow", 0.46)]}],
            confidence_threshold=0.25,
        )

        self.assertEqual(result["predicted_class"], "limping-cow")
        self.assertEqual(result["assessment"], "possible-lameness")
        self.assertEqual(result["confidence"], 0.46)
        self.assertEqual(result["class_counts"]["limping-cow"], 1)

    def test_reported_three_lame_detections_at_046_override_empty_frames(self) -> None:
        frames = [
            {"detection_details": [self.detection("limping-cow", 0.46)]}
            for _ in range(3)
        ] + [{"detection_details": []} for _ in range(19)]

        result = aggregate_video_predictions(frames, confidence_threshold=0.25)

        self.assertEqual(result["predicted_class"], "limping-cow")
        self.assertEqual(result["confidence"], 0.46)
        self.assertEqual(result["class_counts"]["limping-cow"], 3)
        self.assertEqual(result["class_counts"]["healthy-cow"], 0)
        self.assertEqual(result["class_counts"]["no_detection"], 19)

    def test_multiple_lame_frames_classify_video_as_lame(self) -> None:
        result = aggregate_video_predictions(
            [
                {"detection_details": [self.detection("limping-cow", 0.46)]},
                {"detection_details": [self.detection("limping-cow", 0.72)]},
                {"detection_details": [self.detection("limping-cow", 0.33)]},
            ],
            confidence_threshold=0.25,
        )

        self.assertEqual(result["predicted_class"], "limping-cow")
        self.assertEqual(result["confidence"], 0.72)
        self.assertEqual(result["class_counts"]["limping-cow"], 3)

    def test_healthy_only_frames_classify_video_as_healthy_looking(self) -> None:
        result = aggregate_video_predictions(
            [
                {"detection_details": [self.detection("healthy-cow", 0.83)]},
                {"detection_details": [self.detection("healthy-cow", 0.66)]},
            ],
            confidence_threshold=0.25,
        )

        self.assertEqual(result["predicted_class"], "healthy-cow")
        self.assertEqual(result["assessment"], "healthy-looking")
        self.assertEqual(result["confidence"], 0.83)
        self.assertEqual(result["class_counts"]["healthy-cow"], 2)

    def test_no_supported_frames_are_inconclusive(self) -> None:
        result = aggregate_video_predictions(
            [
                {"detection_details": []},
                {"detection_details": [self.detection("limping-cow", 0.2)]},
                {"detection_details": [self.detection("unsupported", 0.9)]},
            ],
            confidence_threshold=0.25,
        )

        self.assertIsNone(result["predicted_class"])
        self.assertIsNone(result["confidence"])
        self.assertEqual(result["assessment"], "inconclusive")
        self.assertEqual(result["class_counts"]["no_detection"], 3)

    def test_lame_frames_take_priority_over_healthy_frames(self) -> None:
        result = aggregate_video_predictions(
            [
                {
                    "detection_details": [
                        self.detection("healthy-cow", 0.99),
                        self.detection("limping-cow", 0.46),
                    ]
                },
            ],
            confidence_threshold=0.25,
        )

        self.assertEqual(result["predicted_class"], "limping-cow")
        self.assertEqual(result["assessment"], "possible-lameness")
        self.assertEqual(result["confidence"], 0.46)
        self.assertEqual(result["class_counts"]["healthy-cow"], 1)
        self.assertEqual(result["class_counts"]["limping-cow"], 1)

    def test_frame_below_configured_threshold_does_not_qualify(self) -> None:
        result = aggregate_video_predictions(
            [{"detection_details": [self.detection("limping-cow", 0.46)]}],
            confidence_threshold=0.5,
        )

        self.assertIsNone(result["predicted_class"])
        self.assertEqual(result["assessment"], "inconclusive")
        self.assertEqual(result["class_counts"]["limping-cow"], 0)
        self.assertEqual(result["class_counts"]["no_detection"], 1)


if __name__ == "__main__":
    unittest.main()

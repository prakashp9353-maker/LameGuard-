import base64
import hashlib
import hmac
import io
import json
import logging
import math
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Iterator

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from PIL import Image, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool
from ultralytics import YOLO

BASE_DIR = Path(__file__).resolve().parent
logger = logging.getLogger("lameguard.backend")
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
MAX_VIDEO_BYTES = int(os.getenv("MAX_VIDEO_BYTES", str(250 * 1024 * 1024)))
MAX_VIDEO_DURATION_SECONDS = float(os.getenv("MAX_VIDEO_DURATION_SECONDS", "120"))
VIDEO_SAMPLE_INTERVAL_SECONDS = float(os.getenv("VIDEO_SAMPLE_INTERVAL_SECONDS", "2"))
VIDEO_MAX_FRAMES = int(os.getenv("VIDEO_MAX_FRAMES", "60"))
VIDEO_REPRESENTATIVE_FRAMES = int(os.getenv("VIDEO_REPRESENTATIVE_FRAMES", "8"))
FRAME_MAX_DIMENSION = int(os.getenv("FRAME_MAX_DIMENSION", "1280"))
if (
    MAX_VIDEO_BYTES <= 0
    or MAX_VIDEO_DURATION_SECONDS <= 0
    or VIDEO_SAMPLE_INTERVAL_SECONDS <= 0
    or VIDEO_MAX_FRAMES <= 0
    or VIDEO_REPRESENTATIVE_FRAMES <= 0
    or FRAME_MAX_DIMENSION <= 0
):
    raise ValueError("Video limits, sampling intervals, and frame dimensions must be positive.")
PRIMARY_CONFIDENCE_SETTING = os.getenv(
    "PRIMARY_CONFIDENCE_THRESHOLD",
    os.getenv("PRIMARY_CONFIDENCE", os.getenv("PRIMARY_MIN_CONFIDENCE")),
)
BODY_PART_CONFIDENCE_SETTING = os.getenv(
    "BODY_PART_CONFIDENCE_THRESHOLD", os.getenv("BODY_PART_CONFIDENCE")
)
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000",
    ).split(",")
    if origin.strip()
]


def configured_threshold(name: str, value: str | None) -> float | None:
    if value is None or not value.strip():
        return None
    try:
        threshold = float(value)
    except ValueError as error:
        raise ValueError(f"{name} must be a number between 0 and 1.") from error
    if not 0 <= threshold <= 1:
        raise ValueError(f"{name} must be a number between 0 and 1.")
    return threshold


PRIMARY_CONFIDENCE_THRESHOLD = configured_threshold(
    "PRIMARY_CONFIDENCE_THRESHOLD", PRIMARY_CONFIDENCE_SETTING
)
DEFAULT_PRIMARY_CONFIDENCE_THRESHOLD = 0.25
BODY_CONFIDENCE_THRESHOLD = configured_threshold(
    "BODY_PART_CONFIDENCE_THRESHOLD", BODY_PART_CONFIDENCE_SETTING
)
PREDICTION_SIGNING_SECRET = os.getenv("PREDICTION_SIGNING_SECRET", "")


def configured_model_path(default_relative_path: str, *names: str) -> Path:
    value = next((os.getenv(name) for name in names if os.getenv(name)), None)
    if not value:
        return (BASE_DIR / default_relative_path).resolve()
    path = Path(value).expanduser()
    return path.resolve() if path.is_absolute() else (BASE_DIR / path).resolve()


PRIMARY_MODEL_PATH = configured_model_path(
    "models/lameness_best.pt", "PRIMARY_MODEL_PATH", "MODEL_PATH"
)
BODY_PART_MODEL_PATH = configured_model_path(
    "models/body_parts_best.pt", "BODY_PART_MODEL_PATH"
)

BODY_PART_LABELS = {
    "cow",
    "elbow",
    "fjoint",
    "foot",
    "hand",
    "hjoint",
    "hoof",
    "knee",
    "neck",
    "tc",
}
BODY_PART_CLASSES = tuple(sorted(BODY_PART_LABELS))

MAX_MODEL_CHECKPOINT_BYTES = 512 * 1024 * 1024


class RejectModelRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        return None


def checkpoint_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as checkpoint_file:
        for chunk in iter(lambda: checkpoint_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def required_checkpoint_sha256(env_name: str) -> str:
    expected = os.getenv(env_name, "").strip().lower()
    if not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise RuntimeError(
            f"{env_name} must be set to the expected 64-character SHA-256 checkpoint hash."
        )
    return expected


def download_checkpoint(
    *,
    model_label: str,
    path: Path,
    object_path: str,
    expected_sha256: str,
    storage_url: str,
    storage_key: str,
    bucket: str,
) -> None:
    encoded_bucket = urllib.parse.quote(bucket, safe="")
    encoded_object_path = "/".join(
        urllib.parse.quote(part, safe="") for part in object_path.split("/")
    )
    request = urllib.request.Request(
        f"{storage_url.rstrip('/')}/storage/v1/object/{encoded_bucket}/{encoded_object_path}",
        headers={
            "apikey": storage_key,
            "Authorization": f"Bearer {storage_key}",
        },
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        opener = urllib.request.build_opener(RejectModelRedirects())
        with opener.open(request, timeout=60) as response:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                prefix=f".{path.name}.",
                suffix=".download",
                dir=path.parent,
                delete=False,
            ) as temporary_file:
                temporary_path = Path(temporary_file.name)
                digest = hashlib.sha256()
                total_bytes = 0
                while chunk := response.read(1024 * 1024):
                    total_bytes += len(chunk)
                    if total_bytes > MAX_MODEL_CHECKPOINT_BYTES:
                        raise RuntimeError(
                            f"The private {model_label} checkpoint exceeds the 512 MiB download limit."
                        )
                    temporary_file.write(chunk)
                    digest.update(chunk)
                temporary_file.flush()
                os.fsync(temporary_file.fileno())

        if not hmac.compare_digest(digest.hexdigest(), expected_sha256):
            raise RuntimeError(
                f"The downloaded {model_label} checkpoint failed SHA-256 verification; "
                "check its stored file and configured hash."
            )
        if temporary_path is None:
            raise RuntimeError(
                f"The downloaded {model_label} checkpoint could not be staged for verification."
            )
        os.replace(temporary_path, path)
        temporary_path = None
    except urllib.error.HTTPError as error:
        raise RuntimeError(
            f"Private Supabase Storage returned HTTP {error.code} for the {model_label} checkpoint; "
            "check the private bucket, object path, and backend credential."
        ) from None
    except urllib.error.URLError:
        raise RuntimeError(
            f"Could not reach private Supabase Storage to download the {model_label} checkpoint."
        ) from None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def prepare_model_checkpoints() -> None:
    storage_url = os.getenv("MODEL_STORAGE_SUPABASE_URL", "").strip()
    storage_key = os.getenv("MODEL_STORAGE_SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if bool(storage_url) != bool(storage_key):
        raise RuntimeError(
            "Set both MODEL_STORAGE_SUPABASE_URL and "
            "MODEL_STORAGE_SUPABASE_SERVICE_ROLE_KEY for private model downloads."
        )

    checkpoints = (
        (
            "primary lameness",
            PRIMARY_MODEL_PATH,
            "PRIMARY_MODEL_SHA256",
            "PRIMARY_MODEL_OBJECT_PATH",
            "models/lameness_best.pt",
        ),
        (
            "body-part",
            BODY_PART_MODEL_PATH,
            "BODY_PART_MODEL_SHA256",
            "BODY_PART_MODEL_OBJECT_PATH",
            "models/body_parts_best.pt",
        ),
    )
    if not storage_url:
        for model_label, path, sha_env, _, _ in checkpoints:
            if not path.is_file():
                raise RuntimeError(
                    f"The {model_label} checkpoint is missing at {path}. "
                    "Provide the local model file or configure private Supabase model storage."
                )
            expected = os.getenv(sha_env, "").strip()
            if expected:
                verified_hash = required_checkpoint_sha256(sha_env)
                if not hmac.compare_digest(checkpoint_sha256(path), verified_hash):
                    raise RuntimeError(
                        f"The local {model_label} checkpoint failed SHA-256 verification."
                    )
        return

    parsed_storage_url = urllib.parse.urlsplit(storage_url)
    if (
        parsed_storage_url.scheme != "https"
        or not parsed_storage_url.netloc
        or parsed_storage_url.path not in {"", "/"}
        or parsed_storage_url.username
        or parsed_storage_url.password
        or parsed_storage_url.query
        or parsed_storage_url.fragment
    ):
        raise RuntimeError(
            "MODEL_STORAGE_SUPABASE_URL must be an HTTPS Supabase project URL without credentials or query parameters."
        )
    bucket = os.getenv("MODEL_STORAGE_BUCKET", "lameguard-models").strip()
    if not bucket:
        raise RuntimeError("MODEL_STORAGE_BUCKET must name the private model bucket.")

    prepared_checkpoints = []
    for model_label, path, sha_env, object_env, default_object_path in checkpoints:
        expected_sha256 = required_checkpoint_sha256(sha_env)
        object_path = os.getenv(object_env, default_object_path).strip().strip("/")
        if not object_path or any(
            part in {"", ".", ".."} for part in object_path.split("/")
        ):
            raise RuntimeError(
                f"{object_env} must be a relative object path inside the private model bucket."
            )
        prepared_checkpoints.append((model_label, path, object_path, expected_sha256))

    for model_label, path, object_path, expected_sha256 in prepared_checkpoints:
        if path.is_file():
            try:
                if hmac.compare_digest(checkpoint_sha256(path), expected_sha256):
                    continue
            except OSError:
                pass
        download_checkpoint(
            model_label=model_label,
            path=path,
            object_path=object_path,
            expected_sha256=expected_sha256,
            storage_url=storage_url,
            storage_key=storage_key,
            bucket=bucket,
        )


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    prepare_model_checkpoints()
    yield


app = FastAPI(
    title="LameGuard Experimental YOLO26 Analysis API",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
    expose_headers=["X-LameGuard-Input-SHA256", "X-LameGuard-Signature"],
)

_models: dict[str, YOLO] = {}
_model_metadata: dict[str, dict[str, Any]] = {}
_model_load_errors: dict[str, str] = {}
_model_locks = {"primary": threading.Lock(), "body_part": threading.Lock()}


def get_model(model_key: str) -> YOLO:
    path = PRIMARY_MODEL_PATH if model_key == "primary" else BODY_PART_MODEL_PATH
    if path is None or not path.is_file():
        model_name = "primary YOLO26 lameness" if model_key == "primary" else "body-part YOLO26"
        env_name = "PRIMARY_MODEL_PATH" if model_key == "primary" else "BODY_PART_MODEL_PATH"
        raise HTTPException(
            status_code=503,
            detail=f"The {model_name} checkpoint is not configured or is missing. Set {env_name} to its existing .pt file.",
        )

    if model_key in _models:
        return _models[model_key]
    if model_key in _model_load_errors:
        raise HTTPException(status_code=503, detail=_model_load_errors[model_key])

    with _model_locks[model_key]:
        if model_key in _models:
            return _models[model_key]
        if model_key in _model_load_errors:
            raise HTTPException(status_code=503, detail=_model_load_errors[model_key])
        try:
            _models[model_key] = YOLO(str(path))
        except Exception as error:
            logger.exception("Failed to load configured %s checkpoint", model_key)
            _model_load_errors[model_key] = (
                f"The configured {model_key.replace('_', '-')} checkpoint could not be loaded. "
                "Verify its path and compatibility, then restart the backend."
            )
            raise HTTPException(
                status_code=503,
                detail=_model_load_errors[model_key],
            ) from error
    return _models[model_key]


def loaded_model_metadata(
    model_key: str, model: YOLO | None = None
) -> dict[str, Any]:
    if model_key in _model_metadata:
        return _model_metadata[model_key]
    model = model or _models.get(model_key)
    if model is None:
        return {
            "model_name": "Model identity not verified",
            "model_version": None,
            "checkpoint_filename": None,
            "checkpoint_sha256": None,
            "identity_verified": False,
        }

    checkpoint = PRIMARY_MODEL_PATH if model_key == "primary" else BODY_PART_MODEL_PATH
    yaml_config = getattr(getattr(model, "model", None), "yaml", None)
    yaml_file = yaml_config.get("yaml_file") if isinstance(yaml_config, dict) else None
    architecture = Path(yaml_file).stem.lower() if isinstance(yaml_file, str) else ""
    model_name = (
        f"YOLO{architecture[4:]}"
        if re.fullmatch(r"yolo\d+[nslmx]", architecture)
        else "Model identity not verified"
    )

    try:
        if checkpoint is None or not checkpoint.is_file():
            raise FileNotFoundError("Loaded checkpoint file is unavailable.")
        digest = hashlib.sha256()
        with checkpoint.open("rb") as checkpoint_file:
            for chunk in iter(lambda: checkpoint_file.read(1024 * 1024), b""):
                digest.update(chunk)
        checkpoint_sha256 = digest.hexdigest()
    except OSError:
        checkpoint_sha256 = None

    names = getattr(model, "names", None)
    raw_class_names = names.values() if isinstance(names, dict) else names or []
    class_names = {str(class_name).strip().lower() for class_name in raw_class_names}
    expected_names = (
        {"healthy-cow", "limping-cow"}
        if model_key == "primary"
        else BODY_PART_LABELS
    )
    identity_verified = (
        model_name != "Model identity not verified"
        and class_names == expected_names
        and checkpoint_sha256 is not None
    )
    metadata = {
        "model_name": model_name if identity_verified else "Model identity not verified",
        "model_version": f"sha256:{checkpoint_sha256}" if checkpoint_sha256 else None,
        "checkpoint_filename": checkpoint.name if checkpoint is not None else None,
        "checkpoint_sha256": checkpoint_sha256,
        "identity_verified": identity_verified,
    }
    _model_metadata[model_key] = metadata
    return metadata


def primary_class(name: str) -> str:
    normalized = name.strip().lower().replace("_", "-").replace(" ", "-")
    if normalized in {"healthy-cow", "healthy cow"}:
        return "healthy-cow"
    if normalized in {"limping-cow", "lame-cow", "lame"}:
        return "limping-cow"
    raise HTTPException(
        status_code=500,
        detail=f"Primary model returned unsupported class '{name}'; expected healthy-cow or limping-cow.",
    )


def body_part_class(name: str) -> str:
    normalized = name.strip().lower().replace("_", "").replace("-", "").replace(" ", "")
    if normalized not in BODY_PART_LABELS:
        raise HTTPException(
            status_code=500,
            detail=f"Body-part model returned unsupported class '{name}'.",
        )
    return normalized


def encode_jpeg(image: np.ndarray | Image.Image, max_dimension: int | None = None) -> str:
    if isinstance(image, np.ndarray):
        image = Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
    if max_dimension:
        image.thumbnail((max_dimension, max_dimension))
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=82, optimize=True)
    return base64.b64encode(output.getvalue()).decode("ascii")


def normalized_box(box: list[float], width: int, height: int) -> list[float]:
    x1, y1, x2, y2 = box
    return [
        min(1.0, max(0.0, x1 / width)),
        min(1.0, max(0.0, y1 / height)),
        min(1.0, max(0.0, x2 / width)),
        min(1.0, max(0.0, y2 / height)),
    ]


def read_detections(
    result: Any, width: int, height: int, class_mapper: Any
) -> list[dict[str, Any]]:
    detections: list[dict[str, Any]] = []
    for index in range(len(result.boxes)):
        class_id = int(result.boxes.cls[index].item())
        class_name = str(result.names[class_id])
        box = [float(value) for value in result.boxes.xyxy[index].tolist()]
        detections.append(
            {
                "class": class_mapper(class_name),
                "confidence": float(result.boxes.conf[index].item()),
                "bbox": box,
                "bbox_normalized": normalized_box(box, width, height),
            }
        )
    return detections


def geometry_features(detections: list[dict[str, Any]]) -> dict[str, Any]:
    counts = {class_name: 0 for class_name in BODY_PART_CLASSES}
    observations: list[dict[str, Any]] = []
    invalid_detection_count = 0
    for index, detection in enumerate(detections):
        class_name = detection.get("class")
        if class_name not in counts:
            continue
        box = detection.get("bbox_normalized")
        confidence = detection.get("confidence")
        if (
            not isinstance(box, (list, tuple))
            or len(box) != 4
            or any(
                not isinstance(coordinate, (int, float))
                or not math.isfinite(coordinate)
                or not 0 <= coordinate <= 1
                for coordinate in box
            )
            or box[0] >= box[2]
            or box[1] >= box[3]
            or not isinstance(confidence, (int, float))
            or not math.isfinite(confidence)
            or not 0 <= confidence <= 1
        ):
            invalid_detection_count += 1
            continue
        x_min, y_min, x_max, y_max = box
        counts[class_name] += 1
        width = max(0.0, x_max - x_min)
        height = max(0.0, y_max - y_min)
        observations.append(
            {
                "detection_index": index,
                "class": class_name,
                "confidence": confidence,
                "bbox_normalized": {
                    "x_min": x_min,
                    "y_min": y_min,
                    "x_max": x_max,
                    "y_max": y_max,
                },
                "bbox_center_normalized": {
                    "x": round((x_min + x_max) / 2, 6),
                    "y": round((y_min + y_max) / 2, 6),
                },
                "width": round(width, 6),
                "height": round(height, 6),
                "area": round(width * height, 6),
            }
        )

    overlapping_box_pairs: list[dict[str, Any]] = []
    for left_index, left in enumerate(observations):
        left_box = left["bbox_normalized"]
        for right in observations[left_index + 1 :]:
            right_box = right["bbox_normalized"]
            intersection_width = max(
                0.0, min(left_box["x_max"], right_box["x_max"]) - max(left_box["x_min"], right_box["x_min"])
            )
            intersection_height = max(
                0.0, min(left_box["y_max"], right_box["y_max"]) - max(left_box["y_min"], right_box["y_min"])
            )
            intersection_area = intersection_width * intersection_height
            if intersection_area <= 0:
                continue
            left_area = (
                left_box["x_max"] - left_box["x_min"]
            ) * (left_box["y_max"] - left_box["y_min"])
            right_area = (
                right_box["x_max"] - right_box["x_min"]
            ) * (right_box["y_max"] - right_box["y_min"])
            union_area = left_area + right_area - intersection_area
            if union_area <= 0:
                continue
            overlapping_box_pairs.append(
                {
                    "left_detection_index": left["detection_index"],
                    "left_class": left["class"],
                    "right_detection_index": right["detection_index"],
                    "right_class": right["class"],
                    "iou": round(intersection_area / union_area, 6),
                }
            )

    return {
        "status": "observations_available" if observations else "no_detections",
        "normalization": "Bounding-box coordinates, width, height, and area are normalized to image dimensions.",
        "class_counts": counts,
        "invalid_detection_count": invalid_detection_count,
        "missing_classes": [
            class_name for class_name, count in counts.items() if count == 0
        ],
        "observations": observations,
        "overlapping_box_pairs": overlapping_box_pairs,
        "box_center_interpretation": (
            "The normalized center is the geometric center of a detected box, not an anatomical landmark."
        ),
        "interpretation": (
            "Descriptive object-detection bounding boxes only. Boxes are not anatomical keypoints, "
            "and missing detections do not indicate that a part is absent or that a cow is healthy."
        ),
    }


def experimental_geometry_assessment(
    geometry: dict[str, Any] | None,
) -> dict[str, Any]:
    observations = geometry.get("observations", []) if geometry else []
    class_counts = geometry.get("class_counts", {}) if geometry else {}
    repeated_classes = (
        {
            class_name: count
            for class_name, count in class_counts.items()
            if isinstance(count, int) and count > 1
        }
        if isinstance(class_counts, dict)
        else {}
    )
    reasons = []
    if not observations:
        reasons.append("No valid Model 2 bounding-box observations are available.")
    if geometry and geometry.get("invalid_detection_count", 0):
        reasons.append("One or more invalid Model 2 detections were excluded from geometry measurements.")
    if repeated_classes:
        reasons.append(
            "Repeated detections of a class cannot be matched to distinct anatomical identities from boxes alone."
        )
    reasons.append(
        "No compatible validated lameness reference range is configured for these box measurements."
    )
    return {
        "status": "unable_to_assess",
        "label": "Unable to Assess",
        "prototype": "Unvalidated Model 2 geometry research prototype",
        "evidence_status": "descriptive_geometry_available" if observations else "insufficient",
        "valid_observation_count": len(observations),
        "repeated_class_detections": repeated_classes,
        "reference_range_status": "not_available",
        "decision_rule": (
            "Report measurable bounding-box geometry only. Do not assign a lameness class without "
            "a compatible validated reference range; detection confidence is not a lameness score."
        ),
        "reasons": reasons,
    }


def video_geometry_assessment(frame_records: list[dict[str, Any]]) -> dict[str, Any]:
    completed_frames = 0
    frames_with_observations = 0
    observation_count = 0
    class_counts = {class_name: 0 for class_name in BODY_PART_CLASSES}
    for frame in frame_records:
        analysis = frame.get("analysis_details")
        body_part = analysis.get("body_part_model") if isinstance(analysis, dict) else None
        geometry = body_part.get("geometry_features") if isinstance(body_part, dict) else None
        if not isinstance(geometry, dict):
            continue
        completed_frames += 1
        frame_counts = geometry.get("class_counts")
        if isinstance(frame_counts, dict):
            for class_name in class_counts:
                count = frame_counts.get(class_name)
                if isinstance(count, int) and count >= 0:
                    class_counts[class_name] += count
        observations = geometry.get("observations")
        if isinstance(observations, list) and observations:
            frames_with_observations += 1
            observation_count += len(observations)

    return {
        "status": "unable_to_assess",
        "label": "Unable to Assess",
        "prototype": "Unvalidated Model 2 geometry research prototype",
        "evidence_status": (
            "descriptive_geometry_available" if observation_count else "insufficient"
        ),
        "frames_with_model_2_analysis": completed_frames,
        "frames_with_valid_observations": frames_with_observations,
        "valid_observation_count": observation_count,
        "class_counts": class_counts,
        "reference_range_status": "not_available",
        "temporal_tracking": "not_available",
        "decision_rule": (
            "Report per-frame bounding-box geometry only. Do not assign a lameness class "
            "without a compatible validated reference range; detections are not tracked "
            "between frames and confidence is not a lameness score."
        ),
        "reasons": [
            "Frame detections are not associated into tracked anatomical trajectories.",
            "No compatible validated lameness reference range is configured for these box measurements.",
        ] if observation_count else [
            "No valid Model 2 bounding-box observations are available in the sampled frames.",
            "No compatible validated lameness reference range is configured for these box measurements.",
        ],
    }


def run_primary(image: Image.Image) -> tuple[Any, list[dict[str, Any]]]:
    model = get_model("primary")
    parameters: dict[str, Any] = {
        "source": image,
        "verbose": False,
        "conf": PRIMARY_CONFIDENCE_THRESHOLD
        if PRIMARY_CONFIDENCE_THRESHOLD is not None
        else DEFAULT_PRIMARY_CONFIDENCE_THRESHOLD,
    }
    parameters["imgsz"] = 1280
    result = model.predict(**parameters)[0]
    width, height = image.size
    detections = read_detections(result, width, height, primary_class)
    return result, detections


def classify_video_frame(
    detections: list[dict[str, Any]], confidence_threshold: float
) -> dict[str, Any]:
    class_confidences: dict[str, list[float]] = {
        "healthy-cow": [],
        "limping-cow": [],
    }
    for detection in detections:
        detected_class = detection.get("class")
        confidence = detection.get("confidence")
        if (
            detected_class in class_confidences
            and isinstance(confidence, (int, float))
            and math.isfinite(confidence)
            and confidence_threshold <= confidence <= 1
        ):
            class_confidences[detected_class].append(float(confidence))

    if class_confidences["limping-cow"]:
        predicted_class = "limping-cow"
    elif class_confidences["healthy-cow"]:
        predicted_class = "healthy-cow"
    else:
        predicted_class = None
    return {
        "predicted_class": predicted_class,
        "confidence": (
            max(class_confidences[predicted_class])
            if predicted_class is not None
            else None
        ),
    }


def aggregate_video_predictions(
    frame_records: list[dict[str, Any]], confidence_threshold: float
) -> dict[str, Any]:
    class_counts = {"healthy-cow": 0, "limping-cow": 0, "no_detection": 0}
    class_confidences: dict[str, list[float]] = {
        "healthy-cow": [],
        "limping-cow": [],
    }
    frame_best_confidences: list[float] = []
    for frame in frame_records:
        detections = frame.get("detection_details", [])
        frame_class_detections: dict[str, list[float]] = {
            "healthy-cow": [],
            "limping-cow": [],
        }
        if isinstance(detections, list):
            for detection in detections:
                if not isinstance(detection, dict):
                    continue
                detected_class = detection.get("class")
                confidence = detection.get("confidence")
                if (
                    detected_class in frame_class_detections
                    and isinstance(confidence, (int, float))
                    and math.isfinite(confidence)
                    and confidence_threshold <= confidence <= 1
                ):
                    frame_class_detections[detected_class].append(float(confidence))

        for class_name, confidences in frame_class_detections.items():
            if confidences:
                class_counts[class_name] += 1
        supported_frame_confidences = [
            confidence
            for confidences in frame_class_detections.values()
            for confidence in confidences
        ]
        if supported_frame_confidences:
            frame_best_confidences.append(max(supported_frame_confidences))

        frame_prediction = classify_video_frame(
            detections if isinstance(detections, list) else [], confidence_threshold
        )
        predicted_class = frame_prediction["predicted_class"]
        confidence = frame_prediction["confidence"]
        if predicted_class is None or confidence is None:
            class_counts["no_detection"] += 1
            continue
        class_confidences[predicted_class].append(confidence)

    if class_confidences["limping-cow"]:
        predicted_class = "limping-cow"
        assessment = "possible-lameness"
        confidence = max(class_confidences["limping-cow"])
        inconclusive_reasons: list[str] = []
    elif class_confidences["healthy-cow"]:
        predicted_class = "healthy-cow"
        assessment = "healthy-looking"
        confidence = max(class_confidences["healthy-cow"])
        inconclusive_reasons = []
    else:
        predicted_class = None
        assessment = "inconclusive"
        confidence = None
        inconclusive_reasons = [
            "No sampled frame returned a supported primary class at or above the configured confidence threshold."
        ]

    return {
        "predicted_class": predicted_class,
        "confidence": confidence,
        "assessment": assessment,
        "inconclusive_reasons": inconclusive_reasons,
        "class_counts": class_counts,
        "mean_confidence": (
            round(sum(frame_best_confidences) / len(frame_best_confidences), 6)
            if frame_best_confidences
            else None
        ),
    }


def run_body_part(
    image: Image.Image,
) -> tuple[Any, list[dict[str, Any]]] | None:
    if BODY_PART_MODEL_PATH is None or not BODY_PART_MODEL_PATH.is_file():
        return None
    model = get_model("body_part")
    parameters: dict[str, Any] = {"source": image, "verbose": False}
    if BODY_CONFIDENCE_THRESHOLD is not None:
        parameters["conf"] = BODY_CONFIDENCE_THRESHOLD
    result = model.predict(**parameters)[0]
    width, height = image.size
    detections = read_detections(result, width, height, body_part_class)
    return result, detections


def analyze_image(
    image: Image.Image,
    detailed: bool,
    include_body_annotation: bool = True,
) -> dict[str, Any]:
    started_at = time.perf_counter()
    primary_result, primary_detections = run_primary(image)
    primary_metadata = loaded_model_metadata("primary")
    best = max(primary_detections, key=lambda item: item["confidence"], default=None)
    reasons: list[str] = []
    if best is None:
        reasons.append("The primary model did not return a healthy-cow or limping-cow detection.")
    elif (
        PRIMARY_CONFIDENCE_THRESHOLD is not None
        and best["confidence"] < PRIMARY_CONFIDENCE_THRESHOLD
    ):
        reasons.append(
            "The primary detection is below the configured PRIMARY_CONFIDENCE_THRESHOLD."
        )

    run_secondary = detailed or bool(reasons)
    secondary_error: str | None = None
    try:
        secondary = run_body_part(image) if run_secondary else None
    except HTTPException as error:
        if error.status_code != 503:
            raise
        secondary = None
        secondary_error = str(error.detail)
    if run_secondary and secondary is None:
        secondary_details: dict[str, Any] = {
            "status": "unavailable",
            "model_name": "Model identity not verified",
            "model_identity": None,
            "reason": secondary_error
            or "Set BODY_PART_MODEL_PATH to the existing ten-class body-part checkpoint to enable this experimental analysis.",
            "detections": [],
            "geometry_features": None,
            "experimental_assessment": experimental_geometry_assessment(None),
        }
    elif secondary is None:
        secondary_details = {
            "status": "not_requested",
            "model_name": "Model identity not verified",
            "model_identity": None,
            "detections": [],
            "geometry_features": None,
            "experimental_assessment": None,
        }
    else:
        secondary_result, body_detections = secondary
        body_part_metadata = loaded_model_metadata("body_part", _models["body_part"])
        geometry = geometry_features(body_detections)
        secondary_details = {
            "status": "completed",
            "model_name": body_part_metadata["model_name"],
            "model_identity": body_part_metadata,
            "detections": body_detections,
            "annotated_image_base64": (
                encode_jpeg(secondary_result.plot(), FRAME_MAX_DIMENSION)
                if include_body_annotation
                else None
            ),
            "geometry_features": geometry,
            "experimental_assessment": experimental_geometry_assessment(geometry),
        }

    primary_annotation = primary_result.plot()
    duration_ms = round((time.perf_counter() - started_at) * 1000)
    assessment = (
        "inconclusive"
        if reasons
        else "possible-lameness"
        if best and best["class"] == "limping-cow"
        else "healthy-looking"
        if best
        else "inconclusive"
    )
    predicted_class = (
        best["class"] if best and assessment != "inconclusive" else None
    )
    confidence = (
        best["confidence"] if best and assessment != "inconclusive" else None
    )
    if assessment == "healthy-looking":
        reasons.append("A healthy-cow detection does not rule out lameness or other illness.")

    return {
        "media_type": "image",
        "predicted_class": predicted_class,
        "confidence": confidence,
        "status": "completed",
        "model_version": primary_metadata["model_name"],
        "detection_details": primary_detections,
        "annotated_image_base64": encode_jpeg(primary_annotation),
        "annotated_image_mime_type": "image/jpeg",
        "processing_duration_ms": duration_ms,
        "analysis_details": {
            "assessment": assessment,
            "inconclusive_reasons": reasons
            if assessment == "inconclusive"
            else [],
            "primary_model": {
                **primary_metadata,
                "configured_confidence_threshold": (
                    PRIMARY_CONFIDENCE_THRESHOLD
                    if PRIMARY_CONFIDENCE_THRESHOLD is not None
                    else DEFAULT_PRIMARY_CONFIDENCE_THRESHOLD
                ),
                "detections": primary_detections,
            },
            "body_part_model": secondary_details,
            "model_agreement": {
                "status": "not_assessed",
                "reason": "The body-part checkpoint detects anatomy, not validated lameness classes; detections are not treated as a second diagnosis.",
            },
            "limitations": [
                "This experimental image analysis does not measure gait over time.",
                "Anatomical bounding boxes and normalized geometry are descriptive only, not independently diagnostic.",
                "A healthy-looking result cannot rule out a condition; consult a veterinarian for persistent symptoms.",
            ],
        },
    }


def decode_image(content: bytes) -> Image.Image:
    try:
        with Image.open(io.BytesIO(content)) as uploaded_image:
            if uploaded_image.format not in {"JPEG", "PNG"}:
                raise HTTPException(
                    status_code=415,
                    detail="The file contents must be a JPG or PNG image.",
                )
            if uploaded_image.width * uploaded_image.height > MAX_IMAGE_PIXELS:
                raise HTTPException(
                    status_code=413,
                    detail="Image dimensions exceed the supported 40-megapixel limit.",
                )
            uploaded_image.verify()
        with Image.open(io.BytesIO(content)) as uploaded_image:
            return uploaded_image.convert("RGB")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
        raise HTTPException(
            status_code=400,
            detail="The uploaded file is not a valid JPG or PNG image.",
        ) from error


def sample_timestamps(duration: float) -> list[float]:
    interval_samples = np.arange(
        0.0, duration, VIDEO_SAMPLE_INTERVAL_SECONDS, dtype=np.float64
    )
    if len(interval_samples) > VIDEO_MAX_FRAMES:
        selected = np.linspace(
            0, len(interval_samples) - 1, VIDEO_MAX_FRAMES, dtype=np.int64
        )
        interval_samples = interval_samples[selected]
    return [float(timestamp) for timestamp in interval_samples]


def json_event(payload: dict[str, Any]) -> str:
    return json.dumps(payload, separators=(",", ":"), allow_nan=False) + "\n"


def sign_payload(result: dict[str, Any], input_sha256: str) -> tuple[str, str]:
    ensure_signing_configured()
    payload = json.dumps(
        result, separators=(",", ":"), allow_nan=False, ensure_ascii=False
    )
    message = f"sha256:{input_sha256}\n{payload}".encode("utf-8")
    signature = hmac.new(
        PREDICTION_SIGNING_SECRET.encode("utf-8"), message, hashlib.sha256
    ).hexdigest()
    return payload, signature


def ensure_signing_configured() -> None:
    if len(PREDICTION_SIGNING_SECRET.encode("utf-8")) < 32:
        raise HTTPException(
            status_code=503,
            detail="Secure prediction saving is not configured. Set PREDICTION_SIGNING_SECRET to the shared server-only key.",
        )


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "primary_checkpoint_configured": PRIMARY_MODEL_PATH is not None,
        "primary_checkpoint_present": bool(
            PRIMARY_MODEL_PATH and PRIMARY_MODEL_PATH.is_file()
        ),
        "primary_model_loaded": "primary" in _models,
        "body_part_checkpoint_configured": BODY_PART_MODEL_PATH is not None,
        "body_part_checkpoint_present": bool(
            BODY_PART_MODEL_PATH and BODY_PART_MODEL_PATH.is_file()
        ),
        "body_part_model_loaded": "body_part" in _models,
        "primary_confidence_threshold": PRIMARY_CONFIDENCE_THRESHOLD,
        "body_part_confidence_threshold": BODY_CONFIDENCE_THRESHOLD,
        "secure_prediction_saving_configured": len(
            PREDICTION_SIGNING_SECRET.encode("utf-8")
        ) >= 32,
        "video_sampling": {
            "target_interval_seconds": VIDEO_SAMPLE_INTERVAL_SECONDS,
            "max_frames": VIDEO_MAX_FRAMES,
            "max_duration_seconds": MAX_VIDEO_DURATION_SECONDS,
        },
    }


@app.post("/predict")
async def predict(
    file: UploadFile = File(...),
    detailed: bool = Query(False),
) -> dict[str, Any]:
    try:
        if file.content_type not in {"image/jpeg", "image/png"}:
            raise HTTPException(
                status_code=415,
                detail="Only JPG, JPEG, and PNG images are supported.",
            )
        content = await file.read(MAX_IMAGE_BYTES + 1)
        if len(content) > MAX_IMAGE_BYTES:
            raise HTTPException(
                status_code=413, detail="Images must be 10 MB or smaller."
            )
        if not content:
            raise HTTPException(status_code=400, detail="The uploaded image is empty.")
        image = decode_image(content)
    finally:
        await file.close()

    input_sha256 = hashlib.sha256(content).hexdigest()
    try:
        ensure_signing_configured()
        result = await run_in_threadpool(analyze_image, image, detailed)
        payload, signature = sign_payload(result, input_sha256)
        return Response(
            content=payload,
            media_type="application/json",
            headers={
                "X-LameGuard-Input-SHA256": input_sha256,
                "X-LameGuard-Signature": signature,
                "Cache-Control": "no-store",
            },
        )
    except HTTPException:
        raise
    except Exception as error:
        logger.exception("Primary YOLO image analysis failed")
        raise HTTPException(
            status_code=500,
            detail="YOLO image inference failed. Check the configured checkpoints and backend logs.",
        ) from error


@app.post("/predict-video")
async def predict_video(
    file: UploadFile = File(...),
    detailed: bool = Query(False),
) -> StreamingResponse:
    filename = (file.filename or "").lower()
    if not filename.endswith(".mp4"):
        await file.close()
        raise HTTPException(
            status_code=415, detail="Only MP4 video uploads are supported."
        )
    if file.content_type not in {
        "video/mp4",
        "application/mp4",
        "application/octet-stream",
    }:
        await file.close()
        raise HTTPException(status_code=415, detail="The upload must be an MP4 video.")

    temporary_path: str | None = None
    total_bytes = 0
    header = bytearray()
    input_hasher = hashlib.sha256()
    try:
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as temporary:
            temporary_path = temporary.name
            while chunk := await file.read(1024 * 1024):
                total_bytes += len(chunk)
                if total_bytes > MAX_VIDEO_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Video must be {MAX_VIDEO_BYTES // (1024 * 1024)} MB or smaller.",
                    )
                if len(header) < 12:
                    header.extend(chunk[: 12 - len(header)])
                temporary.write(chunk)
                input_hasher.update(chunk)
    except HTTPException:
        if temporary_path:
            Path(temporary_path).unlink(missing_ok=True)
        raise
    except Exception as error:
        if temporary_path:
            Path(temporary_path).unlink(missing_ok=True)
        logger.exception("Could not stage uploaded video")
        raise HTTPException(
            status_code=500, detail="The uploaded video could not be staged for analysis."
        ) from error
    finally:
        await file.close()
    if total_bytes < 12 or header[4:8] != b"ftyp":
        if temporary_path:
            Path(temporary_path).unlink(missing_ok=True)
        raise HTTPException(
            status_code=400,
            detail="The uploaded file does not have a valid MP4 container header.",
        )

    ensure_signing_configured()
    # Fail before streaming if the required primary checkpoint cannot load.
    try:
        await run_in_threadpool(get_model, "primary")
    except HTTPException:
        if temporary_path:
            Path(temporary_path).unlink(missing_ok=True)
        raise

    def generate() -> Iterator[str]:
        started_at = time.perf_counter()
        capture: cv2.VideoCapture | None = None
        try:
            if temporary_path is None:
                raise RuntimeError("The uploaded video was not staged for inference.")
            capture = cv2.VideoCapture(temporary_path)
            if not capture.isOpened():
                yield json_event(
                    {
                        "type": "error",
                        "detail": "The MP4 could not be decoded. Check that the video uses a supported codec.",
                    }
                )
                return
            fps = float(capture.get(cv2.CAP_PROP_FPS))
            frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
            duration = frame_count / fps if fps > 0 else 0
            if duration <= 0:
                yield json_event(
                    {"type": "error", "detail": "The MP4 duration could not be read."}
                )
                return
            if duration > MAX_VIDEO_DURATION_SECONDS:
                yield json_event(
                    {
                        "type": "error",
                        "detail": f"Video duration exceeds the configured {MAX_VIDEO_DURATION_SECONDS:g}-second limit.",
                    }
                )
                return

            timestamps = sample_timestamps(duration)
            if not timestamps:
                yield json_event(
                    {"type": "error", "detail": "No frames could be sampled from this video."}
                )
                return

            representative_indices = set(
                np.linspace(
                    0,
                    len(timestamps) - 1,
                    min(VIDEO_REPRESENTATIVE_FRAMES, len(timestamps)),
                    dtype=np.int64,
                ).tolist()
            )
            frame_records: list[dict[str, Any]] = []
            for index, timestamp in enumerate(timestamps):
                capture.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000)
                ok, frame = capture.read()
                if not ok or frame is None:
                    yield json_event(
                        {
                            "type": "error",
                            "detail": f"Could not decode the sampled video frame at {timestamp:.2f} seconds.",
                        }
                    )
                    return

                height, width = frame.shape[:2]
                scale = min(1.0, FRAME_MAX_DIMENSION / max(width, height))
                if scale < 1:
                    frame = cv2.resize(
                        frame,
                        (round(width * scale), round(height * scale)),
                        interpolation=cv2.INTER_AREA,
                    )
                image = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                is_representative = index in representative_indices
                frame_result = analyze_image(
                    image,
                    detailed,
                    include_body_annotation=is_representative,
                )
                frame_prediction = classify_video_frame(
                    frame_result["detection_details"],
                    PRIMARY_CONFIDENCE_THRESHOLD
                    if PRIMARY_CONFIDENCE_THRESHOLD is not None
                    else DEFAULT_PRIMARY_CONFIDENCE_THRESHOLD,
                )
                frame_record: dict[str, Any] = {
                    "frame_index": index,
                    "timestamp_seconds": round(timestamp, 3),
                    "predicted_class": frame_prediction["predicted_class"],
                    "confidence": frame_prediction["confidence"],
                    "detection_details": frame_result["detection_details"],
                    "analysis_details": frame_result["analysis_details"],
                    "annotated_frame_base64": None,
                    "original_frame_base64": None,
                }
                if is_representative:
                    frame_record["annotated_frame_base64"] = frame_result[
                        "annotated_image_base64"
                    ]
                    frame_record["original_frame_base64"] = encode_jpeg(
                        image, FRAME_MAX_DIMENSION
                    )
                frame_records.append(frame_record)

                yield json_event(
                    {
                        "type": "progress",
                        "current": index + 1,
                        "total": len(timestamps),
                        "timestamp_seconds": round(timestamp, 3),
                        "frame": {
                            "frame_index": index,
                            "predicted_class": frame_record["predicted_class"],
                            "confidence": frame_record["confidence"],
                            "detection_details": frame_record["detection_details"],
                        },
                    }
                )

            aggregation = aggregate_video_predictions(
                frame_records,
                PRIMARY_CONFIDENCE_THRESHOLD
                if PRIMARY_CONFIDENCE_THRESHOLD is not None
                else DEFAULT_PRIMARY_CONFIDENCE_THRESHOLD,
            )
            primary_metadata = loaded_model_metadata("primary")
            body_part_metadata = (
                loaded_model_metadata("body_part", _models["body_part"])
                if "body_part" in _models
                else None
            )
            elapsed_ms = round((time.perf_counter() - started_at) * 1000)
            completed = {
                "media_type": "video",
                "predicted_class": aggregation["predicted_class"],
                "confidence": aggregation["confidence"],
                "status": "completed",
                "model_version": primary_metadata["model_name"],
                "detection_details": [],
                "annotated_image_base64": None,
                "annotated_image_mime_type": None,
                "processing_duration_ms": elapsed_ms,
                "analysis_details": {
                    "assessment": aggregation["assessment"],
                    "inconclusive_reasons": aggregation["inconclusive_reasons"],
                    "primary_model": {
                        **primary_metadata,
                        "configured_confidence_threshold": (
                            PRIMARY_CONFIDENCE_THRESHOLD
                            if PRIMARY_CONFIDENCE_THRESHOLD is not None
                            else DEFAULT_PRIMARY_CONFIDENCE_THRESHOLD
                        ),
                    },
                    "classification_rule": "Any qualifying limping-cow frame takes priority. Otherwise, a qualifying healthy-cow frame yields healthy-looking. If no sampled frame has a supported class at or above the primary confidence threshold, the result is inconclusive.",
                    "classification_confidence_threshold": (
                        PRIMARY_CONFIDENCE_THRESHOLD
                        if PRIMARY_CONFIDENCE_THRESHOLD is not None
                        else DEFAULT_PRIMARY_CONFIDENCE_THRESHOLD
                    ),
                    "sampling": {
                        "method": "Decode one frame at the configured fixed interval; if samples exceed the configured maximum, select evenly across the full video duration.",
                        "target_interval_seconds": VIDEO_SAMPLE_INTERVAL_SECONDS,
                        "sampled_frame_count": len(frame_records),
                        "sampled_timestamps_seconds": [
                            item["timestamp_seconds"] for item in frame_records
                        ],
                        "source_fps": fps,
                        "source_frame_count": frame_count,
                        "source_duration_seconds": round(duration, 3),
                    },
                    "frame_summary": {
                        "frames_with_healthy_cow_detection": aggregation["class_counts"]["healthy-cow"],
                        "frames_with_limping_cow_detection": aggregation["class_counts"]["limping-cow"],
                        "frames_without_supported_class_detection": aggregation["class_counts"][
                            "no_detection"
                        ],
                        "mean_confidence_of_sampled_frame_best_detections": aggregation["mean_confidence"],
                    },
                    "frames": frame_records,
                    "body_part_model": {
                        "configured": BODY_PART_MODEL_PATH is not None,
                        "status": "loaded" if body_part_metadata else "not_loaded",
                        "model_name": (
                            body_part_metadata["model_name"]
                            if body_part_metadata
                            else "Model identity not verified"
                        ),
                        "model_identity": body_part_metadata,
                        "interpretation": "Anatomical detections and normalized geometry are descriptive only; the body-part model is not a lameness classifier.",
                    },
                    "experimental_geometry_assessment": video_geometry_assessment(
                        frame_records
                    ),
                    "processing_duration_ms": elapsed_ms,
                    "limitations": [
                        "This result summarizes sampled frames only; it does not measure motion continuously.",
                        "Frame detection counts are not diagnostic proportions or validated model accuracy.",
                        "No temporal gait classifier or labeled-data evaluation is configured.",
                        "A healthy-looking sampled frame cannot rule out lameness or other illness.",
                    ],
                },
            }
            input_sha256 = input_hasher.hexdigest()
            signed_payload, signature = sign_payload(completed, input_sha256)
            yield json_event(
                {
                    "type": "complete",
                    "result_json": signed_payload,
                    "input_sha256": input_sha256,
                    "signature": signature,
                }
            )
        except Exception:
            logger.exception("YOLO video analysis failed")
            yield json_event(
                {
                    "type": "error",
                    "detail": "Video inference failed. Check the configured checkpoints, MP4 codec, and backend logs.",
                }
            )
        finally:
            if capture is not None:
                capture.release()
            if temporary_path is not None:
                try:
                    os.unlink(temporary_path)
                except OSError:
                    pass

    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )

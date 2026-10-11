# LameGuard AI

LameGuard AI is a Next.js App Router application with Supabase email/password authentication, PostgreSQL row-level security, private Supabase Storage, and a separate FastAPI YOLO26 service. It supports image analysis, explicitly sampled MP4 frame analysis, owned prediction history, and downloadable PDFs generated from saved records. It does not train, download, or substitute models and does not generate mock results.

## Model checkpoints

The backend defaults to the existing checkpoints relative to `backend/main.py`:

- `backend/models/lameness_best.pt`: Model 1, with `healthy-cow` and `limping-cow` classes.
- `backend/models/body_parts_best.pt`: Model 2 (YOLO26s), with `Cow`, `elbow`, `fjoint`, `foot`, `hand`, `hjoint`, `hoof`, `knee`, `neck`, and `tc` classes.

Set `PRIMARY_MODEL_PATH` or `BODY_PART_MODEL_PATH` to override either default. The legacy `MODEL_PATH` remains a fallback override for Model 1.

### Render model checkpoint bootstrap (no persistent disk)

When the checkpoint files are not present locally, the FastAPI application downloads them from a **private Supabase Storage bucket during startup**. It downloads to a temporary file, checks the required SHA-256 hash, and only then atomically places the checkpoint at its existing configured model path. Invalid credentials, missing objects, incomplete configuration, oversized files, or hash mismatches fail backend startup; model inference and names are unchanged.

For the Render FastAPI service, create a private bucket (default name `lameguard-models`) and upload:

- `models/lameness_best.pt`
- `models/body_parts_best.pt`

Set these environment variables on the **FastAPI backend service only**:

| Variable | Value |
|---|---|
| `MODEL_STORAGE_SUPABASE_URL` | HTTPS project URL for the private model-storage Supabase project |
| `MODEL_STORAGE_SUPABASE_SERVICE_ROLE_KEY` | That project's service-role key; backend-only secret, never a `NEXT_PUBLIC_` variable |
| `MODEL_STORAGE_BUCKET` | `lameguard-models`, unless you used another private bucket name |
| `PRIMARY_MODEL_SHA256` | `2c16432374dce1f734e394e586dab2d9b39fa5a71f84b8b7365d9e833a8c92d0` for the current `lameness_best.pt` |
| `BODY_PART_MODEL_SHA256` | `7bdb391c05e070c5dd3062808c6801a8c7775d39939a83c2b94c9626f6320daf` for the current `body_parts_best.pt` |

The default object paths are the two paths listed above. Override them with `PRIMARY_MODEL_OBJECT_PATH` and `BODY_PART_MODEL_OBJECT_PATH` only if the uploaded object keys differ. Keep `PRIMARY_MODEL_PATH` and `BODY_PART_MODEL_PATH` unset to retain the backend's existing `backend/models/...` destination paths; if overriding them, ensure the target directories are writable in Render's ephemeral filesystem.

The service-role key has broad access and bypasses Supabase RLS. Prefer a **separate Supabase project dedicated to model artifacts** to limit its access to LameGuard user and prediction data. Store the key only in Render's backend environment settings, never in GitHub, frontend settings, logs, or any `NEXT_PUBLIC_` variable. The bucket must remain private; startup uses authenticated Storage REST downloads and refuses redirects. `*.pt` checkpoints remain excluded from Git. Replace the documented hashes and Render environment values whenever the checkpoint files change.

The backend continues to report checkpoint presence through `/health`; `*_model_loaded` remains false until inference first loads that model. Confirm deployment by checking both `*_checkpoint_present` values and then making a real inference request.

Model 1's lameness class/confidence is kept separate from Model 2's descriptive object detections. Model 2 reports normalized box bounds, dimensions, area, confidence, per-class counts, missing returned classes, and IoU for overlapping boxes. Bounding boxes are not anatomical keypoints; missing detections do not imply anatomical absence or a healthy cow. Model 2 does not classify lameness.

## Requirements

- Windows 10/11, Node.js, and npm
- Python 3.10 or newer with a compatible PyTorch/Ultralytics build
- The two existing trained checkpoints in `backend\models\`
- A LameGuard Supabase project (separate from CampusFlow AI)

## Frontend setup (Windows PowerShell)

From the project root:

```powershell
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
notepad .env.local
npm install
npm run dev
```

Keep any existing `.env.local` values. The application needs:

- `NEXT_PUBLIC_SUPABASE_URL`: the LameGuard project URL.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, or the existing legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Never put a service-role key in a `NEXT_PUBLIC_` variable.
- `NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8000`
- `NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET=lameguard-images`
- `PREDICTION_SIGNING_SECRET`: a random server-only secret of at least 32 bytes, shared by Next.js and FastAPI. Keep it out of all `NEXT_PUBLIC_` variables. A value generated in `.env.local` is loaded by Next.js and by the FastAPI command below; do not commit this file.

Corepack and pnpm are not required. Restart the Next.js dev server after editing `.env.local`.

For a deployed frontend, set `NEXT_PUBLIC_API_BASE_URL` in the frontend host's
build environment to the actual HTTPS base URL of the separately hosted FastAPI
service. Do not set it to the LameGuard frontend URL. Next.js embeds this
`NEXT_PUBLIC_` value at build time, so redeploy the frontend after changing it.
The prediction client rejects a missing, malformed, or same-origin frontend URL
instead of silently sending `/predict` to the Next.js app.

## FastAPI setup (Windows PowerShell)

In a second terminal from the project root:

```powershell
Set-Location .\backend
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
$env:ALLOWED_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000"
uvicorn main:app --env-file ..\.env.local --reload --host 127.0.0.1 --port 8000
```

The default checkpoints are loaded lazily; `/health` reports their configured/present state at `http://127.0.0.1:8000/health`. Set `PRIMARY_MODEL_PATH` and/or `BODY_PART_MODEL_PATH` in this terminal to override the defaults. The configured signing secret is required to return a result that the application will save.

Optional backend settings:

```powershell
$env:VIDEO_SAMPLE_INTERVAL_SECONDS = "2"
$env:VIDEO_MAX_FRAMES = "60"
$env:MAX_VIDEO_DURATION_SECONDS = "120"
$env:MAX_VIDEO_BYTES = "262144000"
```

The backend derives each model architecture from the loaded checkpoint's embedded YAML and class names. It records the checkpoint SHA-256 as the weight-version fingerprint; `PRIMARY_MODEL_VERSION` and `BODY_PART_MODEL_VERSION` are not used to label checkpoints. The PDF reports a model as verified only when the checkpoint identity and expected classes can be verified.

Prediction confidence is a per-image/frame detector score, not evaluation accuracy. The PDF's model evaluation section reports Accuracy, Precision, Recall, F1-score, mAP@0.5, and mAP@0.5:0.95 only when verified metrics tied to the exact checkpoint include an evaluation source and split. The supplied nine-image Model 2 results documented below are not wired to saved analyses or associated with a checkpoint fingerprint, and they do not provide the requested full set of aggregate metrics. Saved reports therefore state **Not evaluated** unless that metadata is explicitly added from a documented run.

`PRIMARY_CONFIDENCE_THRESHOLD` and `BODY_PART_CONFIDENCE_THRESHOLD` can be configured if supported by the model owner/test protocol. They are not implicitly treated as validated lameness thresholds. If the primary threshold is configured and a result is below it, the image assessment is explicitly inconclusive.

## Start the frontend and backend together

Leave FastAPI running in its terminal on port 8000. In another terminal at the project root:

```powershell
npm run dev
```

Open `http://localhost:3000`. The browser sends inference requests to `NEXT_PUBLIC_API_BASE_URL`; successful inference is submitted to a server-side save route which verifies a backend HMAC signature bound to the uploaded file and uses the authenticated Supabase session for private Storage/database writes.

## Supabase manual setup

These SQL files are prepared for manual review; they have not been run against the live project:

1. In the **LameGuard** Supabase project, enable email/password sign-in. Set the Site URL to `http://localhost:3000` and add `http://localhost:3000/auth/callback` to the redirect URL allowlist. Add your actual deployment callback URL when deploying.
2. Review and run `supabase/schema.sql` in the SQL Editor. It creates or indexes `public.lameguard_predictions` and adds guarded, LameGuard-named ownership policies; it does not drop tables.
3. Run `supabase/migrations/20261011_add_video_analysis_columns.sql` against the existing prediction table. It adds media paths/type, analysis metadata, and processing duration; it backfills `original_media_path` from existing image paths and adds only guarded constraints/indexes. Review live schema and policies first.
4. Review and run `supabase/storage.sql`. It creates the `lameguard-images` bucket as private or applies size/MIME restrictions to an existing private bucket. It aborts if the bucket is public. The policies scope access to the authenticated user's UUID folder. Supported stored types are JPEG, PNG, and MP4; the bucket upload limit is 250 MiB.
5. In **Authentication → URL Configuration**, make sure the app callback is allowed. If using custom confirmation or recovery email templates, retain Supabase's generated `{{ .ConfirmationURL }}` link; do not hard-code a CampusFlow URL. The callback supports both PKCE codes and Supabase email OTP token hashes.
6. Test signup, email confirmation, password recovery, and sign-in against the LameGuard project. SMTP delivery and an actual confirmed account must be configured in Supabase.

The application accesses the existing `lameguard_predictions` table by its actual name and uses RLS plus server-side authenticated-user checks. Do not make cow media public. Schema, migrations, and storage policies require the manual SQL review/application above; they have not been remotely verified.

## Image analysis

Open `/dashboard/predict`, choose **Image analysis**, and upload a JPG/JPEG/PNG image of at most 10 MiB. Drag/drop, browse, preview, replace, and remove are supported. The page calls real Model A inference and can request Model B detections/measurements when configured. Only an authenticated, HMAC-verified FastAPI response bound to the exact image is saved. The primary annotation and optional body-part annotation are stored privately; inline image bytes are not stored in PostgreSQL.

The returned Model 1 class is shown as **Possible Lameness**, **Healthy-looking**, or **Inconclusive**. If Model 1 returns no supported class, the assessment is inconclusive; Model 2 observations do not change or replace that prediction. A “Healthy-looking” model output is not a veterinary conclusion and cannot rule out a condition. Model 2's readable observations show confidence and normalized bounding-box bounds, width, height, area, class counts, missing returned classes, and pairwise IoU for positive-area overlaps. Box geometry is descriptive only; box centers are not treated as keypoints and no healthy/lame threshold is applied. A missing class means only that the model returned no detection for it under its active settings.

## Model 2 evaluation limitations and offline tests

The supplied Model 2 evaluation is based on only **9 test images**. Its per-class AP50 / AP50-95 values are:

| Class | AP50 | AP50-95 |
|---|---:|---:|
| Cow | 0.9539 | 0.9188 |
| elbow | 0.8327 | 0.2835 |
| fjoint | 0.2484 | 0.0941 |
| foot | 0.9450 | 0.5539 |
| hand | 0.9127 | 0.5651 |
| hjoint | 0.0690 | 0.0278 |
| hoof | 0.7132 | 0.2688 |
| knee | 0.7347 | 0.2513 |
| neck | 0.2126 | 0.0674 |
| tc | 0.6225 | 0.1760 |

These preliminary detector metrics are not clinical performance estimates, healthy/lame thresholds, or evidence that detected boxes are anatomical keypoints. The small test set does not establish generalization; additional representative labeled data and domain-specific validation are needed before making stronger claims.

Run the offline backend unit tests from the project root using the existing Python environment:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s backend\tests -v
.\.venv\Scripts\python.exe -m py_compile backend\main.py backend\tests\test_geometry_features.py
```

## Video analysis and limits

The application accepts MP4 videos up to 250 MiB. FastAPI rejects unsupported containers/codecs and videos longer than the configured limit (120 seconds by default). It samples frames at a fixed target interval (2 seconds by default); if that would exceed the maximum (60 frames by default), it selects frames evenly across the clip. The live progress bar and frame list show actual sampled-frame inference events.

Each sampled frame is analyzed with the configured primary model and, when requested and configured, the body-part model. The service stores sampled-frame detections plus up to eight representative original/annotated frame pairs privately. It does not currently produce a newly encoded annotated MP4. Frame counts/confidences are actual detector outputs, not diagnosis proportions or evaluation metrics. Video aggregation applies the existing primary confidence threshold (default 0.25): any qualifying `limping-cow` detection makes the video result **Possible Lameness**, taking priority even if healthy detections are also present; otherwise, any qualifying `healthy-cow` detection yields **Healthy-looking**; when neither class qualifies, the result is **Inconclusive**. Video confidence is the highest qualifying frame confidence for the selected class. This sampled-frame screening rule is not a validated temporal gait diagnosis and can miss motion between frames; a healthy-looking result cannot rule out lameness.

## History, private media, and PDF reports

`/dashboard` and `/dashboard/history` read authenticated users' actual `lameguard_predictions` rows. History supports search/filtering, video/image detail views, ownership-scoped deletion, and **PDF report** download. Reports are generated from the saved database row and privately downloaded original/annotation image or representative video frames. Reports include the saved model result/detections, body-part geometry or video sample method/statistics when available, processing time, care guidance, and a separate model-evaluation section. Metrics are shown only when explicitly marked verified, tied to the exact loaded checkpoint SHA-256, and accompanied by a documented evaluation source and split; otherwise the report says **Not evaluated**.

Private-image PDF generation requires the saved image/frame files to still exist in the configured private bucket and the user to pass Storage RLS. The full uploaded MP4 is retained in private storage; only selected still frames and JSON detection metadata are stored alongside it.

## Check registration, video, and reports

1. Register at `/sign-up`, confirm by email, then sign in. Use **Forgot password?** to request recovery and complete it at `/reset-password`.
2. Check `/health` for primary/body checkpoint presence and secure-saving readiness. A healthy endpoint alone does not prove that a checkpoint can run inference.
3. Submit a real image or a short MP4 from `/dashboard/predict`. Confirm actual per-frame progress for video, the saved record in `/dashboard/history`, private original/annotation preview, and PDF report.
4. A valid MP4 codec and actual configured checkpoints are required for video inference. Supabase must have the reviewed schema migration, bucket, and policies for persistence.

## Local checks

From the project root:

```powershell
npm run typecheck
npm run build
```

From the backend folder after activating its virtual environment:

```powershell
python -m py_compile main.py
python -m pip check
```

Live Supabase authentication, Storage/RLS, and real model inference depend on your Supabase project and the two existing checkpoint files. Do not consider them verified until they have been tested with those services and representative real media. PDF output depends on an actual saved record and its accessible private media.

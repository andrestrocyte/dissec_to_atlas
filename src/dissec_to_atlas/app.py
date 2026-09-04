from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image

from .atlas import (
    AtlasProvider,
    SyntheticAtlasProvider,
    auto_align_crop,
    detect_red_piece_polygons,
    image_fingerprint,
)
from .models import (
    AutoAlignRequest,
    PieceSuggestRequest,
    PlaneRequest,
    PolygonSummaryRequest,
    SaveRequest,
)
from .project import ProjectStore


def create_app(project_file: str | Path, synthetic: bool = False) -> FastAPI:
    store = ProjectStore(Path(project_file))
    static = Path(__file__).parent / "static"
    app = FastAPI(title="dissec-to-atlas", version="0.1.0")

    @lru_cache(maxsize=1)
    def atlas_provider():
        return SyntheticAtlasProvider() if synthetic else AtlasProvider(store.manifest.atlas_id)

    @app.get("/api/health")
    def health():
        return {"ok": True, "project_id": store.manifest.project_id}

    @app.get("/api/project")
    def project():
        manifest = store.manifest.model_dump()
        for slide in manifest["slides"]:
            try:
                path = store.slide_path(slide["id"])
                with Image.open(path) as image:
                    slide["width"], slide["height"] = image.size
                slide["sha256"] = image_fingerprint(path)
                source_records = []
                for source in slide.get("source_files", []):
                    source_path = Path(source).expanduser()
                    if not source_path.is_absolute():
                        source_path = store.root / source_path
                    source_records.append(
                        {
                            "path": str(source_path.resolve()),
                            "sha256": image_fingerprint(source_path.resolve()),
                        }
                    )
                slide["source_file_records"] = source_records
            except (FileNotFoundError, OSError) as exc:
                slide["error"] = str(exc)
        return manifest

    @app.get("/api/slides/{slide_id}/image")
    def slide_image(slide_id: str):
        try:
            path = store.slide_path(slide_id)
        except (KeyError, FileNotFoundError) as exc:
            raise HTTPException(404, str(exc)) from exc
        return FileResponse(path)

    @app.get("/api/atlas/info")
    def atlas_info():
        try:
            return atlas_provider().info()
        except Exception as exc:
            raise HTTPException(503, str(exc)) from exc

    @app.post("/api/atlas/plane")
    def atlas_plane(request: PlaneRequest):
        provider = atlas_provider()
        plane = provider.plane(request.ap_index, request.yaw_deg, request.pitch_deg, request.width, request.height, request.hemisphere)
        return Response(provider.render_png(plane, request.boundaries), media_type="image/png")

    @app.post("/api/atlas/summarize")
    def summarize(request: PolygonSummaryRequest):
        provider = atlas_provider()
        plane = provider.plane(request.ap_index, request.yaw_deg, request.pitch_deg, request.width, request.height, request.hemisphere)
        return {"regions": provider.summarize(plane, [(p.x, p.y) for p in request.points])}

    @app.post("/api/auto-align")
    def auto_align(request: AutoAlignRequest):
        try:
            with Image.open(store.slide_path(request.slide_id)) as image:
                result = auto_align_crop(image, request.crop, atlas_provider(), request)
        except (KeyError, FileNotFoundError, OSError, ValueError) as exc:
            raise HTTPException(400, str(exc)) from exc
        return result

    @app.post("/api/suggest-pieces")
    def suggest_pieces(request: PieceSuggestRequest):
        try:
            with Image.open(store.slide_path(request.slide_id)) as image:
                result = detect_red_piece_polygons(
                    image,
                    request.crop,
                    request.width,
                    request.height,
                    request.min_area_fraction,
                )
        except (KeyError, FileNotFoundError, OSError, ValueError) as exc:
            raise HTTPException(400, str(exc)) from exc
        return result

    @app.post("/api/revisions")
    def save_revision(request: SaveRequest):
        return store.save(request.state, request.label)

    @app.get("/api/revisions")
    def revisions():
        return store.revisions()

    @app.get("/api/revisions/{filename}")
    def load_revision(filename: str):
        try:
            return store.load_revision(filename)
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(404, str(exc)) from exc

    app.mount("/assets", StaticFiles(directory=static), name="assets")

    @app.get("/")
    def index():
        return FileResponse(static / "index.html")

    return app

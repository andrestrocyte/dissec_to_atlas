import json
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from dissec_to_atlas.app import create_app
from dissec_to_atlas.atlas import SyntheticAtlasProvider


def project(tmp_path: Path) -> Path:
    image = tmp_path / "slide.png"
    Image.new("RGB", (320, 240), "gray").save(image)
    path = tmp_path / "project.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "project_id": "test",
                "name": "Test",
                "atlas_id": "synthetic_mouse_100um",
                "slides": [
                    {
                        "id": "1",
                        "image_path": str(image),
                        "tissue_pieces": [{"code": "1/1"}],
                        "atlas_ap_index_hint": 40,
                    }
                ],
            }
        )
    )
    return path


def test_synthetic_plane_and_polygon_summary():
    atlas = SyntheticAtlasProvider()
    plane = atlas.plane(40, 0, 0, 320, 240, "both")
    assert plane.reference.shape == (240, 320)
    assert plane.annotation.shape == (240, 320)
    assert len(atlas.render_png(plane)) > 1_000
    summary = atlas.summarize(plane, [(20, 20), (300, 20), (300, 220), (20, 220)])
    assert sum(row["pixels"] for row in summary) == 281 * 201
    assert np.isclose(sum(row["fraction"] for row in summary), 1)
    assert {row["id"] for row in summary} >= {0, 1, 2, 3}


def test_api_provenance_revision_and_reload(tmp_path):
    client = TestClient(create_app(project(tmp_path), synthetic=True))
    assert client.get("/api/health").json()["ok"]
    manifest = client.get("/api/project").json()
    assert manifest["slides"][0]["width"] == 320
    assert len(manifest["slides"][0]["sha256"]) == 64
    plane = client.post(
        "/api/atlas/plane",
        json={"ap_index": 40, "width": 320, "height": 240},
    )
    assert plane.status_code == 200
    assert plane.headers["content-type"] == "image/png"
    saved = client.post("/api/revisions", json={"state": {"slides": {}}, "label": "first"})
    assert saved.status_code == 200
    saved2 = client.post("/api/revisions", json={"state": {"slides": {"1": {}}}, "label": "second"})
    revisions = client.get("/api/revisions").json()
    assert len(revisions) == 2
    assert saved.json()["filename"] != saved2.json()["filename"]
    loaded = client.get(f"/api/revisions/{saved.json()['filename']}").json()
    assert loaded["state"] == {"slides": {}}


def test_path_traversal_is_rejected(tmp_path):
    client = TestClient(create_app(project(tmp_path), synthetic=True))
    assert client.get("/api/revisions/..%2Fproject.json").status_code == 404

import json
from pathlib import Path

import pytest
from PIL import Image

from dissec_to_atlas.project import ProjectStore


def test_duplicate_slide_ids_fail(tmp_path: Path):
    image = tmp_path / "a.png"
    Image.new("L", (10, 10)).save(image)
    manifest = {
        "schema_version": 1,
        "project_id": "x",
        "name": "x",
        "slides": [
            {"id": "1", "image_path": str(image)},
            {"id": "1", "image_path": str(image)},
        ],
    }
    path = tmp_path / "project.json"
    path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="unique"):
        ProjectStore(path)


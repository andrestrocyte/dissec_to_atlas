from __future__ import annotations

import argparse
import json
import webbrowser
from pathlib import Path

import uvicorn

from .app import create_app


def _demo_project(root: Path) -> Path:
    from PIL import Image, ImageDraw

    root.mkdir(parents=True, exist_ok=True)
    image_path = root / "synthetic_section.png"
    image = Image.new("RGB", (1000, 700), "#f5f3ee")
    draw = ImageDraw.Draw(image)
    draw.ellipse((180, 110, 820, 610), fill="#605e5b", outline="#222", width=5)
    draw.ellipse((375, 250, 470, 390), fill="#f5f3ee")
    draw.ellipse((530, 250, 625, 390), fill="#f5f3ee")
    draw.line((500, 115, 500, 605), fill="#d8d3c9", width=3)
    image.save(image_path)
    manifest = {
        "schema_version": 1,
        "project_id": "synthetic-demo",
        "name": "Synthetic dissection demo",
        "atlas_id": "synthetic_mouse_100um",
        "slides": [{"id": "1", "image_path": str(image_path), "tissue_pieces": [{"code": "1/1"}, {"code": "1/2"}], "atlas_ap_index_hint": 40}],
    }
    project = root / "project.json"
    project.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return project


def main(argv: list[str] | None = None):
    parser = argparse.ArgumentParser(description="Interactive tissue-to-atlas registration")
    parser.add_argument("project", nargs="?", type=Path, help="project.json manifest")
    parser.add_argument("--demo", action="store_true", help="run an offline synthetic demo")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args(argv)
    project = _demo_project(Path.home() / ".dissec_to_atlas" / "demo") if args.demo else args.project
    if project is None:
        parser.error("provide project.json or use --demo")
    if not args.no_browser:
        webbrowser.open(f"http://{args.host}:{args.port}")
    uvicorn.run(create_app(project, synthetic=args.demo), host=args.host, port=args.port)


if __name__ == "__main__":
    main()

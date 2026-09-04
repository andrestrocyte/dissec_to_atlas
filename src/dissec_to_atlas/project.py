from __future__ import annotations

import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path

from .models import ProjectManifest


class ProjectStore:
    def __init__(self, project_file: Path):
        self.project_file = project_file.expanduser().resolve()
        if not self.project_file.is_file():
            raise FileNotFoundError(self.project_file)
        self.root = self.project_file.parent
        self.manifest = ProjectManifest.model_validate_json(
            self.project_file.read_text(encoding="utf-8")
        )

    def slide_path(self, slide_id: str) -> Path:
        slide = next((s for s in self.manifest.slides if s.id == slide_id), None)
        if slide is None:
            raise KeyError(f"unknown slide: {slide_id}")
        candidate = Path(slide.image_path).expanduser()
        if not candidate.is_absolute():
            candidate = self.root / candidate
        candidate = candidate.resolve()
        if not candidate.is_file():
            raise FileNotFoundError(candidate)
        return candidate

    @property
    def revisions_dir(self) -> Path:
        path = self.root / "revisions"
        path.mkdir(exist_ok=True)
        return path

    def save(self, state: dict, label: str | None = None) -> dict:
        now = datetime.now(UTC)
        stamp = now.strftime("%Y%m%dT%H%M%S.%fZ")
        clean_label = re.sub(r"[^A-Za-z0-9_-]+", "_", label or "manual")[:40]
        filename = f"{stamp}_{clean_label}.json"
        record = {
            "schema_version": 1,
            "project_id": self.manifest.project_id,
            "saved_at": now.isoformat(),
            "label": label or "manual",
            "state": state,
        }
        payload = json.dumps(record, indent=2, sort_keys=True) + "\n"
        final = self.revisions_dir / filename
        temp = self.revisions_dir / f".{filename}.tmp"
        temp.write_text(payload, encoding="utf-8")
        os.replace(temp, final)
        latest_temp = self.root / ".latest.json.tmp"
        latest_temp.write_text(payload, encoding="utf-8")
        os.replace(latest_temp, self.root / "latest.json")
        return {"filename": filename, "saved_at": record["saved_at"]}

    def revisions(self) -> list[dict]:
        rows = []
        for path in sorted(self.revisions_dir.glob("*.json"), reverse=True):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
                rows.append(
                    {
                        "filename": path.name,
                        "saved_at": record.get("saved_at"),
                        "label": record.get("label"),
                    }
                )
            except (OSError, json.JSONDecodeError):
                continue
        return rows

    def load_revision(self, filename: str) -> dict:
        safe = Path(filename).name
        if safe != filename or not safe.endswith(".json"):
            raise ValueError("invalid revision filename")
        path = self.revisions_dir / safe
        return json.loads(path.read_text(encoding="utf-8"))

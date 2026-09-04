from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator


class TissuePiece(BaseModel):
    code: str
    plate: int | None = None
    well: str | None = None
    source_atlas_plates: list[int] = Field(default_factory=list)
    area: str | None = None
    expression: str | None = None
    notes: str | None = None


class Slide(BaseModel):
    id: str
    display_name: str | None = None
    physical_slide: str | None = None
    image_path: str
    source_files: list[str] = Field(default_factory=list)
    tissue_pieces: list[TissuePiece] = Field(default_factory=list)
    atlas_ap_index_hint: int | None = None
    source_atlas_plate_hints: list[int] = Field(default_factory=list)
    notes: str | None = None
    review_required: bool = False


class ProjectManifest(BaseModel):
    schema_version: Literal[1] = 1
    project_id: str
    name: str
    atlas_id: str = "allen_mouse_25um"
    slides: list[Slide]
    notes: str | None = None

    @model_validator(mode="after")
    def unique_ids(self):
        ids = [s.id for s in self.slides]
        if len(ids) != len(set(ids)):
            raise ValueError("slide ids must be unique")
        return self


class PlaneRequest(BaseModel):
    ap_index: float
    yaw_deg: float = 0
    pitch_deg: float = 0
    width: int = Field(default=640, ge=128, le=1400)
    height: int = Field(default=480, ge=128, le=1200)
    hemisphere: Literal["both", "left", "right"] = "both"
    boundaries: bool = True


class Point(BaseModel):
    x: float
    y: float


class PolygonSummaryRequest(PlaneRequest):
    points: list[Point] = Field(min_length=3)


class AutoAlignRequest(PlaneRequest):
    slide_id: str
    crop: list[float] = Field(min_length=4, max_length=4)
    search_radius: int = Field(default=12, ge=0, le=80)
    search_step: int = Field(default=3, ge=1, le=10)
    allow_flip: bool = True


class PieceSuggestRequest(BaseModel):
    slide_id: str
    crop: list[float] = Field(min_length=4, max_length=4)
    width: int = Field(default=640, ge=128, le=1400)
    height: int = Field(default=480, ge=128, le=1200)
    min_area_fraction: float = Field(default=0.002, ge=0.0001, le=0.1)


class SaveRequest(BaseModel):
    state: dict
    label: str | None = None

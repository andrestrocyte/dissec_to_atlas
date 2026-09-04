from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from functools import lru_cache

import cv2
import numpy as np
from PIL import Image


def _normalise_u8(array: np.ndarray) -> np.ndarray:
    array = np.asarray(array, dtype=np.float32)
    values = array[array > 0]
    if values.size == 0:
        return np.zeros(array.shape, dtype=np.uint8)
    lo, hi = np.percentile(values, (1, 99.5))
    if hi <= lo:
        hi = lo + 1
    return np.clip((array - lo) * 255 / (hi - lo), 0, 255).astype(np.uint8)


def _boundaries(annotation: np.ndarray) -> np.ndarray:
    out = np.zeros(annotation.shape, dtype=bool)
    out[1:, :] |= annotation[1:, :] != annotation[:-1, :]
    out[:, 1:] |= annotation[:, 1:] != annotation[:, :-1]
    return out & (annotation > 0)


@dataclass
class Plane:
    reference: np.ndarray
    annotation: np.ndarray
    ap_voxel: np.ndarray
    dv_voxel: np.ndarray
    ml_voxel: np.ndarray


class AtlasProvider:
    """Atlas access and oblique coronal sampling in BrainGlobe ij coordinates."""

    def __init__(self, atlas_id: str):
        try:
            from brainglobe_atlasapi.bg_atlas import BrainGlobeAtlas
        except ImportError as exc:
            raise RuntimeError(
                "Allen support is not installed. Run: uv sync --extra allen"
            ) from exc
        self.atlas_id = atlas_id
        self.atlas = BrainGlobeAtlas(atlas_id)
        self.reference = np.asarray(self.atlas.template)
        self.annotation = np.asarray(self.atlas.annotation)
        self.shape = tuple(int(v) for v in self.reference.shape)
        self.resolution = tuple(float(v) for v in self.atlas.resolution)
        self.lookup = {
            int(row.id): {"id": int(row.id), "acronym": row.acronym, "name": row.name}
            for row in self.atlas.lookup_df.itertuples()
        }

    def info(self) -> dict:
        atlas = getattr(self, "atlas", None)
        metadata = getattr(atlas, "metadata", {})
        metadata_digest = hashlib.sha256(
            json.dumps(metadata, sort_keys=True, default=str).encode("utf-8")
        ).hexdigest()
        return {
            "id": self.atlas_id,
            "version": metadata.get("version"),
            "citation": metadata.get("citation"),
            "metadata_sha256": metadata_digest,
            "shape": self.shape,
            "resolution_um": self.resolution,
            "orientation": getattr(atlas, "orientation", "asr"),
            "coordinate_order": ["anterior_posterior", "dorsal_ventral", "left_right"],
        }

    # The provider is an app-lifetime singleton, so retaining self is intentional.
    @lru_cache(maxsize=96)  # noqa: B019
    def plane(
        self,
        ap_index: float,
        yaw_deg: float,
        pitch_deg: float,
        width: int,
        height: int,
        hemisphere: str,
    ) -> Plane:
        ap_n, dv_n, ml_n = self.shape
        yy = np.linspace(0, dv_n - 1, height, dtype=np.float32)
        xx = np.linspace(0, ml_n - 1, width, dtype=np.float32)
        ml, dv = np.meshgrid(xx, yy)
        ap = (
            float(ap_index)
            + np.tan(np.deg2rad(float(pitch_deg))) * (dv - (dv_n - 1) / 2)
            + np.tan(np.deg2rad(float(yaw_deg))) * (ml - (ml_n - 1) / 2)
        )
        api = np.clip(np.rint(ap), 0, ap_n - 1).astype(np.intp)
        dvi = np.clip(np.rint(dv), 0, dv_n - 1).astype(np.intp)
        mli = np.clip(np.rint(ml), 0, ml_n - 1).astype(np.intp)
        reference = self.reference[api, dvi, mli]
        annotation = self.annotation[api, dvi, mli]
        mid = (ml_n - 1) / 2
        if hemisphere == "left":
            annotation = np.where(ml <= mid, annotation, 0)
            reference = np.where(ml <= mid, reference, 0)
        elif hemisphere == "right":
            annotation = np.where(ml >= mid, annotation, 0)
            reference = np.where(ml >= mid, reference, 0)
        return Plane(reference, annotation, ap, dv, ml)

    def render_png(self, plane: Plane, show_boundaries: bool = True) -> bytes:
        gray = _normalise_u8(plane.reference)
        rgb = np.repeat(gray[..., None], 3, axis=2)
        if show_boundaries:
            rgb[_boundaries(plane.annotation)] = np.array([45, 212, 191], dtype=np.uint8)
        ok, encoded = cv2.imencode(".png", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
        if not ok:
            raise RuntimeError("could not encode atlas plane")
        return encoded.tobytes()

    def summarize(self, plane: Plane, points: list[tuple[float, float]]) -> list[dict]:
        mask = np.zeros(plane.annotation.shape, dtype=np.uint8)
        polygon = np.rint(np.asarray(points, dtype=np.float32)).astype(np.int32)
        cv2.fillPoly(mask, [polygon], 1)
        ids, counts = np.unique(plane.annotation[mask.astype(bool)], return_counts=True)
        total = int(counts.sum())
        rows = []
        for region_id, count in sorted(zip(ids, counts), key=lambda x: int(x[1]), reverse=True):
            region_id = int(region_id)
            record = self.lookup.get(
                region_id,
                {"id": region_id, "acronym": "outside" if region_id == 0 else "?", "name": "Outside annotated brain" if region_id == 0 else "Unknown"},
            )
            rows.append({**record, "pixels": int(count), "fraction": float(count / total) if total else 0.0})
        return rows


class SyntheticAtlasProvider(AtlasProvider):
    """Small deterministic atlas for demos and offline tests."""

    def __init__(self):
        self.atlas_id = "synthetic_mouse_100um"
        self.resolution = (100.0, 100.0, 100.0)
        self.shape = (80, 72, 96)
        ap, dv, ml = np.indices(self.shape)
        center = np.array([40, 35, 47])
        body = ((ap-center[0])/34)**2 + ((dv-center[1])/29)**2 + ((ml-center[2])/42)**2 < 1
        self.reference = np.zeros(self.shape, dtype=np.uint16)
        self.reference[body] = np.clip(5000 - ((dv[body]-35)**2 + (ml[body]-47)**2)*2, 300, 5000)
        self.annotation = np.zeros(self.shape, dtype=np.uint16)
        self.annotation[body & (ml < 48)] = 1
        self.annotation[body & (ml >= 48)] = 2
        self.annotation[body & (dv > 43)] = 3
        self.lookup = {
            1: {"id": 1, "acronym": "CTX-L", "name": "Synthetic left region"},
            2: {"id": 2, "acronym": "CTX-R", "name": "Synthetic right region"},
            3: {"id": 3, "acronym": "VENT", "name": "Synthetic ventral region"},
        }

    def info(self) -> dict:
        base = super().info()
        base.update({"synthetic": True, "version": "1", "citation": "Synthetic test data"})
        return base


def image_fingerprint(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def auto_align_crop(
    image: Image.Image,
    crop: list[float],
    provider: AtlasProvider,
    request,
) -> dict:
    """Coarse silhouette/ECC registration; its score is advisory, never definitive."""
    x, y, w, h = [round(v) for v in crop]
    x, y = max(0, x), max(0, y)
    w, h = max(8, w), max(8, h)
    tissue = np.asarray(image.convert("L"))[y : y + h, x : x + w]
    if tissue.size == 0:
        raise ValueError("crop is outside the slide image")
    tissue = cv2.resize(tissue, (request.width, request.height))
    tissue = cv2.GaussianBlur(tissue, (5, 5), 0)
    tissue_edges = cv2.Canny(tissue, 35, 100).astype(np.float32) / 255
    tissue_edges = cv2.GaussianBlur(tissue_edges, (7, 7), 0)
    candidates = []
    start = max(0, int(request.ap_index) - request.search_radius)
    stop = min(provider.shape[0] - 1, int(request.ap_index) + request.search_radius)
    indices = list(range(start, stop + 1, request.search_step)) or [int(request.ap_index)]
    for ap_index in indices:
        plane = provider.plane(ap_index, request.yaw_deg, request.pitch_deg, request.width, request.height, request.hemisphere)
        atlas_mask = (plane.annotation > 0).astype(np.uint8) * 255
        atlas_edges = cv2.Canny(atlas_mask, 20, 60).astype(np.float32) / 255
        atlas_edges = cv2.GaussianBlur(atlas_edges, (7, 7), 0)
        for flipped in ([False, True] if request.allow_flip else [False]):
            moving = cv2.flip(tissue_edges, 1) if flipped else tissue_edges
            warp = np.eye(2, 3, dtype=np.float32)
            try:
                score, warp = cv2.findTransformECC(
                    atlas_edges,
                    moving,
                    warp,
                    cv2.MOTION_AFFINE,
                    (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 80, 1e-5),
                    None,
                    3,
                )
            except cv2.error:
                score = -1.0
            candidates.append({"ap_index": ap_index, "flipped": flipped, "score": float(score), "warp": warp.tolist()})
    candidates.sort(key=lambda row: row["score"], reverse=True)
    return {"best": candidates[0], "candidates": candidates[:8], "method": "edge_ecc_affine", "advisory": True}


def detect_red_piece_polygons(
    image: Image.Image,
    crop: list[float],
    width: int,
    height: int,
    min_area_fraction: float = 0.002,
) -> dict:
    """Find closed compartments in a red hand-drawn boundary network."""
    x, y, w, h = [round(value) for value in crop]
    x, y = max(0, x), max(0, y)
    w, h = max(8, w), max(8, h)
    rgb = np.asarray(image.convert("RGB"))[y : y + h, x : x + w]
    if rgb.size == 0:
        raise ValueError("crop is outside the slide image")
    rgb = cv2.resize(rgb, (width, height), interpolation=cv2.INTER_AREA)
    red, green, blue = (rgb[..., index].astype(np.int16) for index in range(3))
    red_mask = ((red > 90) & (red > green * 1.28 + 12) & (red > blue * 1.28 + 12)).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    red_mask = cv2.morphologyEx(red_mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    red_mask = cv2.dilate(red_mask, kernel, iterations=1)
    free = (1 - red_mask).astype(np.uint8)
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(free, 8)
    minimum = width * height * min_area_fraction
    maximum = width * height * 0.45
    polygons = []
    for label in range(1, count):
        left, top, component_w, component_h, area = stats[label]
        touches_border = left == 0 or top == 0 or left + component_w >= width or top + component_h >= height
        if touches_border or not (minimum <= area <= maximum):
            continue
        component = (labels == label).astype(np.uint8)
        contours, _ = cv2.findContours(component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        contour = max(contours, key=cv2.contourArea)
        perimeter = cv2.arcLength(contour, True)
        contour = cv2.approxPolyDP(contour, max(1.5, 0.008 * perimeter), True)
        points = [{"x": float(point[0][0]), "y": float(point[0][1])} for point in contour]
        if len(points) < 3:
            continue
        polygons.append(
            {
                "points": points,
                "area_pixels": int(area),
                "centroid": {"x": float(centroids[label][0]), "y": float(centroids[label][1])},
            }
        )
    polygons.sort(key=lambda row: (row["centroid"]["y"], row["centroid"]["x"]))
    method = "red_boundary_closed_components"
    # Hand-drawn cuts are often open at the tissue edge. In that case, compact
    # coloured number glyphs provide seeds for a conservative within-tissue
    # Voronoi fallback. Codes remain deliberately unassigned in the UI.
    if len(polygons) < 2:
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        _, tissue = cv2.threshold(gray, 0, 1, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
        chroma = rgb.max(axis=2).astype(np.int16) - rgb.min(axis=2).astype(np.int16)
        coloured = ((chroma > 35) & (rgb.max(axis=2) > 60)).astype(np.uint8)
        component_count, _, colour_stats, colour_centroids = cv2.connectedComponentsWithStats(
            coloured, 8
        )
        seeds = []
        for label in range(1, component_count):
            _, _, component_w, component_h, area = colour_stats[label]
            extent = area / max(1, component_w * component_h)
            aspect = max(component_w / max(1, component_h), component_h / max(1, component_w))
            if (
                12 <= area <= width * height * 0.01
                and aspect < 2.2
                and extent >= 0.09
                and component_w < width * 0.2
                and component_h < height * 0.25
            ):
                seeds.append(tuple(float(value) for value in colour_centroids[label]))
        if 2 <= len(seeds) <= 50:
            yy, xx = np.indices((height, width))
            distances = np.stack(
                [(xx - seed_x) ** 2 + (yy - seed_y) ** 2 for seed_x, seed_y in seeds]
            )
            nearest = np.argmin(distances, axis=0)
            fallback = []
            for index, (seed_x, seed_y) in enumerate(seeds):
                component = ((nearest == index) & tissue.astype(bool)).astype(np.uint8)
                component = cv2.morphologyEx(component, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
                contours, _ = cv2.findContours(component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                if not contours:
                    continue
                containing = [
                    candidate
                    for candidate in contours
                    if cv2.pointPolygonTest(candidate, (seed_x, seed_y), False) >= 0
                ]
                contour = max(containing or contours, key=cv2.contourArea)
                if cv2.contourArea(contour) < minimum:
                    continue
                perimeter = cv2.arcLength(contour, True)
                contour = cv2.approxPolyDP(contour, max(1.5, 0.008 * perimeter), True)
                points = [
                    {"x": float(point[0][0]), "y": float(point[0][1])} for point in contour
                ]
                if len(points) >= 3:
                    fallback.append(
                        {
                            "points": points,
                            "area_pixels": int(cv2.contourArea(contour)),
                            "centroid": {"x": seed_x, "y": seed_y},
                        }
                    )
            if len(fallback) >= 2:
                polygons = fallback
                method = "colour_label_seeded_voronoi"
    return {
        "polygons": polygons,
        "method": method,
        "advisory": True,
        "red_pixel_fraction": float(red_mask.mean()),
    }

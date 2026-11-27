"""
Test parts for the shape engine (step 2: shapes from the exact faces, you 2026-11-27: "perfectly detected every time,
even if a shape intersects with the other"), each with its answer key: tests/models/feat-<name>.step and .json.

    python3 -m venv /tmp/cad && /tmp/cad/bin/pip install build123d
    /tmp/cad/bin/python tools/test-part/make_feature_parts.py        # writes tests/models/feat-<name>.{step,json}

Every part sits with its box's corner at the origin (mm). The answer key lists each shape once, by the rule the
recognizer keeps (src/lib/cam/recognize.ts):
  - a shape is what its surfaces are: one hole however many pieces another shape cuts its wall into;
  - shapes at one depth that run into each other are one pocket, but a slot (two facing walls across, open at an end)
    and a hole (a cylinder) stay themselves; a deeper shape starts at the floor of the shallower one it is cut from;
  - "from": the sides it can be reached from (a hole: the ends of its axis that open; a milled shape: the sides it
    is seen open from); "box": what it removes, [x0, y0, z0, x1, y1, z1]; "depth": from where it starts to its floor.
"""

import json
import math
import sys
from pathlib import Path

from build123d import Align, Axis, Box, Cone, Cylinder, Keep, Plane, Pos, Rot, Unit, chamfer, export_step, fillet

LO = (Align.MIN, Align.MIN, Align.MIN)
HOLE = (Align.CENTER, Align.CENTER, Align.MIN)
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / "tests" / "models"
T30 = math.tan(math.radians(30))


def zhole(x, y, d, z0, z1):
    return Pos(x, y, z0) * Cylinder(d / 2, z1 - z0, align=HOLE)


def xhole(y, z, d, x0, x1):
    return Pos(x0, y, z) * Rot(0, 90, 0) * Cylinder(d / 2, x1 - x0, align=HOLE)


def yhole(x, z, d, y0, y1):
    return Pos(x, y0, z) * Rot(-90, 0, 0) * Cylinder(d / 2, y1 - y0, align=HOLE)


def pocket(x0, y0, x1, y1, z0, z1, r):
    p = Pos(x0, y0, z0) * Box(x1 - x0, y1 - y0, z1 - z0, align=LO)
    return fillet(p.edges().filter_by(Axis.Z), r) if r else p


def sink(x, y, top, d, d_out, angle):
    # A countersink: a cone from the hole's Ø up to d_out at the top face, `angle` its included angle.
    h = (d_out - d) / 2 / math.tan(math.radians(angle / 2))
    return Pos(x, y, top - h) * Cone(d / 2, d_out / 2 + 0.5 * math.tan(math.radians(angle / 2)), h + 0.5, align=HOLE), h


def hole(axis, at, d, depth, frm, through):
    return {"kind": "hole", "axis": axis, "at": at, "d": d, "depth": round(depth, 3), "through": through, "from": sorted(frm)}


def pocket_part():
    part = Box(50, 40, 20, align=LO) - pocket(10, 10, 40, 30, 12, 21, 3) - zhole(25, 20, 6, -1, 13)
    return part, [
        {"kind": "pocket", "from": ["Z+"], "box": [10, 10, 12, 40, 30, 20], "depth": 8, "corner": 3},
        hole("Z", [25, 20], 6, 12, ["Z+", "Z-"], True),
    ]


def counterbore_break():
    # The Ø10 counterbore 4 mm from the Y- face breaks out of it (two teeth on that face; your uploaded part's case).
    part = Box(30, 20, 15, align=LO) - zhole(15, 4, 5.5, -1, 16) - zhole(15, 4, 10, 10, 16)
    return part, [
        hole("Z", [15, 4], 5.5, 10, ["Z+", "Z-"], True),
        {"kind": "counterbore", "axis": "Z", "at": [15, 4], "d": 10, "depth": 5, "from": ["Z+"], "open": True},
    ]


def cross_holes():
    part = Box(30, 30, 30, align=LO) - xhole(15, 15, 8, -1, 31) - yhole(15, 15, 6, -1, 31) - zhole(15, 15, 5, 8, 31)
    return part, [
        hole("X", [15, 15], 8, 30, ["X+", "X-"], True),
        hole("Y", [15, 15], 6, 30, ["Y+", "Y-"], True),
        hole("Z", [15, 15], 5, 22, ["Z+"], False),
    ]


def slot_pocket():
    # A pocket 6 deep, a slot along Y at its depth and one along X 10 deep, both across it and out of the part.
    part = Box(60, 40, 20, align=LO) - pocket(15, 8, 45, 32, 14, 21, 4)
    part = part - Pos(-1, 15, 10) * Box(62, 10, 11, align=LO) - Pos(26, -1, 14) * Box(8, 42, 7, align=LO)
    return part, [
        {"kind": "pocket", "from": ["Z+"], "box": [15, 8, 14, 45, 32, 20], "depth": 6, "corner": 4},
        {"kind": "slot", "from": ["X+", "X-", "Z+"], "box": [0, 15, 10, 60, 25, 20], "depth": 10, "width": 10},
        {"kind": "slot", "from": ["Y+", "Y-", "Z+"], "box": [26, 0, 14, 34, 40, 20], "depth": 6, "width": 8},
    ]


def step_pocket():
    # A step along the X+ end 5 deep, and a pocket 10 deep whose X+ end lies under it (the step took that wall's top).
    part = Box(50, 40, 20, align=LO) - Pos(40, -1, 15) * Box(11, 42, 6, align=LO) - pocket(25, 10, 45, 30, 10, 21, 2)
    return part, [
        {"kind": "step", "from": ["X+", "Y+", "Y-", "Z+"], "box": [40, 0, 15, 50, 40, 20], "depth": 5},
        {"kind": "pocket", "from": ["Z+"], "box": [25, 10, 10, 45, 30, 20], "depth": 10, "corner": 2},
    ]


def boss_part():
    part = Box(50, 50, 20, align=LO) - pocket(5, 5, 45, 45, 12, 21, 5)
    part = part + Pos(25, 25, 12) * Cylinder(6, 5, align=HOLE) - zhole(25, 25, 5, -1, 18)
    return part, [
        {"kind": "pocket", "from": ["Z+"], "box": [5, 5, 12, 45, 45, 20], "depth": 8, "corner": 5},
        {"kind": "boss", "from": ["Z+"], "box": [19, 19, 12, 31, 31, 17], "height": 5, "d": 12},
        hole("Z", [25, 25], 5, 17, ["Z+", "Z-"], True),
    ]


def chamfer_holes():
    # The top edges chamfered 1 mm; a Ø8 hole with a 90° countersink to Ø10; a Ø6 hole whose top cuts the chamfer.
    part = Box(40, 30, 15, align=LO)
    part = chamfer(part.edges().group_by(Axis.Z)[-1], 1)
    cone, h = sink(20, 15, 15, 8, 10, 90)
    part = part - zhole(20, 15, 8, -1, 16) - cone - zhole(3.5, 15, 6, -1, 16)
    return part, [
        {"kind": "chamfer", "from": ["X+", "X-", "Y+", "Y-", "Z+"], "size": 1, "angle": 45, "count": 4},
        {"kind": "countersink", "axis": "Z", "at": [20, 15], "d": 10, "angle": 90, "from": ["Z+"]},
        hole("Z", [20, 15], 8, 15 - h, ["Z+", "Z-"], True),
        hole("Z", [3.5, 15], 6, 15, ["Z+", "Z-"], True),
    ]


def countersinks():
    part = Box(40, 20, 12, align=LO)
    c1, h1 = sink(10, 10, 12, 5, 10, 100)
    c2, h2 = sink(30, 10, 12, 4, 8, 60)
    # A blind Ø6, 8 deep, with its drill's 118° point under it.
    tip = 3 / math.tan(math.radians(59))
    point = Pos(20, 10, 4 - tip) * Cone(0.0001, 3, tip, align=HOLE)
    part = part - zhole(10, 10, 5, -1, 13) - c1 - zhole(30, 10, 4, -1, 13) - c2 - zhole(20, 10, 6, 4, 13) - point
    return part, [
        {"kind": "countersink", "axis": "Z", "at": [10, 10], "d": 10, "angle": 100, "from": ["Z+"]},
        {"kind": "countersink", "axis": "Z", "at": [30, 10], "d": 8, "angle": 60, "from": ["Z+"]},
        hole("Z", [10, 10], 5, 12 - h1, ["Z+", "Z-"], True),
        hole("Z", [30, 10], 4, 12 - h2, ["Z+", "Z-"], True),
        {**hole("Z", [20, 10], 6, 8, ["Z+"], False), "point": 118},
    ]


def slope_hole():
    s, c = math.sin(math.radians(30)), math.cos(math.radians(30))
    part = Box(40, 30, 20, align=LO).split(Plane(origin=(30, 0, 20), z_dir=(s, 0, c)), keep=Keep.BOTTOM)
    part = part - zhole(35, 15, 5, -1, 21)
    return part, [
        {"kind": "slope", "from": ["Y+", "Y-", "Z+"], "box": [30, 0, round(20 - 10 * T30, 3), 40, 30, 20], "angle": 30},
        hole("Z", [35, 15], 5, 20 - 2.5 * T30, ["Z+", "Z-"], True),
    ]


PARTS = {
    "pocket-hole": (pocket_part, (50, 40, 20)),
    "counterbore-break": (counterbore_break, (30, 20, 15)),
    "cross-holes": (cross_holes, (30, 30, 30)),
    "slot-pocket": (slot_pocket, (60, 40, 20)),
    "step-pocket": (step_pocket, (50, 40, 20)),
    "boss": (boss_part, (50, 50, 20)),
    "chamfer-holes": (chamfer_holes, (40, 30, 15)),
    "countersinks": (countersinks, (40, 20, 12)),
    "slope-hole": (slope_hole, (40, 30, 20)),
}

for name, (make, size) in PARTS.items():
    part, key = make()
    bb = part.bounding_box()
    got = (bb.size.X, bb.size.Y, bb.size.Z)
    # Self-check: one valid solid of the drawn size, its corner at the origin.
    assert len(part.solids()) == 1 and part.is_valid, name
    assert all(abs(g - w) < 1e-3 for g, w in zip(got, size)) and min(bb.min.X, bb.min.Y, bb.min.Z) > -1e-6, (name, got)
    path = OUT / f"feat-{name}.step"
    export_step(part, str(path), unit=Unit.MM, timestamp="2026-01-01T00:00:00")
    (OUT / f"feat-{name}.json").write_text(json.dumps({"size": list(size), "features": key}, indent=1) + "\n")
    print(f"{path.name}: {len(key)} shapes, {len(part.faces())} faces, {part.volume:.0f} mm3")

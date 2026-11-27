"""
Five STEP test parts (exact B-rep, mm, Z up, each part's box corner at the origin) with shapes CAM AI's holding and
flipping logic finds hard: something thin or narrow that ends up under the part, in the jaws or on the parallels.

    python3 -m venv /tmp/cad && /tmp/cad/bin/pip install build123d
    /tmp/cad/bin/python tools/test-part/make_step_parts.py        # writes tests/models/step-<name>.step

fin                 40 x 30 x 28. Base 40 x 30 x 10; a fin 2 thick (X), 22 long (Y), 18 tall standing on the base 4 mm in
                    from the X- edge; 2 x Ø3.3 through the base. Fin down, it is all that would touch the parallels;
                    fin up, the jaws can only grip the 10 mm base.
foot-under-body     30 x 24 x 18. Body 30 x 24 x 10 on a foot 16 x 12 x 8 (centred, 7 / 6 mm overhang all round); Ø4.5
                    through the axis, 90° countersink Ø9 on the body's top (Z+); a half-cylinder notch R4 with a vertical
                    axis through the body's Y+ face (centred in X). Foot down, its walls are under the body (the
                    owner's 5-clamping / nest case); foot up, the next clamping can only grip the foot.
side-tab            52 x 30 x 8. Plate 40 x 30 x 8; a tab 2.5 thick (Z 2.75..5.25, mid-height), 12 out of the X+ face,
                    10 wide (Y 10..20). Face up or down, its top and underside are cut in two clampings; on end
                    (X+ or X- up) it points up out of the vise or down into it.
t-stem              36 x 36 x 31. Flange 36 x 36 x 6; a square stem 8 x 8 standing 25 tall in its middle; 4 x Ø4.5
                    through the flange 5 mm in from the corners. Flange down, the stem is all there is to grip.
angled-and-fillets  40 x 30 x 20. Block with R3 vertical edges; its top slopes down 30° from horizontal over the last
                    10 mm of the X+ end (the end 14.23 high); Ø6.6 through with a Ø11 x 6.5 counterbore from the top at
                    (8, 15); a pocket 10 (X) x 16 (Y) x 5 deep with R2 corners at X 16..26, Y 7..23.
teeth               20 x 10 x 16. Block whose bottom (Z-) slopes up 30° to both X ends from a 4 mm flat (X 8..12); a
                    Ø8 counterbore from the Y+ face (Y 4..10) at (X 10, Z 3.5) breaks through that flat, leaving two
                    0.06 mm teeth; Ø3.2 through from it to the Y- face. Y+ first, the next clamping's jaws would hold the
                    Z faces (one of them the teeth): turned a quarter about Z, they hold the X faces.

Plan them with camProgram(tris from stepTriangles(src/lib/step.ts), orient: { side, spin: false }) for each first side.
"""

import math
import sys
from pathlib import Path

from build123d import Align, Axis, Box, Cone, Cylinder, Keep, Plane, Pos, Rot, Unit, export_step, fillet

LO = (Align.MIN, Align.MIN, Align.MIN)
HOLE = (Align.CENTER, Align.CENTER, Align.MIN)
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / "tests" / "models"


def hole(x, y, d, z0, z1):
    return Pos(x, y, z0) * Cylinder(d / 2, z1 - z0, align=HOLE)


def fin():
    base = Box(40, 30, 10, align=LO)
    blade = Pos(4, 4, 10) * Box(2, 22, 18, align=LO)
    part = base + blade - hole(22, 10, 3.3, -1, 11) - hole(32, 20, 3.3, -1, 11)
    return part, 40 * 30 * 10 + 2 * 22 * 18 - 2 * math.pi * 1.65**2 * 10


def foot_under_body():
    foot = Pos(7, 6, 0) * Box(16, 12, 8, align=LO)
    body = Pos(0, 0, 8) * Box(30, 24, 10, align=LO)
    sink = Pos(15, 12, 18 - 2.25) * Cone(2.25, 5.25, 3.0, align=HOLE)  # 90°: the radius grows as much as the height
    notch = hole(15, 24, 8, 7, 19)
    part = foot + body - hole(15, 12, 4.5, -1, 19) - sink - notch
    r, R, h = 2.25, 4.5, 2.25
    sink_extra = math.pi * h / 3 * (R * R + R * r + r * r) - math.pi * r * r * h
    return part, 16 * 12 * 8 + 30 * 24 * 10 - math.pi * 16 / 2 * 10 - math.pi * r * r * 18 - sink_extra


def side_tab():
    part = Box(40, 30, 8, align=LO) + Pos(40, 10, 2.75) * Box(12, 10, 2.5, align=LO)
    return part, 40 * 30 * 8 + 12 * 10 * 2.5


def t_stem():
    part = Box(36, 36, 6, align=LO) + Pos(14, 14, 6) * Box(8, 8, 25, align=LO)
    for x, y in ((5, 5), (31, 5), (5, 31), (31, 31)):
        part -= hole(x, y, 4.5, -1, 7)
    return part, 36 * 36 * 6 + 8 * 8 * 25 - 4 * math.pi * 2.25**2 * 6


def angled_and_fillets():
    block = Box(40, 30, 20, align=LO)
    block = fillet(block.edges().filter_by(Axis.Z), 3)  # before any hole: their seams are Z edges too
    s, c = math.sin(math.radians(30)), math.cos(math.radians(30))
    block = block.split(Plane(origin=(30, 0, 20), z_dir=(s, 0, c)), keep=Keep.BOTTOM)
    pocket = Pos(16, 7, 15) * Box(10, 16, 6, align=LO)
    pocket = fillet(pocket.edges().filter_by(Axis.Z), 2)
    part = block - hole(8, 15, 6.6, -1, 21) - hole(8, 15, 11, 20 - 6.5, 21) - pocket
    wedge = 10 * 10 * math.tan(math.radians(30)) / 2 * 30
    cbore = math.pi * 3.3**2 * 20 + math.pi * (5.5**2 - 3.3**2) * 6.5
    return part, 40 * 30 * 20 - 4 * (9 - math.pi * 9 / 4) * 20 - wedge - cbore - (160 - 4 * (4 - math.pi)) * 5


def teeth():
    part = Box(20, 10, 16, align=LO)
    s, c = math.sin(math.radians(30)), math.cos(math.radians(30))
    part = part.split(Plane(origin=(8, 0, 0), z_dir=(-s, 0, -c)), keep=Keep.BOTTOM)
    part = part.split(Plane(origin=(12, 0, 0), z_dir=(s, 0, -c)), keep=Keep.BOTTOM)
    part -= Pos(10, 4, 3.5) * Rot(-90, 0, 0) * Cylinder(4, 7, align=HOLE)
    part -= Pos(10, -1, 3.5) * Rot(-90, 0, 0) * Cylinder(1.6, 6, align=HOLE)
    wedges = 2 * 8 * 8 * math.tan(math.radians(30)) / 2 * 10
    # The counterbore's disc less the 0.5 mm segment under the flat, 6 deep; the through hole 4 long.
    seg = 16 * math.acos(3.5 / 4) - 3.5 * math.sqrt(16 - 3.5**2)
    return part, 20 * 10 * 16 - wedges - (math.pi * 16 - seg) * 6 - math.pi * 1.6**2 * 4


PARTS = {
    "fin": (fin, (40, 30, 28)),
    "foot-under-body": (foot_under_body, (30, 24, 18)),
    "side-tab": (side_tab, (52, 30, 8)),
    "t-stem": (t_stem, (36, 36, 31)),
    "angled-and-fillets": (angled_and_fillets, (40, 30, 20)),
    "teeth": (teeth, (20, 10, 16)),
}

for name, (make, size) in PARTS.items():
    part, volume = make()
    bb = part.bounding_box()
    got = (bb.size.X, bb.size.Y, bb.size.Z)
    # Self-check: one valid solid, the drawn size, the hand-summed volume (the slope's wedge loses a little to the fillets).
    assert len(part.solids()) == 1 and part.is_valid, name
    assert all(abs(g - w) < 1e-3 for g, w in zip(got, size)) and min(bb.min.X, bb.min.Y, bb.min.Z) > -1e-6, (name, got)
    assert abs(part.volume - volume) < 0.005 * volume, (name, part.volume, volume)
    path = OUT / f"step-{name}.step"
    export_step(part, str(path), unit=Unit.MM, timestamp="2026-01-01T00:00:00")
    print(f"{path.name}: {got[0]:g} x {got[1]:g} x {got[2]:g}, {part.volume:.0f} mm3, {path.stat().st_size // 1024} KB")

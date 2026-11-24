"""
CAM AI's test part: one block with every kind of operation CAM AI plans, to test and troubleshoot it on.

    python3 -m venv /tmp/tp && /tmp/tp/bin/pip install manifold3d numpy
    /tmp/tp/bin/python tools/test-part/make_test_part.py tests/models/cam-test-part.stl

100 x 60 x 30 mm, its corner at the origin, Z up (the top face is Z+). Each feature and the operation it calls
for is listed in FEATURES below and in docs/knowledge/cam-test-part.md. Every Ø is a hole of the model as drawn
(no threads): the drills CAM AI picks are the inventory's nearest within 0.12 mm.
"""

import struct
import sys

import manifold3d as m
from manifold3d import CrossSection, Manifold

SEG = 96  # segments per full circle: round holes and corners read as cylinders, not facets

L, W, H = 100.0, 60.0, 30.0
CORNER_R = 6.0  # the outline's vertical corners
CHAMFER = 1.0  # 45° on the outline's top edges

FEATURES = [
    ("Top face", "facing (PLAN): the blank's top, 2 mm"),
    ("Outline 100 x 60, R6 corners", "outline (FRAESEN, cut whole in clamping 1, 0.5 mm under the part)"),
    ("1 x 45° chamfer round the top edge", "chamfer (FASE, the 90° graver)"),
    ("Slope at the X- end, 23° from 6 mm down", "3D surface (noted as left; the ball end mill's)"),
    ("Step at the X+ end: 14 wide, 12 down, open three sides", "shoulder (FRAESEN), its floor a level"),
    ("R3 round on the step's top edge", "rounded edge (the corner-rounding mill's; chamfered today)"),
    ("Pocket 32 x 26, R4 corners, 12 deep", "pocket (FRAESEN, corners left at the pocket mill's radius)"),
    ("Island Ø12 in the pocket, 8 high, R1.5 round on top", "pocket round an island; rounded edge"),
    ("Slot 4 wide, 32 long, 6 deep, 2 mm from the Y+ face", "narrow slot (small mill); thin wall (2 mm)"),
    ("Through holes Ø3.3, Ø4.2, Ø5, Ø6.8", "spot drill (under Ø4) and drill (ZENTRIERBOHREN, BOHREN, G83)"),
    ("Blind hole Ø5, 15 deep, drill point", "drill to the point (0.3 x Ø deeper)"),
    ("Blind hole Ø10, 8 deep, flat bottom", "flat-bottomed hole (milled, or drilled when a Ø10 is there)"),
    ("Counterbore Ø11 x 6.5 on a Ø6.6 hole, from the top", "hole and counterbore in one clamping"),
    ("Countersink 90° Ø12 on a Ø6.4 hole", "drill, then the countersink as a 45° chamfer (graver)"),
    ("Hole Ø13 through", "no drill of that Ø: milled (helix or rings)"),
    ("Pocket 28 x 22, R3, 8 deep, from the bottom", "second clamping (Z-): facing, pocket"),
    ("Counterbore Ø10 x 5 from the bottom on a Ø5.5 hole", "the hole drilled from the counterbore's side, with it"),
    ("Hole Ø6, 15 deep, in the Y+ face", "a clamping on an edge (Y+ up), drilled there"),
    ("Slot 16 x 8, 6 deep, in the Y- face", "a clamping on the other edge (Y- up): a pocket open to that face only"),
]


def rounded_rect(x0, y0, x1, y1, r):
    """A rectangle with round corners of radius r, as a cross-section."""
    return CrossSection.square([x1 - x0 - 2 * r, y1 - y0 - 2 * r]).translate([x0 + r, y0 + r]).offset(r, m.JoinType.Round, 2.0, SEG)


def stadium(x0, y0, x1, y1):
    """A slot's outline: its ends round (radius half its width), along X."""
    r = (y1 - y0) / 2
    return rounded_rect(x0, y0, x1, y1, r - 1e-3)


def cyl(x, y, z0, z1, d, d_top=None):
    """A cylinder (or cone) along Z from z0 to z1."""
    rb = d / 2
    rt = rb if d_top is None else d_top / 2
    return Manifold.cylinder(z1 - z0, rb, rt, SEG).translate([x, y, z0])


def box(x0, y0, z0, x1, y1, z1):
    return Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0])


def body():
    outline = rounded_rect(0, 0, L, W, CORNER_R)
    # The top chamfer: the hull of the outline up to H - CHAMFER and its outline 1 mm in at H (it is convex).
    return Manifold.batch_hull([outline.extrude(H - CHAMFER), outline.offset(-CHAMFER, m.JoinType.Round, 2.0, SEG).extrude(H)])


def part():
    p = body()
    cut = []

    # Slope at the X- end: from z 24 at x 0 up to the top at x 14, across the whole width.
    slope = CrossSection([[(-1.0, 24.0 - 6.0 / 14.0), (14.0, H), (14.0, H + 5), (-1.0, H + 5)]])
    # The cross-section is drawn in X (as x) and Z (as y); extruded along Z, then turned so the extrusion runs along Y.
    cut.append(slope.extrude(W + 2).rotate([90, 0, 0]).translate([0, W + 1, 0]))

    # Step at the X+ end: x 86..100 above z 18; its top edge (x 86, z 30) rounded R3.
    cut.append(box(86, -1, 18, L + 1, W + 1, H + 1))
    r = 3.0
    corner = box(86 - r, -1, H - r, 86 + 0.01, W + 1, H + 1) - Manifold.cylinder(W + 4, r, r, SEG).rotate([-90, 0, 0]).translate([86 - r, -2, H - r])
    cut.append(corner)

    # Pocket x 18..50, y 8..34, R4 corners, floor z 18.
    cut.append(rounded_rect(18, 8, 50, 34, 4).extrude(H + 1 - 18).translate([0, 0, 18]))
    # Slot y 54..58 (2 mm wall to the Y+ face), x 18..50, floor z 24.
    cut.append(stadium(18, 54, 50, 58).extrude(H + 1 - 24).translate([0, 0, 24]))

    # Through holes along y 10.
    for x, d in [(59, 3.3), (66, 4.2), (73, 5.0), (80, 6.8)]:
        cut.append(cyl(x, 10, -1, H + 1, d))
    # Blind Ø5, 15 deep to where its wall ends, a 118° drill point under it (0.3 x Ø).
    cut.append(cyl(60, 24, H - 15, H + 1, 5.0))
    cut.append(cyl(60, 24, H - 15 - 0.3 * 5.0, H - 15 + 1e-3, 0.0, 5.0))
    # Blind Ø10, 8 deep, flat bottom.
    cut.append(cyl(72, 24, H - 8, H + 1, 10.0))
    # Counterbore from the top: Ø11 x 6.5 on a Ø6.6 hole through.
    cut.append(cyl(60, 38, H - 6.5, H + 1, 11.0))
    cut.append(cyl(60, 38, -1, H + 1, 6.6))
    # Countersink 90°: Ø12 at the top face down to the Ø6.4 hole (2.8 deep), the hole through.
    cut.append(cyl(75, 38, H - 2.8, H + 1, 6.4, 12.0 + 2.0))
    cut.append(cyl(75, 38, -1, H + 1, 6.4))
    # Ø13 through: no drill of that Ø.
    cut.append(cyl(67, 51, -1, H + 1, 13.0))

    # From the bottom: a pocket x 20..48, y 10..32, R3, 8 deep; a counterbore Ø10 x 5 on a Ø5.5 hole through.
    cut.append(rounded_rect(20, 10, 48, 32, 3).extrude(9).translate([0, 0, -1]))
    cut.append(cyl(82, 30, -1, 5, 10.0))
    cut.append(cyl(82, 30, -1, H + 1, 5.5))

    # Side hole in the Y+ face: Ø6, 15 deep, at x 40, z 12.
    cut.append(Manifold.cylinder(16, 3.0, 3.0, SEG).rotate([90, 0, 0]).translate([40, W + 1, 12]))
    # Side slot in the Y- face: x 56..72, z 8..16, 6 deep.
    cut.append(box(56, -1, 8, 72, 6, 16))

    p = p - Manifold.batch_boolean(cut, m.OpType.Add)
    # The island in the pocket: Ø12 at (34, 21), from the floor (z 18) to z 26, its top edge rounded R1.5.
    rr = 1.5
    ring = CrossSection.circle(rr, SEG).translate([6.0 - rr, 0]).revolve(SEG).translate([34, 21, 26 - rr])
    island = Manifold.batch_hull([cyl(34, 21, 18 - 0.01, 26 - rr, 12.0), ring])
    return p + island


def write_stl(manifold, path):
    mesh = manifold.to_mesh()
    v = mesh.vert_properties
    t = mesh.tri_verts
    with open(path, "wb") as f:
        f.write(b"CAM AI test part (tools/test-part/make_test_part.py)".ljust(80, b" "))
        f.write(struct.pack("<I", len(t)))
        for a, b, c in t:
            pa, pb, pc = v[a][:3], v[b][:3], v[c][:3]
            u = [pb[i] - pa[i] for i in range(3)]
            w = [pc[i] - pa[i] for i in range(3)]
            n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
            ln = (n[0] ** 2 + n[1] ** 2 + n[2] ** 2) ** 0.5 or 1.0
            f.write(struct.pack("<12fH", *(x / ln for x in n), *pa, *pb, *pc, 0))
    return len(t)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "cam-test-part.stl"
    solid = part()
    lo, hi = solid.bounding_box()[:3], solid.bounding_box()[3:]
    print(f"triangles {write_stl(solid, out)}, volume {solid.volume():.0f} mm3, genus {solid.genus()}, box {lo} {hi}")
    for name, op in FEATURES:
        print(f"  {name}: {op}")

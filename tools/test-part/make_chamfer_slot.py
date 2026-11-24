"""
A 50 x 30 x 20 block, a 1 x 45° chamfer round its top, a slot 20 x 8, 6 deep in its Y- face: the side slot needs a
clamping with Y- up, which sees the top chamfer along that edge as a chamfer too (tests/camMoves.test.ts).

    /tmp/tp/bin/python tools/test-part/make_chamfer_slot.py tests/models/chamfer-side-slot.stl
"""

import sys

from manifold3d import Manifold

from make_test_part import box, write_stl

body = Manifold.batch_hull([box(0, 0, 0, 50, 30, 19), box(1, 1, 19, 49, 29, 20)])
write_stl(body - box(15, -1, 6, 35, 6, 14), sys.argv[1])

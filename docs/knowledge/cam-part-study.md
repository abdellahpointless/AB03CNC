# One part, operation by operation: CAM AI against the engineers (Phase 8)

A contour insert in POM, 70 x 42 x 40, on HAAS-5. The engineers' program is Pc91f5aad (P and the first 8 hex
digits of the file's SHA-1); it is not in the reference library. Compared:

- **Engineers**: Pc91f5aad, blank 74 x 46 x 50.
- **CAM AI as run on the app** (deployed at 3be4fca): P8bf16da4, blank 74.03 x 46 x 40 (no stock in Z).
- **CAM AI today** (commit 48f4ce2, HAAS-5's seed tools), on the engineers' blank, from tools/camLibrary.ts.

Times are the app's own time model (src/lib/toolpath.ts); material per operation is what the simulation sees
each operation take first (4 million voxels). Scripts: one-off, not in the repository.

## The numbers

| | Engineers | CAM AI on the app | CAM AI today, engineers' blank |
|---|---|---|---|
| Lines | 2,543 | 26,376 | 14,738 |
| Minutes | 16.9 (their own file: 23.6) | 51.3 | 56.1 |
| Clampings | 3 | 3 (the third in the POM nest) | 3 |
| Parallels / grip (mm) | 40/5, 8/37, 8/37 | 42/3, 40/5, nest on 38 | 40/5, 28/17, 28/17 |
| Tool changes / different tools | 21 / 14 | 35 / 23 | 33 / 21 |
| Moves that change Z while cutting (ramps) | 27 | 16,138 | 6,216 |
| Smallest end mill | Ø4 | Ø1 | Ø1 |

## Where CAM AI's time and lines go

1. **End mills under Ø6 chasing corners.** Today: Ø1 12.0 min, Ø3 4.2 + 9.3, Ø4 2.8, Ø2.5 1.3, Ø5 0.9: 30.4
   of 56.1 minutes and 8,663 of 14,738 lines (59 %), for 541 mm³ (0.5 % of what is cut). The Ø1 takes
   29 mm³ in 12 minutes: 0.4 mm slivers in the inside corners of a pocket, 30 mm deep. The engineers leave those
   corners at the radius of their pocket mills (Ø6, then Ø4 where narrow: 1.4 min for the Ø4) and their part
   matches the model at a 0.26 mm grid (99.7 %, nothing cut that should stay).
2. **Ramping on every move.** CAM AI writes every pass as a slope (Z changing on each move), so arcs become
   strings of short lines and nothing merges. The engineers ramp once into closed material (7 lines), then cut
   each level at one Z with G02/G03, and go down to the next level in the open pocket with a straight 2 mm
   plunge at reduced feed (F720 against F1200).
3. **Slow cutting data on the largest mill.** CAM AI roughs with the Ø30 SF at 1000 rpm, F250-500 (the only
   data for that tool: one KONTUR_30MM). 9.8 min, 3,900 mm³/min. The engineers' outline: Ø20 SF at 4000 rpm,
   F1200, 12 levels, 145 lines, 1.7 min, 13,700 mm³/min.
4. **One drill per hole size read from the model.** CAM AI: 9 drill sizes (3, 3.2, 3.5, 4.5, 4.6, 4.8, 5, 6.4,
   2.5). The engineers: 5 (2.5, 2.96, 3.5, 4, 4.6), and the counterbores with end mills already in the
   program, plunged in a G83 (Ø6 at the 4 corner holes after a Ø4.6 pilot, Ø5 for one flat-bottomed hole). Their
   sizes differ from what CAM AI reads off the PDF's facets: 3.5 for 3.2, 4.6 for 4.8, Ø6 for 6.3.

## How the engineers hold it, and why CAM AI holds it thinner

- **Clamping 1, the face with most of the work up** (the large pocket, the screw holes, the counterbores):
  the blank's extra 10 mm in Z is gripped 5 mm deep on 40 mm parallels, and the whole outline is cut through
  in this clamping (Ø20 to 0.5 mm under the part). Nothing outside the outline is left for later.
- **Clamping 2, turned over on 8 mm parallels**: the Ø93 face mill takes off the remaining blank (4 passes, under
  a minute) while the jaws hold the finished outline 37 mm deep. Only an inside pocket (15 deep), deburring
  and a hole are left for this side.
- **Clamping 3, on its end, on 8 mm parallels**: 37 mm grip again; a side pocket 34 deep and the side holes.
- The part's outline is the same 42 x 70 from the bottom face up to 38.3 mm (its top edges are rounded), so
  once it is cut a later clamping can grip it almost its full height.

CAM AI on the app had no Z stock: its first clamping gripped the part itself 3 mm (42 mm parallels), could not
cut the outline through, finished it in clamping 2 on 5 mm, and needed the POM nest for the third.

With the engineers' blank, what limits each later grip (logged in the planner's grip choice, `deepest()`):

| Plan | Clamping | Outline allows | Limited by stock left beside the part at | Grip taken |
|---|---|---|---|---|
| CAM AI's own (bottom face first) | 2, top face up | 37 mm | 18.3 mm | 17 (28 mm parallels) |
| CAM AI's own | 3, on its end | 37 mm | 17.8 mm | 17 (28 mm parallels) |
| Forced to the engineers' first face | 2, bottom face up | 37 mm | 1.05 mm | 3 (42 mm parallels) |

- Starting from the bottom face, CAM AI leaves for clamping 2 stock beside the part that only the top face
  sees; the jaws must stay under it.
- Started from the engineers' face, it is worse: CAM AI does not cut the rounded top edges (it notes them as a
  surface it leaves), so that square stock sits at the bottom of clamping 2 and the jaws can take 1 mm. The
  engineers cut the radius in clamping 1 (corner-rounding mill, 1 minute), which is what lets them grip 37.
- On its end, CAM AI leaves stock beside the part that it then cuts from the end, 51 mm deep (Ø8, Ø3); the
  engineers never go deeper than 34 from that end.
- The order alone is not the lever: forced to start from the engineers' face, CAM AI takes 40.0 to 54.2 minutes
  and 15,545 to 16,134 lines (on 40, 38, 38 mm parallels), against 56.1 and 14,738 from its own order.

## Why each engineers' operation, in order

| Clamping | Operation | Tool | Why |
|---|---|---|---|
| 1 | Face, 2 passes | Ø93 face mill | Top flat; the blank's 2 mm |
| 1 | Drill 8 holes | Ø4.6 | Screw holes to depth plus the drill tip; pilots for the Ø6 counterbores |
| 1 | Drill 1 hole | Ø2.96 | The small step under a Ø4.6 |
| 1 | Drill 5 holes | Ø3.5 | The 4 corner through holes (1.5 mm past the part), one in the pocket |
| 1 | Outline, 12 levels | Ø20 SF | The whole outline through, in one tool |
| 1 | Inside corner of the outline | Ø8 SF | Where the Ø20 cannot reach |
| 1 | Large pocket, levels outward | Ø6 SF | Pocket 18.7 deep, 3.5 mm a level |
| 1 | Counterbores, G83 | Ø6 SF (same tool) | Ø6 x 8 on the 4 corner holes, no tool change |
| 1 | Flat-bottomed hole, G83 | Ø5 SF | One Ø5 hole |
| 1 | Narrow parts | Ø4 SF | Where the Ø6 cannot reach |
| 1 | Edge radius | Corner-rounding mill | The model's rounded top edges |
| 1 | Chamfers 45° | Chamfer mill | Edges |
| 2 | Face, 4 passes | Ø93 (loaded before the turn) | The remaining blank, down to the part |
| 2 | Pocket 15 deep | Ø5 SF | The bottom pocket |
| 2 | Deburr | Deburring tool | Edges of this side |
| 3 | Drill 3 holes | Ø4 (loaded before the turn) | Not holes of the model: the inside corners of the end pocket's narrow part, to its depth (22.6 and 34). The drill makes those corners and the mills' way in |
| 3 | Side pocket 34 deep | Ø6 SF | The pocket on the end; in with a straight 2 mm plunge, no ramp |
| 3 | Narrow parts | Ø4 SF | Finishing in the side pocket |
| 3 | Holes | Ø4.6, centre drill, Ø2.5 | The end's holes |

## Errors found on the way

E1 matters for everything checked so far: every pass reported until now (the 10, the 14, the 108, what is
deployed) came from this check, so errors under about 2 mm were never looked for. The order to fix: E2 first
(else a finer check reports the 1 mm of E2 as cuts), then a finer check.

| # | Error | Effect | Evidence |
|---|---|---|---|
| E1 | The app's model check counts a difference only where a sample and its 6 neighbours all differ: at its grid (about 0.8 mm) anything thinner than about 2 mm is never seen. | "100 % like the model" while 1 mm is wrong. | At 0.24 mm: 98.2 % with cuts of up to 313 mm³ (see E2). |
| E2 | The simulation places the part in a later clamping by a guess from the facing passes, and ignores the program's own height (G52, parallels, nest floor) when the two differ by under 1.5 mm. In the nest clamping it stood the part 1.04 mm too high. | The 3D "Part" view shows every floor of that clamping 1 mm too deep (probably the extra milling seen on the app). The program itself is right: placed by its G52, nothing is cut that should stay (0.24 mm grid). | P8bf16da4, clamping 3 |
| E3 | Blind holes are drilled with the tip at the depth where the full diameter should end. | Blind holes are 0.3 x Ø short at full diameter (Ø4.8: 1.4 mm). The engineers add the tip: Z-28.642 against CAM AI's Z-27.2. Seen on this part's 6 holes; to check on the library before it becomes a rule. | P8bf16da4 and today's code |

## Open questions

- The blank: the run on the app had 74 x 46 x 40, the engineers 74 x 46 x 50. How much Z stock does the shop
  keep to grip in the first clamping (here 10)?
- Inside vertical corners: left at the radius of the pocket mill unless the drawing asks for less?
- Hole sizes (3.5 for 3.2, 4.6 for 4.8, Ø6 for 6.3): the shop's sizes for screws in POM, or the PDF's model?
- Straight 2 mm plunges into the next level of an open pocket: POM only, or every material?
- The Ø30 SF's data (1000 rpm, F500): from which material?

## What was fixed and changed (Phase 8.1 and 8.2)

Your answers: inside corners at the pocket mill's radius (yes); straight plunges in POM, FH and RESOPAL only; the
tighter holes are the threaded inserts'; the Z stock: what the engineers keep.

| Step | Commit | The study's part (engineers' blank): lines, minutes |
|---|---|---|
| Before | 48f4ce2 | 14,738, 56.1 |
| E2: a later clamping of CAM AI's own program stands where its G52 puts it (the 3D view showed 1 mm too deep) | f83c786 | the program unchanged; its view and check right |
| E3: blind holes drawn with a drill point drilled to it (0.3 x Ø deeper) | 9e8c5c4 | holes now full depth |
| E1: the program as it goes out checked again on a 7 times finer grid for cuts into the part | e4b8254 | no cut found |
| Straight plunges in POM, FH and RESOPAL (Ø3 to 8 template mills) | 778bbf1 | 11,846, 51.2 |
| Inside corners left at the pocket mill's radius (Ø8 or smaller); no clamping more for them | 5f9a747 | 4,930, 25.5 |
| Those corners not counted as material left by the check | 85c914c | |
| The first mill on a level: the one taking most a minute among its kind (POM: the Ø20, not the Ø30) | 28d84c6, c444c71 | 4,434, 18.2 |
| The engineers | | 2,543, 16.9 |

E4 (the Z stock lost on the app): not reproduced. The page's default (3.5 a side) gives 74.03 x 46 x 47 with the
deployed planner and today's; the program shows 40, so that run's page sent 0 mm in Z.

The 10 at c444c71 (against 48f4ce2): 182.9 minutes (241.0; the engineers 147.8), 80,705 lines (125,426; the
engineers 31,782), 35 clampings (32; the engineers 24).
- P441ba43c 4 clampings (2): CAM AI plans it three ways; its 2-clamping way is slower than the 4-clamping one by
  more than 2 minutes a clamping. The engineers do it in 2 and 15.5 minutes.
- Pedda39a5 5 (4): 5.6 minutes against 8.8 with 4.
- Pfae5765f fails: the finer check finds a cut 0.5 mm into a wall (10 mm³, the Ø16 in clamping 4). It is there
  before these changes (778bbf1 too): the old check could not see it. The program is refused now.

The Z stock the engineers keep (175 headers with part and blank sizes, the smallest size): 10 mm in 33, 4 in 27,
5 in 12, 7 in 12, 8.5 in 10, 9 in 9.

Left for the next step (the part analysis): the rounded top edges are chamfered with the 45° graver along every
edge (962 lines; the engineers: a corner-rounding mill, 24 lines); counterbores with the end mills in the program;
the threaded inserts' holes; the face with most of the work first (W1, now that the corners no longer cost the
time it lost before); the clampings that grip 17 mm where the engineers grip 37.

### The review round (after c444c71)

A review of the round above found three rules going further than the evidence; each was narrowed, test first:

| Change | Commit | Why |
|---|---|---|
| Straight plunges go 2 mm into material at most; the rest of a deeper pass ramps (15°) | c684e5c | The engineers plunge 2 mm (Z-1.75 to Z-3.75; Z2 to Z-2); CAM AI went up to 6.35 mm on the study's part and 8 on two FH plates. |
| Only corner-sized slivers left (no larger than a square corner's, 0.215 r²) | c53c9e8 | The first rule also left strips along walls: 197 mm³ left on the study's part (82 in one strip) where the engineers leave nothing at 0.26 mm. |
| A corner left at the pocket mill's radius only where the model's outline turns sharply (40° or more at one vertex) | dcc1d36 | A corner the model draws with a radius is made with a smaller mill ("unless the drawing asks for less"); sharp corners of any angle (a hexagon's) are left. |
| A drill point only where the material round the hole's middle is solid under it | 68e4465 | Not a cross hole or a cavity under a blind hole. |

The study's part at dcc1d36: 6,841 lines, 31.9 minutes (3 clampings, 40/28/28 mm parallels, nothing cut into the part,
84 mm³ left against the model on a 0.26 mm grid, the engineers' nothing). Of the 31.9 minutes, 10.3 are a Ø3 in the
third clamping cutting 762 mm of path at about 74 mm/min: the vise check slows it, as the part stands 70 mm tall
on its end held 17 mm deep. The engineers hold that clamping 37 mm deep on 8 mm parallels. The holding is the next
lever, not the corners.

## Holding (Phase 8.4, started)

- W1 (the busier face first) tried a third time at 281ae56 on the 24: clampings 35 to 32 (the 10) and 59 to 52 (the
  14), but 198.1 to 250.8 minutes on the 10 (P51d8d6c6 47.9 to 94.0, P8e294283 21.6 to 31.8) and P52e28c09 failing.
  Not kept. It reaches only the library runs anyway: on the CAM AI page the operator picks the first two clampings,
  from the page's best layout (for the study's part, the engineers' face).
- The study's part with the page's default layout: clamping 2's grip is limited to about 1 mm by a strip of stock
  21 x 1.2 mm on the far end face (not the stop's), within 2 mm of the top face, that clamping 1 left; clamping 3's by
  stock 36 mm up. The engineers' clamping 2 never cuts the outline. Next: why clamping 1 leaves it.

## Your review of the study's program (Phase 8.4)

What you saw on the machine, and what changed:

| You | Change | Commit |
|---|---|---|
| The outline is cut whole in the first clamping, 0.5 mm under the part (a 10 high part: 10.5 down); after the turn only facing | The outline goes 0.5 mm under the part (was 0.2); the jaws 1 mm under that, as deep as the stock under the part allows. Where the Z stock is thin, the blank stands 4 mm under the part (0.5 to 2 over it) so that this still holds: 3 mm gripped. Under 4.5 mm of Z stock it cannot (3 mm grip, the outline 0.5 over the jaws): the next clamping cuts the rest, as before. | 6411d59, 328caa9 |
| Outline, then spot drill, then drill, then the inside | The first mill's rings outside the part's outline seen from the top go before the spot drill, top down, as long as nothing over one is left for later; the rest after the drills. Nothing drilled: one operation, no tool change for nothing. | 5e1c47e |
| A hole with a bigger one round it is made in one clamping | A hole whose counterbore opens in the opposite face is drilled from there, with it. | 352f994 |
| A hole through the part is made in one clamping | The far end a drill leaves narrow over a parallel is no longer drilled again from the other side; it is noted for the operator (holeShort: drill it through by hand, the hole guiding the drill). | 352f994 |
| Hold the part deeper when the cuts allow | A later clamping's grip was cut short wherever the part's ends (along the jaws) changed height; only the faces the jaws hold count now. | 6f111a6 |

On the study's part (page default: POM, HAAS-5 tools, blank +4/+4/+7): clamping 1 on 41 mm parallels, the outline to
Z-41.46 (0.5 under the part), then the spot drill and the 7 drills, then the inside. Not fixed: the end pocket is
still cut from two clampings, clamping 2 (Z-) 31 mm deep from the bottom face with the Ø20 and Ø8, then clamping 3
(Y-) 34 mm deep from the end with the Ø8 (about 3,800 mm³ swept by both): one shape made in two setups, which you
named as the cause of offsets (no hole is drilled twice on this part; your manual test's two-sided drilling was not
reproduced here). The engineers cut that pocket in clamping 3 only. Next: give a shape that two clampings reach to
one of them. Clamping 3 (on its end): the grip it may take is now 30 mm on 15 mm parallels (its
deepest cut is 34 of 70; was 3 mm on 42), but the vise check still rejects it: in POM, with one held face touching
the jaw over 17 of its 42 mm (pockets open on it) and the whole 70 mm height taken as the lever, it asks 25 kN where
POM takes 3 kN. So CAM AI still holds that clamping in the nest. The engineers hold it 37 mm deep on 8 mm parallels.
Open question: the vise check's lever (the whole height, also for a deep grip) and its hold along the jaws
(friction only) are cautious; before loosening them, measure them on the engineers' own clampings.

On the 24 (the 10 and the 14, engineers' blanks, at 6f111a6 against the deployed 281ae56): all pass as before
(Pfae5765f still fails, as before). The 10: 35 to 34 clampings, 198.1 to 201.3 minutes, 91,856 to 95,166 lines. The
14: 59 to 57 clampings, 112.5 to 111.4 minutes, 58,521 to 57,757 lines. First clampings now on 42 mm parallels (3 mm
of the 4 under the part) where the blank allows the outline through, later ones deeper where only an end changed
(33/12 to 15/30, 40/5 to 33/12). Holes left narrow at the far end: 14 to 31. Most come from the counterbore rule (a debug
run on the 24): a through hole whose counterbore opens in the face the first clamping does not see was drilled
through in clamping 1, into the stock under the part; now it is drilled from the counterbore's side, with it, and
ends over a parallel: 0.1 to 0.8 mm narrow at the exit (Ø3 to Ø5.5). The rest are far ends the other side used to
finish. Open question: keep the hole with its counterbore and note the narrow exit, let the drill go the shop's full
1 mm into the parallel (0.8 now; it removes most of them for Ø3.5 and smaller), or go back to drilling such holes
through in clamping 1.

No upload of the program and 3D PDF from your manual test arrived in this session; the study's own part stood in.

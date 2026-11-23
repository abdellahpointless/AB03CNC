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
| Minutes | 16.9 | 51.3 | 56.1 |
| Clampings | 3 | 3 (the third in the POM nest) | 3 |
| Parallels / grip (mm) | 40/5, 8/37, 8/37 | 42/3, 40/5, nest on 38 | 40/5, 28/17, 28/17 |
| Tool changes / different tools | 21 / 14 | 35 / 23 | 33 / 21 |
| Moves that change Z while cutting (ramps) | 27 | 16,138 | 6,216 |
| Smallest end mill | Ø4 | Ø1 | Ø1 |

## Where CAM AI's time and lines go

1. **End mills under Ø6 chasing corners.** Today: Ø1 12.0 min, Ø3 4.2 + 9.3, Ø4 2.8, Ø2.5 1.3, Ø5 0.9: 30.5
   of 56.1 minutes and about 9,700 of 14,738 lines, for about 560 mm³ (0.5 % of what is cut). The Ø1 takes
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
cut the outline through, finished it in clamping 2 on 5 mm, and needed the POM nest for the third. With the
engineers' blank it cuts the outline through in clamping 1 but starts from the other face (the one with fewer
features). It leaves for clamping 2 stock beside the part that the first face could not see. The jaws must stay
under that, so the grip is 17 mm. In clamping 3 it goes 51 mm deep into the end (Ø8, Ø3), the engineers 34,
so again 28 mm parallels and 17 mm of grip.

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
| 3 | Drill 3 holes | Ø4 (loaded before the turn) | Side holes / pilots |
| 3 | Side pocket 34 deep | Ø6 SF | The pocket on the end |
| 3 | Narrow parts | Ø4 SF | Finishing in the side pocket |
| 3 | Holes | Ø4.6, centre drill, Ø2.5 | The end's holes |

## Errors found on the way

| # | Error | Effect | Evidence |
|---|---|---|---|
| E1 | The app's model check counts a difference only where a sample and its 6 neighbours all differ: at its grid (about 0.8 mm) anything thinner than about 2 mm is never seen. | "100 % like the model" while 1 mm is wrong. | At 0.24 mm: 98.2 % with cuts of up to 313 mm³ (see E2). |
| E2 | The simulation places the part in a later clamping by a guess from the facing passes, and ignores the program's own height (G52, parallels, nest floor) when the two differ by under 1.5 mm. In the nest clamping it stood the part 1.04 mm too high. | The 3D "Part" view shows every floor of that clamping 1 mm too deep. The program itself is right: placed by its G52, nothing is cut that should stay (0.24 mm grid). | P8bf16da4, clamping 3 |
| E3 | Blind holes are drilled with the tip at the depth where the full diameter should end. | Blind holes are 0.3 x Ø short at full diameter (Ø4.8: 1.4 mm). The engineers add the tip: Z-28.642 against CAM AI's Z-27.2. | P8bf16da4 and today's code |

## Open questions

- The blank: the run on the app had 74 x 46 x 40, the engineers 74 x 46 x 50. How much Z stock does the shop
  keep to grip in the first clamping (here 10)?
- Inside vertical corners: left at the radius of the pocket mill unless the drawing asks for less?
- Hole sizes (3.5 for 3.2, 4.6 for 4.8, Ø6 for 6.3): the shop's sizes for screws in POM, or the PDF's model?
- Straight 2 mm plunges into the next level of an open pocket: POM only, or every material?
- The Ø30 SF's data (1000 rpm, F500): from which material?

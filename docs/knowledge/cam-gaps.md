# CAM AI against the shop's programs: misconceptions and gaps

Phase 4, step 1. CAM AI (`src/lib/cam/`, line numbers as of commit d9714ed) compared with the knowledge base (`docs/knowledge/README.md`,
rule ids in brackets) and, part by part, with the engineers' programs (`npm run cam-library`, which runs
CAM AI on each reference part's 3D model). Each gap: what the shop does, what CAM AI does (file:line at
the time of writing), the change, and how it is checked. Status: **planned**, **done** (with the commit),
**question** (for the shop), **kept** (CAM AI already does it the shop's way).

First comparison, one verified part (`O0161108.X20`, a 304 x 150 x 20 mm plate): the engineers need 4
clampings, 1,364 lines, 16.2 minutes; CAM AI 6 clampings, 14,988 lines, 28.3 minutes. Both programs make
the part (CAM AI's simulation matches the model, nothing collides). The full table per part comes with
the validation run.

## Workholding

| # | The shop | CAM AI now | Change | Status |
|---|---|---|---|---|
| W1 | The first clamping does most of the work: most material removed in 76 of 100 verified two-sided programs, most operations in 86, most holes in 74. | The simpler side first (fewer floors and holes), `program.ts:1062` (`busy(a) <= busy(bSide)`). | Tried on one synthetic test plate (40 x 30 x 12, a pocket with square inside corners and a hole): 8.2 minutes with the busier side first against 4.8, both right. The difference is CAM AI's tool for the square corners (a 1.2 mm end mill for 202 s in one order, 3 and 5 mm ones in the other), not the side order itself, so the plate proves nothing about W1. W1 to W3 tried together on real reference parts: see the validation. | question |
| W2 | The part is gripped 4 to 5 mm on 40 or 41 mm parallels (102 and 31 of 302 clampings); never less than 3 mm (`workholding.grip`, consistent). | The least grip that holds: 3 mm, deeper when its vise check asks (`caleFor`, `program.ts:230`); 38 mm parallels (7 mm grip) on the plate above, where the engineers took 40 and 41. In the second clamping the engineers grip far more (7 to 17 mm on 38, 36, 33 or 28 mm parallels), CAM AI 3 mm. | 5 mm in the first clamping (40 mm parallels); in the later ones as much as leaves 1.5 mm between the jaws and the lowest outside material still to cut. With W1, W3 and W4. | question |
| W3 | Outside cuts stop above the jaw top, mostly 1 to 2 mm above it (`workholding.outsideCutsAboveJaws`, consistent over 208 clampings without a spacer); the contour is finished from the other side. | The outside is cut down to 0.5 mm above the jaws (`jawLimit`, `program.ts:1229`), gripping only the stock under the part, so the whole contour is cut in the first clamping. | 1.5 mm above the jaws; the contour from both sides. With W1, W2 and W4. | question |
| W4 | A clamping on an edge (a quarter turn) never faces (`strategy.noFaceOnEdge`, 68 of 68). | Faces every clamping whose stock stands above Z0 (`program.ts:1139`), the edge clampings too (each of the four on the plate above). | No facing on an edge: needs the sides cut to size before (W3); alone it would leave stock. With W1 to W3. | question |
| W5 | The part is turned over about X more often than about Y (second clamping: X180 in 63 of 100, Y180 in 31). | Whichever of the two the model's frame gave first (`upTurn`, `features.ts:26`): Y180 on the plate above, X180 when the part lies across. | The second side is the first turned 180° about the machine's X, laid along X or across. | done (9d60e24) |
| W6 | Blank minus finished part: 7.5 / 5 / 4.5 mm (median over 91 programs, smallest side first). | [10, 4, 4] when no blank is given (`program.ts:1031`, from `shopKnowledge.json`, learned from 32 programs). | Learn again from the library (see T2). | question |
| W7 | Program zero: 2 mm inside the X-/Y+ corner or the block centre (`workholding.firstZero`, 78 of 97). | The block centre. | none | kept |
| W8 | Spacers in a jaw free a side to be cut below the jaw top (`workholding.spacerFreesSide`). | Not used (CAM AI holds the part directly in the jaws or in its POM nest). | none for now | kept |

**W1 to W3 tried together** (not kept). `npm run cam-library` on six reference parts, one per family, both runs at commit 76ccead. The trial: the busier side first, a 5 mm grip (40 mm parallels) in every clamping or deeper where CAM AI's vise check asks, and outside cuts stopped 1.5 mm above the jaws. Each cell gives clampings, parallels, minutes, then for CAM AI the match with the model and the collisions:

| Program | Engineers | CAM AI | Trial |
|---|---|---|---|
| O0106612.X20 | 2, 40/28, 12.0 | 4, 42/38/38/42, 30.8, 0.995, 2 | 2, 40/40, 17.7, 0.995, 0 |
| O0096794.X20 | 2, 40/28, 11.9 | 2, 41/42, 53.1, 1.000, 0 | 2, 40/38, 34.3, 1.000, 0 |
| O0161424.X20 | 3, 40/40/8, 11.7 | 3, 40/42/42, 87.9, 1.000, 0 | 3, 40/40/40, 83.5, 1.000, 0 |
| O0106624.X20 | 2, 40/38, 4.0 | 2, 42/42, 9.4, 0.995, 0 | 2, 40/40, 9.7, 0.995, 0 |
| O0125595.X20 | 2, 40/36, 14.2 | 3, 41/42/42, 56.1, 1.000, 0 | 4, 40/40/40/40, 89.0, 1.000, 0 |
| O0095457.X20 | 3, 41/41/20, 3.0 | 3, 42/42/38, 4.7, 0.994, 0 | 6, 40/40/42/40/40/42, 9.2, 0.979, 2 |

- **Better on two parts:** O0106612 had 2 clampings like the engineers, and no collision. O0096794 was 35 % faster.
- **About the same on two parts.**
- **Worse on two parts:** more clampings, on edges. On O0095457 there were also two collisions and a match under 0.99.
- **Why, likely:** on the two worse parts the engineers finish in their last clamping on 36 and 20 mm parallels (a grip of 9 and 25 mm). The trial kept 40 mm there and needed edge clampings instead.
- **What is missing:** how much to grip in the later clampings. The package needs that rule before it can replace CAM AI's way.

## Strategy

| # | The shop | CAM AI now | Change | Status |
|---|---|---|---|---|
| S1 | Order in a clamping: face, spot drill, drill, tap, then pockets, contours, finishing, counterbores, chamfers last (`strategy.order`, 239 of 284 clampings). | Face, holes, milling, finishing, chamfers (`program.ts`, steps 1 to 4). | none | kept |
| S2 | Holes under 4 mm are spot drilled, from 4 mm up they are not (`strategy.spotSmallDrills`, 1,572 of 1,636 holes). | Every new hole was spot drilled (`drilling`, `program.ts:405`). | Spot drill under 4 mm only. | done (9db167b) |
| S3 | Drilling with G83 and a peck always, spot drilling with G81 (`strategy.drillG83`, 2,716 of 2,716); R plane 2 mm above the faced top. | The same. | none | kept |
| S4 | Finishing leaves 0.2 mm on walls and floors to the roughing, or nothing (measured on 104 passes; `README`, Roughing and finishing). Most parts with pockets or contours have a finishing pass (`strategy.roughThenFinish`, 94 of 105 clampings). | 0.15 mm (`ALLOW`, `program.ts:478`), and finishing passes only for top plates, contour inserts and seal cages (`PRECISE`, `program.ts:482`). | Tried 0.2: CAM AI's sliver rule (0.3 mm, twice 0.15) is tuned to 0.15, and with 0.2 a top plate's wall was finished at every roughing level (4 entries instead of 1). Kept at 0.15, 0.05 mm under the shop. Whether every part gets a finishing pass: question. | kept (0.15), question (every part) |
| S5 | Chamfers and deburring (FASE, ENTGRATEN) close most clampings (210 of 225 chamfering clampings end with them); the 90° graver runs along the edges. | Chamfers only where the model has one (`program.ts:1360`); none on the plate above, where the engineers chamfer with two gravers. | Deburr every edge like the engineers? | question |
| S6 | Tapped holes: spot, core drill, tap G84 in the same clamping; core drill M3 Ø2.5, M5 Ø4.2 (`strategy.drillBeforeTap`). | No tapping (a thread is a plain hole in the model). | none (needs the thread from the drawing) | kept |

## Tools and cutting data

| # | The shop | CAM AI now | Change | Status |
|---|---|---|---|---|
| T1 | Cutting data per material, tool and Ø: `README`, cutting table (216 rows). | The shop's templates (`library.json`) within what the tool takes (`physics.ts`). Compared for every template tool with the shop's programs (most common value over all 108; 257 tool and kind pairs with data from 2 parts or more): the rpm is within 5 % in 190 (POM: 85 of 102); where both give a feed, CAM AI's is within 80 to 125 % of the shop's in 79, lower in 39, higher in 34. The shop's feed there is the median over an operation's cutting lines, corner slowdowns included (the post runs corners at 63 to 70 %), so it sits under the programmed feed; the comparison leans that way. | none for the data themselves | kept |
| T1a | ALU small tools run fast: SF 1 and 2 at 27,000 rpm, SF 3 at 21,000, SF 4 at 16,000, SFH 16 at 20,000. | Capped at 12,000 rpm when the machine has no limit set (`DEFAULT_LIMITS`, `limits.ts`), the feed down with it (SF 1: 270 against 700 mm/min on the first reference parts). | Set each machine's top rpm in Admin > Machines. No code change. | question |
| T4 | Outside roughing. In aluminium and PC GF the shop roughs the outside with the high-feed SFH 16 at 20,000 rpm and 3,000 mm/min, about 2.6 mm deep and 7.6 mm wide (`README`, cutting table: 47 contour operations on 33 aluminium parts, 4 on 3 PC GF parts). The plain SF 16 then finishes the walls at 6,600 rpm and 1,200 mm/min (41 operations on 29 aluminium parts); it roughs a pocket once in the library. | Every level is roughed with the largest end mill first, of one Ø the shortest that reaches (`tools.ts:163`, `program.ts:1282`): the SF 16 (48 mm) before the SFH 16 (55 mm), from the shop's pocket template (a full slot first): 6,600 rpm, 850 mm/min, ramping in at 430. On the 19 reference parts the end mills over Ø12 run CAM AI 307 minutes, the engineers 51. | Rough with the SFH 16 where the shop does (the aluminium family's outside), from its contour data. It needs T1a: at 12,000 rpm the SFH 16 runs 1,800 mm/min instead of 3,000. It also needs W2: the engineers grip 4 to 5 mm to take 3,000 mm/min, and CAM AI's vise physics decides what its own grip holds. | question |
| T5 | Small and middle end mills. In aluminium and PC GF the Ø1 to 4 mills run at 16,000 to 27,000 rpm and 600 to 1,200 mm/min (`README`, cutting table), only where a larger tool cannot reach. | At most 12,000 rpm (T1a) and 160 to 570 mm/min. On the 19 reference parts the end mills up to Ø4 run CAM AI 568 minutes, the engineers 62; Ø5 to 12, 303 against 50. Four parts (five programs) make three quarters of CAM AI's extra time. The rpm cap is a part of it: at 27,000 rpm, on five aluminium and PC GF parts, the small mills' minutes drop by a third (16.7 to 11.2) and the whole programs' by 12 % (59.7 to 52.5; the engineers 30.6). The rest is where CAM AI cuts with them: every corner the model has, with the tool that fits it. | First T1a, then look at where the small mills cut, part by part (`npm run cam-library` gives the minutes per tool). | question |
| T3 | Materials without tool codes of their own are cut with another material's data: PC GF with aluminium's (ALHS), brass (MS) with aluminium's, EPO with FH's, PETP with POM's (KS), and the one PEEK part with aluminium's (`README`, Tools and cutting data). | The family table (`tools.ts:24`): PC GF, MS -> ALU and EPO -> FH, as the shop; PEEK -> POM. | PEEK with the aluminium data? One part only: thin evidence. | question |
| T2 | The learning reader now reads every operation (MIT WERKZEUG, copy-numbered tools, NC-ANBOHREN). | `shopKnowledge.json` was learned from 32 programs before those fixes. | `npm run learn-shop` on the whole library. It puts more of the shop's cutting data in the repository, which is public. | question |

## G-code style

| # | The shop | CAM AI now | Change | Status |
|---|---|---|---|---|
| G1 | A straight move writes only the axes that change (`gcode.onlyChangedAxes`, 91 of 92 parts), the feed only when it changes (`gcode.feedOnlyWhenChanged`), numbers without a leading zero (`gcode.shortNumbers`). | Every word on every line: on the plate above 12,101 of 40,082 moves repeat an axis, 2,277 of 7,383 feeds repeat, 1,844 numbers have a leading zero. | `style.ts`: the same moves in the shop's words, taken only when the app reads exactly the same moves, spindle, tool, offset and M words and clamping shifts from it. | done (9c730d5, 34cca39; review fixes f768a2a, 6404b0f) |
| G2 | Drilling: one cycle per depth, each further hole only its new X or Y, G80 when the depth changes. | Every hole its own full cycle line (X Y Z R Q F). | `style.ts` (as G1). | done (9c730d5; review fix 58db0c0) |
| G3 | Arcs as G02/G03 with I and J (145,625 arc lines; contours 86,152 arcs and 125,150 lines). | Never an arc: a circle is many short G01 lines (0.35 mm apart on the plate above), most of CAM AI's lines. | `style.ts`: runs of straight moves on a circle written as G02/G03 with I and J, every point within 0.003 mm of the arc and every old piece within 0.012 mm of the arc as written (I and J rounded, at its start and end radius; CAM AI's own offsets leave 0.002 to 0.01 mm); taken only when the simulation check of the arc program is no worse in anything (match never from a pass to below 0.99). | done (5fe1b84, 34cca39; review fix 1101407) |
| G4 | HAAS programs end with `G0 G53 G49 Y0 Z0 M89` (64 of 65): table out, offset cancelled, through-spindle coolant off. | `M09`, `G53 Y0`, `M30`. | The shop's end line and the machining time comment (`program.ts:1554`). Download (the program's and each nest's) applies the machine rules Send and Process apply in the remapper (`forMachine`, `src/lib/cam/export.ts`): the converter drops M89 for the Robodrills; FANUC-2 runs HAAS code, keeps M89 and gets its own rules (G49 on each tool change, at most S5000, 2 mm pecks in aluminium and brass, N up to 9999). `tests/camExport.test.ts` compares both ways machine by machine. Two differences remain, both on the Send side: Process picks the tools again from the machine's inventory and its rules (HAAS-1's T2 and T21 for the Ø16 mills), where Download keeps the tools CAM AI planned and simulated (question: which shall CAM AI follow?); and the remapper reads the material from the program's text, so a model named after another material ("POM-PLATE ALU") gets that material's peck rules on Send. Download takes the material CAM AI cut. The model check in CAM AI's viewer offers no Copy or Download of the program. | done (d9714ed; review fixes bb48e33, 0ebd474, 1d37547, 5d65543, 4086eb0) |
| G5 | Safety line, `G00 G43 H.. Z50. M08`, the spindle start on the first move, `(TOOLPATH ...)` names, tool comments, N numbers. | The same. | none | kept |

## Improvements beyond the engineers (for your approval; none applied)

These keep the same moves and the same result and only shorten the program. Each is listed so you can
approve or reject it.

| # | What | Why it is safe | Gain |
|---|---|---|---|
| O1 | A move to where the tool already is is left out (for example `G00 Z4.5` right after `G00 Z4.5`). The engineers' programs keep such lines. | The tool does not move; the app reads the same moves (`style.ts` proves it). | A line each. Ready (`shorten(code, true)`), off until you approve it. |

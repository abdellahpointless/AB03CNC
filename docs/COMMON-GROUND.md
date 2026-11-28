# Project Common Ground

**Project:** CNC Process Pro
**Created:** 2026-11-25T17:00:00Z
**Last Updated:** 2026-11-27T17:40:00Z

---

## ESTABLISHED

High confidence assumptions. Treat as premises.

### A001: Parallels at their own height

- **Type:** stated
- **Assumption:** Every parallel is drawn and checked at exactly its nominal height; the part rests where it physically would (on the parallels, on the jaw tops by a flange, or on the table) and its hitbox is checked.
- **Source:** Owner, item 1 (38 mm parallel drawn above the 45 mm jaws)
- **Validated:** 2026-11-25
- **Context:** CAM AI clampings and simulation

### A002: Shape after each operation

- **Type:** stated
- **Assumption:** The part's outer envelope (holes filled) after every operation is shown per operation and is the hitbox the jaws, parallels and stop touch in the clamping checks.
- **Source:** Owner, item 2; answer: show it and use as hitbox
- **Validated:** 2026-11-25
- **Context:** CAM AI planning and checks

### A003: Adjust per clamping

- **Type:** stated
- **Assumption:** Each clamping has an Adjust toggle with explicit settings: parallels height, Y-, Y+ and X- spacers, side up and turn, previewed live in 3D; the scroll-wheel editing goes.
- **Source:** Owner, items 3, 8, 12; confirmed
- **Validated:** 2026-11-25
- **Context:** CAM AI clamping editor

### A004: One tool at a time

- **Type:** stated
- **Assumption:** Picking a tool (list, or its path in 3D, highlighted on hover) shows only its path; its row then shows Play (only that tool), Settings and Delete (confirmation; removes its toolpath and tool change).
- **Source:** Owner, items 4, 5, 10, 11; confirmed
- **Validated:** 2026-11-25
- **Context:** CAM AI tool list and simulation

### A005: Free tool swap

- **Type:** stated
- **Assumption:** Any machine, database or typed tool can replace another; a shape difference only warns; export is blocked only by holder or jaw hits, with CAM AI's choice offered.
- **Source:** Owner, item 6; confirmed
- **Validated:** 2026-11-25
- **Context:** CAM AI tool edits

### A006: Make again / Undo

- **Type:** stated
- **Assumption:** After any change a small bar offers Make again and Undo.
- **Source:** Owner, item 7; confirmed
- **Validated:** 2026-11-25
- **Context:** CAM AI edits

### A007: No 2D view in CAM AI

- **Type:** stated
- **Assumption:** CAM AI's simulation has no 2D view; the remapper's viewer keeps its own.
- **Source:** Owner, item 9; confirmed
- **Validated:** 2026-11-25
- **Context:** CAM AI simulation

### A008: Tool database fields

- **Type:** stated
- **Assumption:** Each tool has an editable type, a role (roughing, finishing or both) and an on/off switch; a program remembers the database tools it used and asks to be made again when one changed.
- **Source:** Owner, item 14; confirmed
- **Validated:** 2026-11-25
- **Context:** Tool database

### A009: Tool choice order

- **Type:** stated
- **Assumption:** Machine tools first, then the database; with neither, the nearest tool, its operation flagged temporary; export stays allowed with a warning.
- **Source:** Owner, item 15; answer: allow with a warning
- **Validated:** 2026-11-25
- **Context:** CAM AI planner

### A010: Import shows the part

- **Type:** stated
- **Assumption:** The import dialog shows the 3D part beside the choices.
- **Source:** Owner, item 16; confirmed
- **Validated:** 2026-11-25
- **Context:** CAM AI new program

### A011: Measure to the vise

- **Type:** stated
- **Assumption:** Measuring snaps to the vise bed and the jaw faces as planes.
- **Source:** Owner, item 17; confirmed
- **Validated:** 2026-11-25
- **Context:** CAM AI measuring

### A012: The shop vise

- **Type:** stated
- **Assumption:** Haas HMV-6F: jaws 125 mm long and 45 mm high, checked from the stop face (X = 0) along those 125 mm only; stop 8 mm thick before them.
- **Source:** Owner, earlier in the session
- **Validated:** 2026-11-25
- **Context:** All checks and 3D views

### A014: Deploy rule

- **Type:** stated
- **Assumption:** Nothing is deployed unless the owner says deploy.
- **Source:** CLAUDE.md standing rule
- **Validated:** 2026-11-25
- **Context:** Every change

### A015: The 0.5 mm method, always

- **Type:** stated
- **Assumption:** Clamping 1 cuts the outline and the through holes whole, 0.5 mm under the part (drills at full diameter 0.5 mm past the bottom); after the turn only the face mill takes the rest, plus what only that side reaches. Extra clampings stay for side features. Under that cut a gap down to the jaw tops: 1 mm by default, 1 to 1.5 mm in CAM AI's settings (it was 0.5); the tools keep it over the jaws.
- **Source:** Owner, 2026-11-26; the gap 2026-11-27
- **Validated:** 2026-11-27
- **Context:** Every CAM AI program

### A016: Clamping 1 grip

- **Type:** stated
- **Assumption:** The jaws grip the stock under the gap (A015): 5 mm wanted (6.5 mm of stock under the part with the 1 mm gap), the designer may go down to 3 mm (4.5 under the part), shown yellow with a warning; less is refused and a thicker Z blank asked for. Never under 3 mm.
- **Source:** Owner, 2026-11-26 (answered: the 3-4 mm is the jaws' grip); 5 mm wanted, 2026-11-27 ("5 wanted, down to 3 with a warning")
- **Validated:** 2026-11-27
- **Context:** Blank placement, clamp panel, planner

### A017: Counterbore on the other face

- **Type:** stated
- **Assumption:** A through hole whose counterbore opens on the second clamping's face is still made with it, from that side (the earlier rule wins over drilling it in clamping 1).
- **Source:** Owner, 2026-11-26
- **Validated:** 2026-11-26
- **Context:** Hole drilling

### A018: Busiest face first

- **Type:** stated
- **Assumption:** Clamping 1 is the face with the most pockets and holes; after the turn only the face mill, plus anything only that side reaches.
- **Source:** Owner, 2026-11-26
- **Validated:** 2026-11-26
- **Context:** Clamping order

### A019: Blind holes at drawn depth

- **Type:** stated
- **Assumption:** Only holes through the part get the extra 0.5 mm; blind holes keep the depth on the model.
- **Source:** Owner, 2026-11-26
- **Validated:** 2026-11-26
- **Context:** Hole drilling

### A020: Test and deploy rhythm

- **Type:** stated
- **Assumption:** Test on a few parts, not big runs; deploy after a few tests, run the rest in the background, then push again for the final deploy.
- **Source:** Owner, 2026-11-26
- **Validated:** 2026-11-26
- **Context:** Every change

### A021: Always 0.5 mm to face on top

- **Type:** stated
- **Assumption:** Clamping 1 always faces the top: at least 0.5 mm over the part (but on a white face), so the blank needs 5 mm of extra Z at the least with the 1 mm gap (0.5 over, 4.5 under; 7 mm for the 5 mm grip); less is refused like a thinner blank.
- **Source:** Owner, 2026-11-26 (a 4 mm blank left the top raw on a test part)
- **Validated:** 2026-11-27
- **Context:** Blank placement, stock panel, planner

### A022: Coolant by machine

- **Type:** stated
- **Assumption:** The coolant is the machine's, the same on every tool and never asked per tool: HAAS-1, HAAS-5, FANUC-1 and FANUC-2 coolant (M08); HAAS-2 and HAAS-4 air (the Moroccan standard).
- **Source:** Owner, 2026-11-26
- **Validated:** 2026-11-26
- **Context:** Post, tool panel, download

### A023: A drilled hole is not milled again

- **Type:** stated
- **Assumption:** No end mill goes into a hole a drill made at its Ø: not to mill it again, not to make its bottom flush (and never to clean a drill's point under the part). A counterbore (a hole with a smaller one going on from its floor) is made by an end mill after the smaller hole is drilled, never by a drill of its Ø. Where the drill did not make the material (a hole going on past where the drill could reach, a through hole's end over a parallel inside the part), the mill still cuts it. A blind hole whose whole disc stays open in the model under where the app's reader ended it (a cross hole or a drawn thread splits it) is drilled on as one hole: through the part when it is open to its bottom, else to where the model closes (its drawn point kept).
- **Source:** Owner, 2026-11-26 (the rule); where the reader ends a hole is the app's (library parts Pf2990f37, P242c06c0, P16bf7182, P5295c45b)
- **Validated:** 2026-11-26
- **Context:** Planner (holes), library runs s44 (93 end mill entries into drilled holes), s45 (55), s47 (14)

### A024: Operations in the operator's order

- **Type:** stated
- **Assumption:** A clamping's tools can be dragged into any order (also Alt + arrows, or the up and down buttons); the program is checked again. The locks on some orders are A027 (CAM AI's, not stated).
- **Source:** Owner, 2026-11-26
- **Validated:** 2026-11-26
- **Context:** Tool list, editProgram

### A025: The part turned by quarter turns

- **Type:** stated
- **Assumption:** Each OP's settings (the button on its tab) turn the part +90 or -90 about the machine's X or Y; the presses add up, a green figure of the uploaded model shows it, and Make again plans that clamping lying exactly so (any of the 24 ways; the operator's turn notes follow). They replace the flip and quarter controls of later clampings.
- **Source:** Owner, 2026-11-26
- **Validated:** 2026-11-26
- **Context:** OP settings, planner frames

### A026: Resting on a step

- **Type:** stated
- **Assumption:** A part is not laid unstably on a narrow lower step when a wider, higher step can rest on taller parallels; the operator can type the thickness where the parallels touch the part, and the part sits on the parallels at that thickness, as the engineers write it ("41 MM UNTERLAGE IN EP 4.5 MM"). How CAM AI chooses by itself is A028.
- **Source:** Owner, 2026-11-26 (with a picture of the uploaded part); the notation from the library (about 30 "UNTERLAGE IN EP" notes)
- **Validated:** 2026-11-26
- **Context:** Planner (later clampings), clamp panel

### A029: A tool changed by hand is the operator's call

- **Type:** stated
- **Assumption:** A tool changed by hand to another Ø may leave the part bigger, so the vise holds it off where a later clamping's zero assumes. That no longer locks the program: the operator's tick ("I accept this part as it is") accepts it, and the text says to check that zero at the machine. Anything that hits the machine or the vise is never accepted.
- **Source:** Owner, 2026-11-27 ("if the user changed the tool to what they want then they know why")
- **Validated:** 2026-11-27
- **Context:** Accept tick, Download

### A030: Holes and tool starts for the VF-4

- **Type:** stated
- **Assumption:** Holes: R 0.5 mm over where the material over the hole starts (under the faced top, plus half a layer of the grid that knows what earlier clampings left); G81 up to 1 x D deep, G73 up to 3 x D in short-chip materials (ALU, MS, FH, EPO, RESOPAL), G83 deeper or in the plastics; Q from the shop's data; the holes of one tool in nearest-neighbour order; G98, G99 only where the stock proves the way between two holes at R clear; a note per hole saying the choice and why. A hole a little wider than its mill: arcs (a helix one G02/G03 a turn, one circle a level). Every tool starts G00 G17 G21 G40 G80 G90, then its first point with S and M03, then G43 H and the coolant; T and H within 1-200 (a tool the machine lacks takes a free number; on a Haas, Download refuses anything else; a FANUC keeps its own pointeur numbers). `holes: { legacy: true }` writes the old output.
- **Source:** Owner, 2026-11-27 (the hole rules from another review, "implement it in its logic"); which materials count as short-chip is CAM AI's reading
- **Validated:** 2026-11-27
- **Context:** Planner (drilling, milling), post, Download

### A031: Parallels 5 mm wide

- **Type:** stated
- **Assumption:** The shop's parallels are 5 mm wide (narrower under a narrow part, its held width / 6, as before).
- **Source:** Owner, 2026-11-27 (Q009)
- **Validated:** 2026-11-27
- **Context:** Simulation, planner

---

### A032: Türkiye tool database: server only, no cutting data

- **Type:** stated
- **Assumption:** Türkiye's tool database lives only in Türkiye's database, never in the public code: per tool its code, type, Ø, length, radius or angle, flutes, materials and description. The rpm, feeds, step-down and NX file names of the shop's list stay out. Only admins change it (re-importing the list in the app); users only read it.
- **Source:** Owner, 2026-11-27 (Türkiye tool database request)
- **Validated:** 2026-11-27
- **Context:** Türkiye tool inventory

---

### A033: Reamers and countersinks

- **Type:** stated
- **Assumption:** A reamer (RA) is its own type, which the remapper never puts in for a drill call; a 90° countersink (KS) counts as a chamfer tool. SR is a roughing mill, AB with a 118° point a drill, AB 90° a spot drill.
- **Source:** Owner, 2026-11-27 (Türkiye tool database request)
- **Validated:** 2026-11-27
- **Context:** Türkiye tool inventory

---

### A034: Adding tools in Türkiye

- **Type:** stated
- **Assumption:** Türkiye's users add a tool to a machine only from the database: Add new tool opens the next slot (the last slot + 1, or 1), then dropdowns (type, Ø, length, material, ...) narrow each other in any order until one tool is left. Admins can still type a tool the list lacks. The remapper's Add tool (a tool the program needs) picks from the database too, narrowed to the program's Ø. Morocco is unchanged.
- **Source:** Owner, 2026-11-27 (Türkiye tool database request)
- **Validated:** 2026-11-27
- **Context:** Türkiye tool inventory

---

### A035: Türkiye's machines

- **Type:** stated
- **Assumption:** Türkiye has 17 machines (layout v2): ASB Haas K (50 slots, the probe not counted), Haas M, G, E, F, H (41), Fanuc P, A, C, O, D, B (21); OSB Haas 1, Haas 2 (41), Fanuc 1, 2, 3 (21). The live HAAS F goes from 32 to 41 slots and keeps its tools; the 16 others are added. Done on the owner's deploy.
- **Source:** Owner, 2026-11-27 (Türkiye tool database request)
- **Validated:** 2026-11-27
- **Context:** Türkiye tool inventory

---

### A036: The drill for a hole

- **Type:** stated
- **Assumption:** A hole is drilled with a drill of its own Ø (within 0.015 mm: a drawn Ø2 can read Ø2.01 from the model's facets). Failing that, the nearest smaller drill down to 0.05 mm under it (a Ø2.95 for a Ø3), or a bigger one up to 0.12 mm over it as the engineers drill (Ø3.2 holes with Ø3.3; for now, the owner: there is a limit to it), and that drill's tool says in yellow both sizes, the drill's and the drawing's. Never a smaller drill and then a mill to bring the hole to size: a hole is milled only when no drill comes that close. Drilling stays first, before the milling (the order rule).
- **Source:** Owner, 2026-11-27 (an answer on the hole order; then 0.05 under and 0.12 over, Q021 and Q022)
- **Validated:** 2026-11-27
- **Context:** Hole drilling

---

### A037: Peck depth in the plastics

- **Type:** stated
- **Assumption:** G83 pecks 4 mm in POM, PEEK and PC GF30, at most 4 x the drill's Ø (a Ø0.5 pecks 2), or the engineers' own peck where it is deeper. Aluminium, brass and the laminates (FH, EPO, RESOPAL) keep the engineers' pecks.
- **Source:** Owner, 2026-11-27 (from an engineer's program: two Ø1 holes with Q4 in POM)
- **Validated:** 2026-11-27
- **Context:** Hole drilling

### A038: A tool's work in another clamping

- **Type:** stated
- **Assumption:** The operator can move a tool's work from one clamping to another (OP10 to OP20 or any other); CAM AI makes it there in that clamping's own order. Done for drills first: the drill's holes (and their spot drilling) go to the clamping asked when it reaches the same holes from its side, else a note says so and they stay. Milling tools wait for the shape recognition (each tool's shapes known), so that a moved mill takes exactly its shapes.
- **Source:** Owner, 2026-11-27
- **Validated:** 2026-11-27
- **Context:** Tool list, planner (CamInput.moves)

---

### A039: A quarter turn about Z

- **Type:** stated
- **Assumption:** Each clamping can be turned +90 or -90 about the machine's Z in its settings (the same side up, turned in the vise), as about X and Y.
- **Source:** Owner, 2026-11-27
- **Validated:** 2026-11-27
- **Context:** Clamping settings

---

### A040: Parts come as STEP files

- **Type:** stated
- **Assumption:** The users always give CAM AI the part as a STEP file, never a PDF (a PDF's 3D model is too coarse). CAM AI's shape reading builds on the STEP file's exact faces: each face a plane, a cylinder or a cone, with its axis, radius and angle (step 1 of the shape engine: holes taken from the exact cylinders, to the micron).
- **Source:** Owner, 2026-11-27
- **Validated:** 2026-11-27
- **Context:** Model upload, shape reading (src/lib/cam/faces.ts)

---

### A041: Later clampings grip under the stock they still cut

- **Type:** stated
- **Assumption:** The jaws of a later clamping stay 1 mm under the stock it still cuts beside the faces they hold (measured from those faces, where the jaws stand along X), as deep as that allows (the shop's deep grip). Where 3 mm cannot stay under it (a pocket opening onto the held face down its height), as before: the wall the jaws leave is noted. A through hole that comes out beside the held faces keeps the jaw tops 1 mm under the drill's point, else that grip is refused (drillAtJaws).
- **Source:** Owner, 2026-11-27
- **Validated:** 2026-11-27
- **Context:** Grip choice in later clampings (deepest, vise retry)

---

### A042: Turn about Z off a broken face

- **Type:** stated
- **Assumption:** A face a counterbore broke into teeth is no face to grip: the clamping after the first turns a quarter about Z when the jaws then touch more of the part (never against a turn the operator set), never to close across a thin wall under a wider body (a 2 mm fin under a 40 mm base). The jaws' contact is judged against the stock's length along them.
- **Source:** Owner, 2026-11-27
- **Validated:** 2026-11-27
- **Context:** Later clampings, physics (jawContact)

---

### A043: No good holding: error and another first side

- **Type:** stated
- **Assumption:** When a clamping has no good way of holding the part with the side the operator put up first (only the POM nest, or the vise does not hold it), the program is blocked with an error and CAM AI suggests the first side that holds every clamping in the vise (the opposite one tried first); one click lays the part so.
- **Source:** Owner, 2026-11-27
- **Validated:** 2026-11-27
- **Context:** Result verdict (holdOther)

---

### A044: Flat slopes: ball end mill from the top

- **Type:** stated
- **Assumption:** A flat slope a clamping sees from above is cut there with a ball end mill (HAAS-1: the Ø6 one, T37), roughed down to it and finished to a fine scallop, never by a clamping on the side cutting it as a wall.
- **Source:** Owner, 2026-11-27
- **Validated:** 2026-11-27
- **Context:** Planner (slopes.ts)

### A045: Shapes found every time, overlaps too

- **Type:** stated
- **Assumption:** From a STEP model the shape engine finds every shape, each once, with its sizes and the sides it is reached from, also where shapes run into each other; what no shape explains is named, never cleaned up. Holes (through, blind with a point or flat, counterbores, countersinks of any angle), pockets, slots, steps, notches, windows, outlines, bosses, undercuts, chamfers, rounds, fillets and slopes.
- **Source:** Owner, 2026-11-27 ("perfectly detected every time, even if a shape intersects with the other")
- **Validated:** 2026-11-27
- **Context:** Shape engine (recognize.ts), step 2

---

## WORKING

Medium confidence. Use but flag if contradicted.

### A046: How shapes that meet are told apart

- **Type:** inferred
- **Assumption:** A shape is its surfaces (a hole cut in pieces by a slot is one hole; a hole another runs into stays a hole, "open" if its wall never closes). Shapes at one depth that run into each other are one pocket, but slots (and keyways open at one end) and holes stay themselves. A deeper shape's room is its own up to the top; its depth runs from the top of the walls round it (a pocket in another: from that one's floor). A shape seen from several sides is one; a side's partial view of others is theirs. "From": the sides a straight tool along that axis cuts all of it from; a T-slot's hidden wings are undercuts reached through its neck; a hole at an angle has none.
- **Source:** CAM AI, written down with the 23 test parts (tools/test-part/make_feature_parts.py) before step 3 uses it
- **Validated:** 2026-11-28
- **Context:** Shape engine (recognize.ts); the owner may want other names or splits (a T-slot open at its ends is one profile from its ends today)

### A027: Orders that lock

- **Type:** inferred
- **Assumption:** One row per tool; a dragged tool's operations move together, every other operation keeps its place (a tool used in two places stays in both; the order is kept by operation, so a tool changed by hand keeps its place). An order no check covers stays locked and says why: anything before the facing, a drill before its spot drill, a mill before the one whose material it was made for (the simulation does not see a tool cutting more than it was made for), a mill before a drill whose holes it goes into.
- **Source:** CAM AI (the checks it has); Q012 asks the owner
- **Validated:** 2026-11-26
- **Context:** Tool list, editProgram

### A028: Resting on a step by itself

- **Type:** stated (2026-11-27: Q010 "it normally should", Q013 "yes")
- **Assumption:** Not typed, CAM AI rests a later clamping on the deepest step that fits and holds; it turns it a quarter about Z when the parallels only fit beside the body that way, also on a side of the face pair the operator picked (its turn note says so), never on a clamping the operator turned by hand. Taller parallels then, the jaws on the step's faces 1.3 mm or more under Z0, the body 5 mm or more over the vise floor, each parallel 0.5 mm clear of the body and bearing on the step over 85 % of its length.
- **Source:** CAM AI, from the owner's picture and about 30 "UNTERLAGE IN EP" notes in the library (which do not say when); Q009, Q010 and Q013 ask the owner
- **Validated:** 2026-11-26
- **Context:** Planner (later clampings)

### A013: CAM AI scope

- **Type:** inferred
- **Assumption:** These 17 items change CAM AI only; the remapper's toolpath viewer stays as it is unless asked.
- **Source:** Wording of the request (CAM AI screens)
- **Validated:** 2026-11-25
- **Context:** All items

---

## OPEN

Low confidence. Ask before assuming.

Set aside by the owner: Q004 (Pfae5765f's turned part, ignored for now).

(none open from batch 10: Q008-Q013 answered on 2026-11-27, see the history)

### Q014: The tool start's order

- **Type:** uncertain
- **Question:** The hole spec starts each tool with the safe modal line, then the first point with S and M03, then G43 H and the coolant; the engineers' programs put G43 H first. CAM AI follows the spec (before the length it moves only in X and Y). Keep the spec's order, or the engineers'?
- **Source:** The other agent's hole spec against the library's programs

### Q015: Short-chip materials

- **Type:** uncertain
- **Question:** G73 (chip-breaking pecks) is used up to 3 x D only in ALU, MS, FH, EPO and RESOPAL; every other material gets G83 from 1 x D. The list is CAM AI's reading, not the shop's. Which materials break their chips?
- **Source:** The hole spec ("chip-friendly" without a list)

### Q016: An end mill plunged for a counterbore

- **Type:** uncertain
- **Question:** The engineers' most common counterbore (112 of 260) is an end mill of the big Ø plunged in G83 with a dwell. CAM AI ramps end mills (the shop's rule) and goes round with a smaller one. Offer the plunge as an option?
- **Source:** Library research on counterbores (Q008)

### Q017: Air off on the air machines

- **Type:** uncertain
- **Question:** On HAAS-2 and HAAS-4 the remapper adds M83 (air) at every tool and nothing turns it off before the program ends (H3-14). Add M84 at the end?
- **Source:** Night bug hunt, finding H3-14

### Q018: Program numbers

- **Type:** uncertain
- **Question:** Every CAM AI program is O0001 (H6-7). The saved fix takes the number from the model's name when it is one; the same number as the shop's own program could overwrite it on the control. Where should the number come from?
- **Source:** Night bug hunt, finding H6-7

### Q019: Kale or paralel in Turkish

- **Type:** uncertain
- **Question:** The Turkish screens call the parallels kale in some places and paralel in others (H4-10, H5-7). Which word does the shop use?
- **Source:** Night bug hunt

---

## History

- 2026-11-25: created, 14 assumptions from the owner's 17-item CAM AI request.
- 2026-11-25: three open questions from the work on items 1 and 3 (Q001-Q003).
- 2026-11-25: answered by the owner and done: Q001 jaw blocks flush with the plates at 45 mm (drawn so); Q002 a Y+
  spacer only in very special cases, kept as an extra option (moves that clamping's G52 Y); Q003 20 and 50 mm moving-jaw
  spacers offered as well as 15.
- 2026-11-25: Q004 from the library's one failing program.
- 2026-11-26: Q005-Q007 from the final review (Y+ zero, stand-in drill bound, vise opening).
- 2026-11-26: answered by the owner. Q004 ignored for now (the library's one failure stays). Q005: the Y+ spacer is not
  used for now (hidden on the page; the planner keeps it). Q006: 80 % is right; the designer can take the stand-in's
  operation down by hand (checked again, locked past the drill's length). Q007: the vise opens to 300 mm.
- 2026-11-26: the 0.5 mm method (A015-A020), answered by the owner. Measured first on the 24 parts: the outline was
  already cut whole in clamping 1 on all 16 blanks with 4.5 mm or more of Z stock (18 of 24 in all; measured as
  clamping 1's deepest milling, which also counts openings inside the part); 6 of the 8 thinner blanks fell short. The table (no parallels) and parallels gripping the part's own walls are no longer offered for
  clamping 1; they stay for later clampings. A deploy now also follows A020 (the owner said deploy that way).
- 2026-11-26: A021 from the owner: always 0.5 mm over the part to face (4.5 mm of extra Z at the least).
- 2026-11-26: batch 10 from the owner (A022-A026); open questions Q008-Q012 from the work on it.
- 2026-11-26: review of batch 10's log: A024 and A026 kept to what the owner stated; CAM AI's own choices split off as
  A027 (inferred) and A028 (assumed), with Q013. The step rest's parallels and G52 Z rest on A028: settle Q009, Q010
  and Q013 before a deploy. A023 now also covers a blind hole the reader ended early (library run s47).
- 2026-11-26: an independent review of batch 10: a drag no longer pulls together a tool used in two places (A027).

- 2026-11-27: the owner's answers. Q008: a counterbore is two holes on one axis, the big one shallower; through, the small
  one is a drill and the big one an end mill (or a drill then an end mill). The library (91 programs, 260 counterbores):
  an end mill made the big Ø in 242, after the small hole was drilled in nearly all (spot, small drill, end mill), as
  CAM AI does; 112 by an end mill of the big Ø plunged in G83, 79 by a smaller one going round (CAM AI's way); 33 a pilot
  drill first; 18 a drill alone. Q009: 5 mm parallels (A031); the 85 % is how much of each parallel's length must touch
  the step (holes and rounded ends leave gaps). Q010 and Q013: yes (A028 stated). Q011: read rightly. Q012: no more
  locks for now. A029 and A030 new; A020's rhythm kept.
- 2026-11-27: open questions Q014-Q020 from the hole rules, the library run and the night's bug hunt.
- 2026-11-27: A030 refined after review: R under the faced top adds half a grid layer; the 1-200 Download lock is for Haas machines only.
- 2026-11-27: Q020 archived: it came from R 0.5 sitting within a grid layer of a floor CAM AI knows only to that layer; with half a layer added there (A030), P51d8d6c6 plans as before (4 clampings, 43.8 min), so no evidence is left for a ranking question.
- 2026-11-27: A032-A035 from the owner: Türkiye's tool database and machines.
- 2026-11-27: A034 widened by the owner: the remapper's Add tool picks from the tool database as well.
- 2026-11-27: from the owner: under clamping 1's outline cut (0.5 mm under the part, unchanged) the gap to the jaw tops is 1 mm, settable 1 to 1.5 mm (it was 0.5; A015), and the grip under it 5 mm wanted, 3 at the least with the yellow warning (A016). The top's 0.5 mm stays (A021). Under the part: 4.5 mm at the least, 6.5 wanted (1 mm gap).
- 2026-11-27: A036 and A037 from the owner (hole drills and pecks, after an engineer's program for two Ø1 holes); drilling stays before the milling; Q021 from A036. The plastics/aluminium split also answers Q015 in part (the plastics want full retracts).
- 2026-11-27: Q022 answered by the owner: "allow 0.1 like the engineers" (A036: down to 0.1 mm smaller).
- 2026-11-27: Q021 answered and Q022 changed by the owner: bigger drills up to 0.12 mm as the engineers (for now), smaller ones up to 0.05 mm (A036).
- 2026-11-27: A038 and A039 from the owner (moving a tool's work to another clamping; a quarter turn about Z). The simulation now draws the POM nest as a block on its parallels (it read the nest's walls as spacer plates and ran the parallels up to the part).
- 2026-11-27: A040 from the owner (parts as STEP files, never PDF); step 1 of the shape engine (exact faces from the STEP file) built on it.
- 2026-11-27: A041-A044 from the owner after the test parts (later grips under the stock still to cut, a quarter turn off a broken face, no good holding is an error with another first side suggested, slopes by a ball end mill from the top).
- 2026-11-28: A045 from the owner (step 2 of the shape engine); A046 the rule CAM AI wrote for shapes that meet, with 23 test parts and their answer keys.

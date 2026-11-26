# Project Common Ground

**Project:** CNC Process Pro
**Created:** 2026-11-25T17:00:00Z
**Last Updated:** 2026-11-25T17:00:00Z

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
- **Assumption:** Clamping 1 cuts the outline and the through holes whole, 0.5 mm under the part (drills at full diameter 0.5 mm past the bottom); after the turn only the face mill takes the rest, plus what only that side reaches. Extra clampings stay for side features.
- **Source:** Owner, 2026-11-26
- **Validated:** 2026-11-26
- **Context:** Every CAM AI program

### A016: Clamping 1 grip

- **Type:** stated
- **Assumption:** The jaws grip under the outline cut: 4 mm by default (5 mm of stock under the part), the designer may go down to 3 mm (4 under the part), shown yellow with a warning; less is refused and a thicker Z blank asked for. Never under 3 mm.
- **Source:** Owner, 2026-11-26 (answered: the 3-4 mm is the jaws' grip)
- **Validated:** 2026-11-26
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
- **Assumption:** Clamping 1 always faces the top: at least 0.5 mm over the part (but on a white face), so the blank needs 4.5 mm of extra Z at the least (0.5 over, 4 under); less is refused like a thinner blank.
- **Source:** Owner, 2026-11-26 (a 4 mm blank left the top raw on a test part)
- **Validated:** 2026-11-26
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

---

## WORKING

Medium confidence. Use but flag if contradicted.

### A027: Orders that lock

- **Type:** inferred
- **Assumption:** One row per tool, so a tool's operations move together. An order no check covers stays locked and says why: anything before the facing, a drill before its spot drill, a mill before the one whose material it was made for (the simulation does not see a tool cutting more than it was made for).
- **Source:** CAM AI (the checks it has); Q012 asks the owner
- **Validated:** 2026-11-26
- **Context:** Tool list, editProgram

### A028: Resting on a step by itself

- **Type:** assumed
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

### Q008: A deep step in a hole

- **Type:** uncertain
- **Question:** A Ø1.5 hole 9 mm deep with a smaller one going on from its floor (Pde1d25de, Pf3d9b947) is now made like a counterbore, by a Ø1 end mill (+1.8 min on each part). Is such a deep, narrow step a counterbore (end mill), or drilled to its depth and its floor left as the drill leaves it? Where is the line (depth against Ø)?
- **Source:** Library run s42 against s44

### Q009: Parallels beside a hanging body

- **Type:** uncertain
- **Question:** Resting on a step, CAM AI takes the parallels as wide as the simulation draws them (the held width / 6, 6 mm at most), 0.5 mm clear of the hanging body, each bearing on the step over 85 % of its length (holes and rounded ends of a flange). What widths does the shop have, and is 85 % enough?
- **Source:** The uploaded part (its flange leaves 3.8 mm beside the boss across the jaws, 9.9 mm along them)

### Q010: A step by itself

- **Type:** uncertain
- **Question:** CAM AI now rests a later clamping on the deepest step that fits and holds, by itself. Should it always, or only when the body under the step is narrower than some share of the part (a rule the library does not show)?
- **Source:** The owner's picture and the library's "UNTERLAGE IN EP" notes (which do not say when)

### Q011: The cut-off sentence

- **Type:** uncertain
- **Question:** The request had "when i click the settings on the" with nothing after it. Read here as the OP settings button (parallels and how the part lies). Was something else meant?
- **Source:** Owner's message, 2026-11-26

### Q013: A quarter turn on the operator's pair

- **Type:** uncertain
- **Question:** To rest on a step, CAM AI may now turn a clamping of the face pair the operator picked a quarter about Z (A028); until now it never changed how the operator laid a clamping. Allowed, or should it only say that a quarter turn would rest it on the step?
- **Source:** The uploaded part (its step only takes parallels along the jaws)

### Q012: Moving a drill among the mills

- **Type:** uncertain
- **Question:** Drills may be moved before or after the mills (the simulation checks rapids and collisions; a drill moved after a pocket only cuts air longer). Is there an order the shop never allows that should lock too?
- **Source:** The reorder locks (A024)

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

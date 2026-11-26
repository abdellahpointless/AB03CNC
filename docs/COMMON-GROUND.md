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

---

## WORKING

Medium confidence. Use but flag if contradicted.

### A013: CAM AI scope

- **Type:** inferred
- **Assumption:** These 17 items change CAM AI only; the remapper's toolpath viewer stays as it is unless asked.
- **Source:** Wording of the request (CAM AI screens)
- **Validated:** 2026-11-25
- **Context:** All items

---

## OPEN

Low confidence. Ask before assuming.

None open. Set aside by the owner: Q004 (Pfae5765f's turned part, ignored for now).

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

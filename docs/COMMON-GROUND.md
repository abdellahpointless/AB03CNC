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

### Q004: A turned part held below its widest line (library program Pfae5765f)

- **Type:** uncertain
- **Question:** In its 4th clamping CAM AI puts the stop face at the model's face (X -5 mm in that clamping), but the
  simulation finds the material between the vise floor and the jaw tops reaching only X -4.42 mm: a round face whose
  widest line sits right at the jaw tops (5 mm grip on 40 mm parallels). 0.58 mm is over the 0.5 mm the check allows, so
  the program is flagged "misplaced" and its download stays locked. The shop rests this part on a ledge. How does the
  shop hold a turned part in its last clamping: deeper in the jaws, on a V-block, in a nest? No rule until answered.
- **Evidence:** the planner's own grid gave -4.74 and -4.91 mm in two tries (snapped to -5 in one), the check's -4.42;
  the same failure at the commit before this round's work (already in production, locked).
- **Context:** tests/library/camJaws.test.ts (the one library failure, 38 of 39 pass).

---

## History

- 2026-11-25: created, 14 assumptions from the owner's 17-item CAM AI request.
- 2026-11-25: three open questions from the work on items 1 and 3 (Q001-Q003).
- 2026-11-25: answered by the owner and done: Q001 jaw blocks flush with the plates at 45 mm (drawn so); Q002 a Y+
  spacer only in very special cases, kept as an extra option (moves that clamping's G52 Y); Q003 20 and 50 mm moving-jaw
  spacers offered as well as 15.
- 2026-11-25: Q004 from the library's one failing program.

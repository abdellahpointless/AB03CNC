# CNC Process Pro

G-code tool remapper and HAAS ⇄ FANUC dialect converter for the shop floor, with a shared
tool inventory, program history, "part without scan" logging and admin analytics.

Everything runs on **Cloudflare's free plan**: one Worker serves the app and its API, and a
D1 database stores the data. Netlify and Supabase are no longer needed.

```
Browser (each PC) ──► Cloudflare Worker
                       ├─ /               country picker (Morocco · Türkiye)
                       ├─ /ma/  + /ma/api/*      Morocco app   ──► D1 cnc-process-pro-db  (English)
                       ├─ /tr/  + /tr/api/*      Türkiye app   ──► D1 cnc-process-tr-db   (Turkish)
                       ├─ /master/ + /master/api/*  master dashboard ──► D1 cnc-process-hub-db
                       └─ /api/*          old address of the Morocco API (kept for PCs on the old version)
```

### Countries and the master dashboard

- **One link, separate countries.** The root page lets people choose their country. Each
  country is a separate instance with its **own database**: its own accounts, machines,
  tools, history, parts and language (Morocco: English, Türkiye: Turkish). The Worker
  gives every request only the database of its country, and each database remembers which
  country it belongs to (it refuses to serve another one if the bindings are ever swapped).
- **Machines are per country** and managed in Admin → Machines (or created by the Excel
  import with a Brand column). The G-code rules written for specific Moroccan machines
  (HAAS-1, HAAS-2/4/5, FANUC-2) only apply to those machines in Morocco; every other machine
  follows its brand's dialect (HAAS / FANUC).
- **Master admin.** Master accounts live in the hub database. A master can sign in from any
  country's login page (or /master/) and lands on the master dashboard: every country's
  numbers side by side. Masters cannot open a country app as a user.
- **Setting up a new country:** a Moroccan admin creates the first master account
  (Admin → Master admin account). The master then creates the first admin of the new
  country from the dashboard. New countries have no public "first-time setup".
- **Adding a third country later:** create a D1 database, add its binding to
  `wrangler.jsonc`, add an entry to `src/regions.ts` and a `src/i18n/locales/<lang>/` folder.

---

## 1. Deploy to Cloudflare (one time, ~5 minutes)

The D1 database **`cnc-process-pro-db`** already exists in your Cloudflare account, and its id
is in `wrangler.jsonc`. The Worker creates its own tables on first start.

1. Open the Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository**.
2. Connect GitHub, then choose the repository **`abdellahpointless/AB03CNC`**.
3. Settings:
   - **Project / Worker name:** `cnc-process-pro` (it must match `name` in `wrangler.jsonc`)
   - **Production branch:** whichever branch you merge this work into (for example `main`)
   - **Build command:** `npm run build`
   - **Deploy command:** `npx wrangler deploy` (the default)
4. Click **Deploy**. When it finishes you get a URL like
   `https://cnc-process-pro.<your-subdomain>.workers.dev`.

After that, every push to the production branch redeploys automatically.

Optional: **Settings → Domains & Routes** lets you add your own domain.

## 2. First start and moving your data out of Supabase

1. Open the new URL. The first screen is **First-time setup**: create the admin account.
2. Go to **Admin: Analytics, Users & Data → Import from Supabase**.
3. Paste the Supabase project URL and the **anon** key, then press **Start import**.
   It copies:
   - user accounts (with their current passwords)
   - the tool inventory
   - the program history and the generated G-code files
   - the part entries

   Keep the tab open until the log says **Migration finished**. Running it again is safe,
   because records that already exist are skipped.
4. If you kept old **`CNC_History_Archive_*.json`** files from the 30-day archiving, import
   them with **Restore / import a backup file…**. That brings the archived history (and the
   "time won" count) back.

### After the migration

- Check that the operators can sign in, then **switch off the Netlify site**.
- **Delete (or pause) the Supabase project.** Its tables were readable and writable by anyone
  who had the anon key, and that key is visible inside the Netlify site's JavaScript. This
  includes the user passwords, which were stored in plain text.
- For the same reason, **change the passwords**: header 🔑 for your own, and the key icon next
  to each user under Admin → Users.

## 3. Daily use: what changed

| Before | Now |
| --- | --- |
| Passwords in plain text in a public table; admin password `121` hard-coded and printed on the "System Blocked" screen | Passwords are hashed (PBKDF2) and checked only on the server. Sessions use secure cookies, and login is locked for 15 min after 10 wrong passwords |
| Roles were only checked in the browser | Every admin action is checked by the server |
| Operators were **blocked after 30 days** until an admin archived the history | No more lockout. History is stored record by record, and clean-up is optional (Admin → Data) |
| Tool inventory and history were each one big shared blob, so two PCs saving at the same time could erase each other's changes | Every tool and every history record is its own database row |
| "Time won" was computed differently on each PC | Computed on the server, so it is identical everywhere |
| Export failed silently when offline | The program still downloads, and its history entry uploads automatically when the connection returns (header shows "1 to upload") |

**G-code engine fixes (safety related):**

- A comment that mentions M6 (for example `N23 (TARAUD M6)`) was treated as a tool change.
  That created duplicate blocks and cut short the Z-depth crash check.
- With a pre-staged tool on the line before (`T7` then `T3 M6`), the old code changed the
  wrong line and left `T3 M6` untouched, so the machine would load the original tool.
- Depths written like `Z-.5` were ignored by the crash check.
- `G41 D1` or `L5` in the code could be read as a tool diameter or length and auto-select a
  wrong tool.
- Adding FANUC `H#513 D#513` could corrupt a comment on the same line.
- HAAS → FANUC dropped X/Y/S/M3 words that were on the G43 line.
- FANUC → HAAS now also recognises `M06` and `M8`.
- **FANUC-2 only:** every tool change gets `G49` right after `M6` (`T3 M6 G49`), unless it is already there.
- **G53 Y0 (table to the operator)** is added only where the operator needs the table:
  before each part flip (a `G52` that shifts the offset; it goes after the tool's comment
  lines and before the `M0` stops) and right before the end of the program (`M30`/`M02`) to
  unload the parts. It is not added at ordinary tool changes, and `G52 X0 Y0 Z0` (cancel) is
  ignored. If a G53 Y0 is already there, nothing is added. Inserted lines get the next N number
  and the following numbers shift so none are duplicated.

**UI fixes:**

- The generated code is marked stale, and "Extract Code" is disabled, when the program or
  machine changes after generation.
- Green change highlighting is no longer shifted after inserted lines.
- Cards no longer jump 3px on hover.
- The dialogs no longer turn white on PCs set to light mode.
- Text is no longer drawn over the icons in the login and search fields.
- The export toast now appears in the corner.
- Delete buttons are styled.
- Typing in large programs no longer lags.

## 4. Free-plan budget (about 10 users)

| Cloudflare free limit | Typical use here |
| --- | --- |
| 100,000 Worker requests / day | Each open PC checks for changes every 15 s, or every 60 s when idle, which is about 2–6k requests per PC per day |
| D1: 5 M rows read / 100k rows written per day | All frequent queries use indexes, so typical use is a few hundred thousand reads per day |
| D1: 5 GB storage | G-code is gzip-compressed in the browser before upload, which is years of programs |
| 10 ms CPU per request | Password hashing is tuned to about 5 ms, and compression happens in the browser |

D1 keeps a 7-day **Time Travel** history, which allows a point-in-time restore from the
Cloudflare dashboard. Admin → Data → **Download full backup** gives you a JSON copy of
everything at any time.

## 5. Local development

```bash
npm ci
npm run build && npx wrangler dev   # app + API + local database on http://localhost:8787
# or, for hot reload: run `npm run dev:api` in one terminal and `npm run dev` in another (http://localhost:3000)
npm test                            # G-code engine unit tests
npm run typecheck
```

The local database lives in `.wrangler/` and is separate from the live one.

## Project layout

```
src/                 React app
  lib/gcodeProcessor.ts, *Converter.ts   remapping + dialect rules (unit-tested in tests/)
  contexts/          AuthContext (sign-in), SyncContext (shared data + polling)
  lib/historyApi.ts  history, offline export queue, compressed program files
  lib/migration.ts   Supabase import, backup / restore
  regions.ts         the countries (database binding, language, cookie)
  lib/instance.ts    which page this is (picker / country / master), per-country storage keys
  i18n/              translations: locales/en/*.ts and locales/tr/*.ts (same keys, type-checked)
  components/HubPage.tsx, MasterApp.tsx   country picker, master dashboard
worker/              Cloudflare Worker API
  index.ts           router: /ma, /tr, /master -> the right database
  schema.ts          database tables (applied automatically, per database)
  auth.ts            password hashing, sessions, throttling, master sign-in
  i18n.ts, i18n-tr.ts  server messages in Turkish
  routes/            tools, history, users, parts, analytics, machines (fleet), master, admin import
wrangler.jsonc       Worker + D1 configuration
```

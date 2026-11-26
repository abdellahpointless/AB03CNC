import type { Plugin } from 'vite';

/*
 * Keeps the app's code away from people who are not signed in.
 *
 * Only the country picker and the sign-in page are public (dist/assets/). Every other piece of
 * code is written to dist/app/<access>/, and the Worker (worker/assets.ts) hands a file there
 * out only to a session that has that access:
 *
 *   app/user/      anyone signed in to a country
 *   app/admin/     a country admin
 *   app/toolpath/  the toolpath viewer: admins and people with the toolpath beta (and CAM AI's people)
 *   app/p/         CAM AI and the shop's cutting data (access "cam"): Morocco's admins only. A neutral
 *                  folder and hash-only file names, and no other file may name CAM AI (the build checks):
 *                  nobody else is to know it exists.
 *   app/master/    a master admin
 *   app/any/       anyone signed in (code shared by the country app and the master dashboard)
 *
 * The access of a file follows from who loads it: each lazily loaded part of the app starts a
 * "root" (App, MasterApp, CamAi...), and a file gets the least strict access among the roots that
 * need it, so nobody who may open a part of the app is refused a file it needs. Anything not
 * listed falls back to the access of whatever loads it. The build fails if engine code would end
 * up public.
 */

export type Access = 'public' | 'user' | 'admin' | 'toolpath' | 'cam' | 'master' | 'any';

/** Lazily loaded parts of the app and who may open them (path inside src/). */
const ROOTS: [RegExp, Access][] = [
  [/\/src\/main\.tsx$/, 'public'],
  [/\/src\/components\/(HubPage|Login)\.tsx$/, 'public'],
  [/\/src\/App\.tsx$/, 'user'],
  [/\/src\/components\/MasterApp\.tsx$/, 'master'],
  [/\/src\/components\/AdminExtractionAnalytics\.tsx$/, 'admin'],
  [/\/src\/components\/(CamAi|CamPartView|CamTurnGhost)\.tsx$/, 'cam'],
  [/\/src\/(i18n\/camLocales|lib\/cam\/news)\.ts$/, 'cam'],
  [/\/src\/components\/(ToolpathViewer|Toolpath3D)\.tsx$/, 'toolpath'],
];

/** Web workers (bundled separately by Vite) and who may load them. */
export function workerAccess(name: string): Access {
  return /cam\.worker/.test(name) ? 'cam' : 'toolpath';
}

/**
 * The only source files the public page (country picker, sign-in) may contain, inside src/.
 * Anything else that lands in dist/assets/ stops the build, so a new import cannot quietly make
 * app code public.
 */
const PUBLIC_SOURCES = new Set([
  'main.tsx',
  'index.css',
  'regions.ts',
  'lib/instance.ts',
  'lib/api.ts',
  'lib/pressFeedback.ts',
  'lib/motion.ts',
  'lib/phoneCheck.ts',
  'i18n/index.ts',
  'i18n/locales/en/common.ts',
  'i18n/locales/en/app.ts',
  'i18n/locales/en/hub.ts',
  'i18n/locales/tr/common.ts',
  'i18n/locales/tr/app.ts',
  'i18n/locales/tr/hub.ts',
  'contexts/AuthContext.tsx',
  'components/UpdateBanner.tsx',
  'components/HubPage.tsx',
  'components/Login.tsx',
  'components/Flag.tsx',
]);

export function accessDir(access: Access): string {
  return access === 'public' ? 'assets' : access === 'cam' ? 'app/p' : `app/${access}`;
}

/** A built file's name: hash only for CAM AI's (its parts' names would name it). */
export const fileName = (access: Access, ext = '.js') => `${accessDir(access)}/${access === 'cam' ? '' : '[name]-'}[hash]${ext}`;

/** What may only appear in CAM AI's own files and the master dashboard's. */
export const NAMES_IT = /CAM[ _]?AI|camAi|CamAi|cam_ai/;

/** The least strict access that still lets every one of these people in. */
export function combine(set: Set<Access>): Access {
  if (set.size === 0) return 'user';
  if (set.has('public')) return 'public';
  if (set.size === 1) return [...set][0];
  if ([...set].every((a) => a === 'cam' || a === 'toolpath')) return 'toolpath';
  if (!set.has('master') && !set.has('any')) return 'user';
  return 'any';
}

const slash = (id: string) => id.replace(/\\/g, '/');

export function privateChunks(): Plugin {
  const moduleAccess = new Map<string, Access>();
  let srcDir = '';

  // Decided by the app's own modules: library barrels (icons, i18n helpers) re-export far more
  // than a chunk uses, so a library module "reachable" from the sign-in page says nothing about
  // the chunk it ends up in. A chunk made only of library code follows its libraries.
  const chunkAccess = (moduleIds: readonly string[]): Access => {
    const own = moduleIds.filter((id) => !/[\\/]node_modules[\\/]/.test(id) && !id.startsWith('\0'));
    const set = new Set<Access>();
    for (const id of own.length ? own : moduleIds) {
      const a = moduleAccess.get(id);
      if (a) set.add(a);
    }
    return combine(set);
  };

  return {
    name: 'private-chunks',
    apply: 'build',

    configResolved(config) {
      srcDir = `${slash(config.root)}/src/`;
    },

    buildEnd() {
      moduleAccess.clear();
      const ids = [...this.getModuleIds()];
      const info = (id: string) => this.getModuleInfo(id);

      // Every module that starts a chunk graph: the entry and everything loaded with import().
      const entries = ids.filter((id) => {
        const i = info(id);
        return !!i && (i.isEntry || i.dynamicImporters.length > 0);
      });

      // Modules each entry needs straight away (static imports, followed through).
      const neededBy = new Map<string, string[]>();
      for (const e of entries) {
        const seen = new Set<string>([e]);
        const todo = [e];
        while (todo.length) {
          const id = todo.pop()!;
          for (const next of info(id)?.importedIds ?? []) {
            if (!seen.has(next)) {
              seen.add(next);
              todo.push(next);
            }
          }
        }
        for (const id of seen) {
          const list = neededBy.get(id) ?? [];
          list.push(e);
          neededBy.set(id, list);
        }
      }

      // Access of an entry: listed in ROOTS, or else that of the modules that import() it.
      const entryAccess = new Map<string, Access>();
      const resolving = new Set<string>();
      const accessOfEntry = (e: string): Access => {
        const known = entryAccess.get(e);
        if (known) return known;
        const listed = ROOTS.find(([re]) => re.test(slash(e)));
        if (listed) {
          entryAccess.set(e, listed[1]);
          return listed[1];
        }
        if (resolving.has(e)) return 'user';
        resolving.add(e);
        const set = new Set<Access>();
        for (const importer of info(e)?.dynamicImporters ?? []) set.add(accessOfModule(importer));
        resolving.delete(e);
        const a = combine(set);
        entryAccess.set(e, a);
        return a;
      };
      const accessOfModule = (id: string): Access => {
        const set = new Set<Access>();
        for (const e of neededBy.get(id) ?? []) set.add(accessOfEntry(e));
        return combine(set);
      };

      for (const id of ids) moduleAccess.set(id, accessOfModule(id));
    },

    outputOptions(options) {
      return {
        ...options,
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: (chunk) => fileName(chunkAccess(chunk.moduleIds)),
      };
    },

    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        const isPublic = file.fileName.startsWith('assets/');
        // Nobody but CAM AI's people (and the master dashboard) may read its name in a file.
        if (!/^app\/(p|master)\//.test(file.fileName)) {
          const text = file.type === 'chunk' ? file.code : typeof file.source === 'string' ? file.source : '';
          const hit = text.match(NAMES_IT);
          if (hit) this.error(`${file.fileName} names CAM AI ("${text.slice(Math.max(0, hit.index! - 40), hit.index! + 40)}"): move it to CAM AI's own files.`);
        }
        if (file.type === 'chunk') {
          if (file.isEntry && !isPublic) this.error(`The page's entry ${file.fileName} is not public: the sign-in page could not load.`);
          if (isPublic) {
            const leaked = file.moduleIds
              .map(slash)
              .filter((id) => id.startsWith(srcDir))
              .map((id) => id.slice(srcDir.length).split('?')[0])
              .filter((src) => !PUBLIC_SOURCES.has(src));
            if (leaked.length) this.error(`App code would be public in ${file.fileName}: ${leaked.join(', ')}`);
          }
        } else if (/worker/i.test(file.fileName) && file.fileName.endsWith('.js') && isPublic) {
          this.error(`Web worker ${file.fileName} would be public.`);
        } else if (file.fileName.endsWith('.wasm') && isPublic) {
          this.error(`WebAssembly ${file.fileName} would be public.`);
        }
      }
    },
  };
}

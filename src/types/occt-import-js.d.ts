// occt-import-js (OpenCascade for the web, LGPL-2.1): the module factory; src/lib/step.ts types what it uses.
declare module 'occt-import-js' {
  const occtimportjs: (overrides?: { locateFile?: (path: string) => string }) => Promise<unknown>;
  export default occtimportjs;
}

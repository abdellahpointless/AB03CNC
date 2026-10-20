/*
 * French shop words in G-code comments, translated to English.
 *
 * CAM programs written in Morocco/France carry French comments ("(POINTEUR D6)", "(FORET 8.5)")
 * and the remapper writes the tool category ("(AUTO-REMAP: T4 pointeur)"). Countries whose
 * operators do not read French get these comments in English.
 *
 * Only text inside parentheses is touched: comments are ignored by the controller, so the
 * machine code itself is never changed. Applied after the remap, so tool detection still reads
 * the original French words.
 */

/** [French (written without accents), English]. Longer phrases first so they win over single words. */
const DICTIONARY: [string, string][] = [
  // Tools (multi-word first)
  ["fraise d'ebauche", 'roughing end mill'],
  ['fraise ebauche', 'roughing end mill'],
  ['fraise de finition', 'finishing end mill'],
  ['fraise finition', 'finishing end mill'],
  ['fraise boule', 'ball end mill'],
  ['fraise hemispherique', 'ball end mill'],
  ['fraise torique', 'bull nose end mill'],
  ['fraise rayon', 'corner radius end mill'],
  ['fraise a chanfreiner', 'chamfer mill'],
  ['fraise a surfacer', 'face mill'],
  ['fraise a rainurer', 'slot mill'],
  ['fraise a fileter', 'thread mill'],
  ['fraise 2 tailles', 'end mill'],
  ['fraise deux tailles', 'end mill'],
  ['fraise t', 'T-slot cutter'],
  ['barre d\'alesage', 'boring bar'],
  ['outil a aleser', 'boring bar'],
  ['tete d\'alesage', 'boring head'],
  ['foret a centrer', 'center drill'],
  ['foret etage', 'step drill'],
  ['changement d\'outil', 'tool change'],
  ['changement outil', 'tool change'],
  ['fin de programme', 'end of program'],
  ['debut de programme', 'start of program'],
  ['trou taraude', 'tapped hole'],
  ['trous taraudes', 'tapped holes'],
  ['fraises', 'end mills'],
  ['fraise', 'end mill'],
  ['pointeurs', 'spot drills'],
  ['pointeur', 'spot drill'],
  ['forets', 'drills'],
  ['foret', 'drill'],
  ['tarauds', 'taps'],
  ['taraud', 'tap'],
  ['alesoirs', 'reamers'],
  ['alesoir', 'reamer'],
  ['chanfreins', 'chamfers'],
  ['chanfrein', 'chamfer'],
  ['tourteau', 'face mill'],
  ['plaquettes', 'inserts'],
  ['plaquette', 'insert'],
  ['palpeur', 'probe'],
  ['porte-outils', 'tool holders'],
  ['porte-outil', 'tool holder'],
  ['outils', 'tools'],
  ['outil', 'tool'],
  // Operations
  ['ebauche', 'roughing'],
  ['finition', 'finishing'],
  ['demi-finition', 'semi-finishing'],
  ['surfacage', 'facing'],
  ['contournage', 'contouring'],
  ['detourage', 'profiling'],
  ['percage', 'drilling'],
  ['pre-percage', 'pre-drilling'],
  ['centrage', 'center drilling'],
  ['taraudage', 'tapping'],
  ['filetage', 'threading'],
  ['alesage', 'boring'],
  ['lamage', 'counterbore'],
  ['chanfreinage', 'chamfering'],
  ['ebavurage', 'deburring'],
  ['rainurage', 'slotting'],
  ['rainures', 'slots'],
  ['rainure', 'slot'],
  ['poches', 'pockets'],
  ['poche', 'pocket'],
  ['fraisage', 'milling'],
  ['gravure', 'engraving'],
  ['trous', 'holes'],
  ['trou', 'hole'],
  ['taraude', 'tapped'],
  ['perce', 'drilled'],
  // Dimensions and settings
  ['diametre', 'diameter'],
  ['longueur', 'length'],
  ['largeur', 'width'],
  ['hauteur', 'height'],
  ['epaisseur', 'thickness'],
  ['profondeur', 'depth'],
  ['rayon', 'radius'],
  ['vitesse', 'speed'],
  ['avance', 'feed'],
  ['arrosage', 'coolant'],
  ['lubrification', 'coolant'],
  ['matiere', 'material'],
  ['carbure', 'carbide'],
  ['acier', 'steel'],
  ['inox', 'stainless steel'],
  ['laiton', 'brass'],
  ['fonte', 'cast iron'],
  // Program structure
  ['programme', 'program'],
  ['piece', 'part'],
  ['pieces', 'parts'],
  ['brut', 'stock'],
  ['origine', 'origin'],
  ['bridage', 'clamping'],
  ['serrage', 'clamping'],
  ['retrait', 'retract'],
  ['controle', 'check'],
  ['mesure', 'measure'],
  ['nettoyage', 'cleaning'],
  ['dessus', 'top'],
  ['dessous', 'bottom'],
];

/** Accent-tolerant pattern for an unaccented French word. */
function accentPattern(word: string): string {
  const map: Record<string, string> = {
    a: '[aàâä]',
    e: '[eéèêë]',
    i: '[iîï]',
    o: '[oôö]',
    u: '[uùûü]',
    c: '[cç]',
    "'": "['’]\\s?",
    ' ': '[\\s_]+',
    '-': '[-\\s]?',
  };
  return [...word].map((ch) => map[ch] ?? ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
}

// One regex for the whole dictionary. Single letters at the end of a phrase ("fraise T") must
// not be followed by a digit, or "FRAISE T5" (tool number) would be read as a T-slot cutter.
const ENTRIES = DICTIONARY.map(([fr, en]) => ({ en, re: new RegExp(`^${accentPattern(fr)}$`, 'iu') }));
const ALTERNATION = DICTIONARY.map(([fr]) => {
  const tail = /\s[a-z]$/.test(fr) ? '(?![\\p{L}\\p{N}.])' : '(?![\\p{L}])';
  return `${accentPattern(fr)}${tail}`;
}).join('|');
const WORDS = new RegExp(`(?<![\\p{L}])(?:${ALTERNATION})`, 'giu');

/** Keeps the look of the original word: ALL CAPS, Capitalised or lower case. */
function matchCase(source: string, english: string): string {
  const letters = source.replace(/[^\p{L}]/gu, '');
  if (letters && letters === letters.toUpperCase()) return english.toUpperCase();
  if (letters && letters[0] === letters[0].toUpperCase()) return english[0].toUpperCase() + english.slice(1);
  return english;
}

/** Translates the French words of one piece of comment text. */
export function translateCommentText(text: string): string {
  return text.replace(WORDS, (found) => {
    const entry = ENTRIES.find((e) => e.re.test(found));
    return entry ? matchCase(found, entry.en) : found;
  });
}

/** Translates the comments (text in parentheses) of a G-code program; code is left untouched. */
export function translateGcodeComments(code: string): string {
  return code
    .split('\n')
    .map((line) => (line.includes('(') ? line.replace(/\(([^()]*)\)/g, (_, inner: string) => `(${translateCommentText(inner)})`) : line))
    .join('\n');
}

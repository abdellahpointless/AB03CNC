/**
 * HAAS to FANUC: the program as the shop's FANUC post writes it. Checked against every true twin
 * of the reference library (tests/library/twins.test.ts): the same job posted for both controls.
 *
 * 1. "%" first and last. The O number: the program's full number from its file name when that is
 *    the same program ("O0131784.X20" for "O0784" -> "O0131784(X20)"), else the program's own.
 * 2. Safety line "G40 G17 G53 G49 G80 G90" -> "G0 G53 G49 Z0 G94 M95"; a bare end retract
 *    "G53 G49 Z0" -> "G0 G53 G49 Z0" (M95 only at the start).
 * 3. Tool change: the tool's comment line carries the optional stop, "M01 (CHECK TOOL)" goes:
 *    "(MESSERKOPF D40 / MK_40...)" -> "M01 (MESSERKOPF D40 / MK_40...)" (the FANUC files never
 *    write CHECK TOOL; every tool change of theirs has M01 with the tool's comment).
 * 4. "G00 G43 H03 Z52. M08" -> "G00 G43 Z52. H#513 D#513 M254 M08" (other words of the block on
 *    their own line first; no Z: the Z of the rapid right after it; a lone M08 after it merged).
 * 5. Tapping: "G98 G84 Z-15. R2. F225. S300 M03" -> "... F225 M84 S300 M03" (as the FANUC files).
 * 6. HAAS-only M89 removed. M98 P7999 deleted: the shop's machines have no O7999 (shop rule); the
 *    table comes out with G53 Y0 before each part flip and at the end instead.
 * 7. N1, N2, N3... on every line but % and O; from N9999 on, N9999 (the FANUC files do the same).
 * 8. Whole-number X/Y/Z get a dot (FANUC reads X10 as 0.010 mm), a G53 move to 0 stays bare
 *    ("Z0", as the FANUC files); whole-number feeds lose theirs (F3000. -> F3000, as the FANUC files),
 *    except in a program with G95 (feed per revolution).
 * Every rule reads the code only, never the text of a (comment).
 */

import { addCoordinateDots, applyG53BeforeG52, codeOnly, FANUC_MAX_N, numberLines, replaceInCode } from './gcodeProcessor';

export interface HaasToFanucResult {
  fanucCode: string;
  fanucFilename: string;
  stats: {
    oCodeFormatted: boolean;
    securityLinesReplaced: number;
    g43Converted: number;
    coolantMerged: number;
    m98LinesDeleted: number;
    g53Y0Added: number;
    percentWrapped: boolean;
    totalLines: number;
  };
}

/** The program's number in its file name ("O0131784.X20", the library's "O0131784_2.X20"), with the extension. */
export function fileProgramNumber(fileName: string): { digits: string; ext: string } | null {
  const m = fileName.match(/(?:^|[\\/])O(\d{5,8})(?:_\d+)?\.([A-Z0-9]{1,4})$/i);
  return m ? { digits: m[1], ext: m[2].toUpperCase() } : null;
}

/** The HAAS form of a long program number: first digit and last three (O0131784 -> O0784), as the shop's HAAS files. */
export const haasProgramNumber = (digits: string) => (digits.length > 4 ? digits[0] + digits.slice(-3) : digits);

const isCommentOnly = (l: string) => /^(N\d+\s*)?\(/i.test(l.trim()) && !codeOnly(l).replace(/^\s*N\d+/i, '').trim();
const isToolChange = (code: string) => /(?<![A-Z])M0*6(?![0-9.])/i.test(code);
const CHECK_TOOL = /^(N\d+\s*)?M0?1\s*\(\s*CHECK TOOL\s*\)\s*$/i;

export function convertHaasToFanuc(haasCode: string, defaultFilename: string = 'fanuc_program.nc'): HaasToFanucResult {
  const input = haasCode.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '%');
  const out: string[] = [];
  let fanucFilename = defaultFilename.replace(/\.[^/.]+$/, '') + '.nc';
  const named = fileProgramNumber(defaultFilename);

  const stats = {
    oCodeFormatted: false,
    securityLinesReplaced: 0,
    g43Converted: 0,
    coolantMerged: 0,
    m98LinesDeleted: 0,
    g53Y0Added: 0,
    percentWrapped: !/^\s*%/.test(haasCode),
    totalLines: 0,
  };

  // The current tool's comment line (in out), which takes the M01 of its CHECK TOOL stop.
  let label = -1;
  let inToolComments = false;

  for (let i = 0; i < input.length; i++) {
    let line = input[i].trim();
    if (!line) continue;

    // The O number: the full one when the file name is this program's ("O0131784" for "O0784").
    const o = line.match(/^O(\d+)/i);
    if (o && !stats.oCodeFormatted) {
      stats.oCodeFormatted = true;
      const full = named && haasProgramNumber(named.digits) === haasProgramNumber(o[1]) ? named : null;
      if (full) line = `O${full.digits}(${full.ext})`;
      fanucFilename = `O${full ? full.digits : o[1]}.nc`;
      out.push(line);
      continue;
    }

    // HAAS through-spindle coolant off: not a FANUC code (a Robodrill external output).
    if (/(?<![A-Z0-9])M89(?![0-9.])/i.test(codeOnly(line))) {
      line = replaceInCode(line, /\s*(?<![A-Z0-9])M89(?![0-9.])/gi, '').trim();
      if (!line.replace(/^N\d+/i, '').trim()) continue;
    }
    const code = codeOnly(line).trim();

    // Rule: In FANUC if the app detects M98 P7999 then it should be deleted
    if (/M98\s*P7999/i.test(code)) {
      stats.m98LinesDeleted++;
      continue;
    }

    const isHaasSecurityLine =
      /^(N\d+\s+)?(?:G0?0\s+)?G40\s+G17\s+G53\s+G49\s+G80\s+G90/i.test(code) ||
      (/G40/i.test(code) && /G17/i.test(code) && /G53/i.test(code) && /G49/i.test(code) && /G80/i.test(code) && /G90/i.test(code));
    const isHaasRetractSecurity = /^(N\d+\s+)?(?:G0?0\s+)?G53\s+G49\s+Z0(?:\.0*)?$/i.test(code);
    if (isHaasSecurityLine || isHaasRetractSecurity) {
      stats.securityLinesReplaced++;
      // M95 belongs to the start of the program only; a retract elsewhere stays a plain retract.
      out.push(isHaasSecurityLine ? 'G0 G53 G49 Z0 G94 M95' : 'G0 G53 G49 Z0');
      inToolComments = false;
      continue;
    }

    if (isToolChange(code)) {
      label = -1;
      inToolComments = true;
      // A G43 on the tool change line is split off and converted below, as on its own line.
      if (!/\bG43\b.*H\d+/i.test(code)) {
        out.push(line);
        continue;
      }
    }
    // The tool's comment block right after the change: its first line (not the size) is the label.
    if (inToolComments && isCommentOnly(line)) {
      if (label === -1 && !/\(\s*DIAMETER/i.test(line)) label = out.length;
      out.push(line);
      continue;
    }
    inToolComments = isToolChange(code);
    if (CHECK_TOOL.test(line) && label !== -1) {
      out[label] = out[label].replace(/^(N\d+\s*)?/i, (n) => `${n}M01 `);
      label = -1;
      continue;
    }

    // G43 Height/Diameter offset: [N..] [G00] G43 H<num> Z<val> [M08]
    if (/\bG43\b.*H\d+/i.test(code)) {
      stats.g43Converted++;
      const zMatch = code.match(/Z[-+]?(?:\d+\.?\d*|\.\d+)/i);
      // No Z on the line: the Z of the rapid right after it (the approach), never an invented one.
      const zVal = zMatch ? zMatch[0] : nextRapidZ(input, i + 1);
      let hasCoolant = /\bM0?8\b/i.test(code);
      if (!hasCoolant && i + 1 < input.length && /^(N\d+\s+)?M0?8$/i.test(codeOnly(input[i + 1]).trim())) {
        hasCoolant = true;
        stats.coolantMerged++;
        i++;
      }
      // Other words of the HAAS block (X/Y position, spindle S/M3, feed...) on their own block just
      // before the G43 line, so no motion or spindle command is silently lost.
      const otherWords = code
        .replace(/^\s*N\d+/i, ' ')
        .replace(/\bG0?0\b|\bG43\b|\bH\d+\b|\bZ[-+]?\d*\.?\d*|\bM0?8\b/gi, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (otherWords.length > 0) {
        const needsRapid = /\bG0?0\b/i.test(code) && !otherWords.some((w) => /^G0?[0-3]$/i.test(w)) && otherWords.some((w) => /^[XY]/i.test(w));
        out.push(`${needsRapid ? 'G0 ' : ''}${otherWords.join(' ')}`);
      }
      // G00 kept: the approach is a rapid even when the program is restarted at this tool.
      out.push(`G00 G43${zVal ? ` ${zVal}` : ''} H#513 D#513 M254${hasCoolant ? ' M08' : ''}`);
      // The tool has started: a CHECK TOOL after this belongs to the next tool change (other posts).
      label = -1;
      continue;
    }

    // Tapping: the FANUC files write M84 right after the feed of every G84 line.
    if (/(?<![A-Z])G84(?![0-9])/i.test(code) && !/(?<![A-Z0-9])M84(?![0-9])/i.test(code)) {
      const tapped = replaceInCode(line, /(?<![A-Z])(F[-+]?(?:\d+\.?\d*|\.\d+))/i, '$1 M84');
      line = tapped !== line ? tapped : `${line} M84`;
    }
    out.push(line);
  }

  // A program without G52 (one clamping): no lone G53 Y0 carried over; only the end one is placed.
  const isG52 = /(?<![A-Z_])G52(?![0-9])/i;
  const cleaned = out.some((l) => isG52.test(codeOnly(l))) ? out : out.filter((l) => !/^\s*(N\d+\s*)?G53(?![0-9])\s*Y\s*0(?:\.0*)?\s*$/i.test(codeOnly(l).trim()));
  const { lines: withG53, addedCount } = applyG53BeforeG52(cleaned);
  stats.g53Y0Added = addedCount;

  // Feeds: no dot on whole numbers (F3000., as the FANUC files write F3000), code only. Not in a
  // program that feeds per revolution (G95): the shop's bare feeds are all mm/min (G94).
  const perRev = withG53.some((l) => /(?<![A-Z])G95(?![0-9])/i.test(codeOnly(l)));
  const body = addCoordinateDots(numberLines(withG53, FANUC_MAX_N)).map((l) => (perRev ? l : replaceInCode(l, /(?<![A-Z])F(\d+)\.(?![0-9])/gi, 'F$1')));
  const fanucLines = ['%', ...body, '%'];
  stats.totalLines = fanucLines.length;
  return { fanucCode: fanucLines.join('\n'), fanucFilename, stats };
}

/**
 * The Z of the approach rapid right after a G43 line that has none ("G00 Z50." on the next code
 * line), or '' when the next code line is not such a move.
 */
export function nextRapidZ(lines: string[], from: number): string {
  for (let k = from; k < lines.length; k++) {
    const code = codeOnly(lines[k]).replace(/^\s*N\d+/i, '').trim();
    if (!code) continue;
    const z = code.match(/(?<![A-Z])Z[-+]?(?:\d+\.?\d*|\.\d+)/i);
    const feedMove = /(?<![A-Z])G0*[123](?![0-9])|(?<![A-Z])G[89]\d(?![0-9])|(?<![A-Z])G7[346](?![0-9])/i.test(code);
    // Only a Z-only rapid: the G43 line then makes exactly that move.
    const rapid = /(?<![A-Z])G0*0(?![0-9])/i.test(code) && !/(?<![A-Z])[XY]\s*[-+.\d]/i.test(code);
    return z && rapid && !feedMove ? z[0] : '';
  }
  return '';
}

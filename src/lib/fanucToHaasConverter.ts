/**
 * FANUC to HAAS: the program as the shop's HAAS post writes it. Checked against every true twin of
 * the reference library (tests/library/twins.test.ts): the same job posted for both controls.
 *
 * 1. "%" first and last. The O number: first digit and last three ("O0999784(X20)" -> "O0784"),
 *    the file extension in brackets dropped, a program name comment kept.
 * 2. Safety line "G0 G53 G49 Z0 G94 M95" -> "G40 G17 G53 G49 G80 G90".
 * 3. M98 P7999 (the FANUC files' table out): "G53 Y0" at a part flip, "G0 G53 G49 Y0 Z0 M89" at the
 *    end of the program, exactly where the HAAS files have them.
 * 4. Tool change: "M01 (tool comment)" -> "(tool comment)", and "M01 (CHECK TOOL)" right before the
 *    G43 line (after the flip's stops and G52 when there is one).
 * 5. "G00 G43 Z52. H#513 D#513 M254 M08" -> "G00 G43 H03 Z52. M08" (H = the tool number, two digits
 *    at least; other words of the block on their own line first; no Z: the Z of the next rapid).
 * 6. Tapping: no M84 on the G84 line (the HAAS files never write it).
 * 7. Whole-number feeds get their dot (F3000 -> F3000.), code only; a Z ending a line too (Z50 -> Z50.).
 * 8. N1, N2, N3... on every line but % and O, counting on past 9999 (the HAAS files do).
 */

import { applyG53BeforeG52, codeOnly, numberLines, replaceInCode } from './gcodeProcessor';
import { haasProgramNumber, nextRapidZ } from './haasToFanucConverter';

export interface FanucToHaasResult {
  haasCode: string;
  haasFilename: string;
  stats: {
    oCodeRenamed: boolean;
    m98LinesDeleted: number;
    securityLinesReplaced: number;
    g43Converted: number;
    feedRatesFixed: number;
    trailingZFixed: number;
    g53Y0Added: number;
    /** G43 lines whose H (the FANUC tool number) is outside 1-200: the remap sets the machine's own. */
    hOverRange: number;
    totalLines: number;
  };
}

const TABLE_OUT = /(?<![A-Z])M98\s*P7999(?![0-9])/i;
const bare = (l: string) => codeOnly(l).replace(/^\s*N\d+/i, '').trim();
/** Lines of a part flip between the tool's comments and its G43 line: comments, table out, M0 stops, G52. */
const isFlipLine = (l: string) => {
  const c = bare(l);
  return !c || TABLE_OUT.test(c) || /^G53\s*Y\s*0\.?$/i.test(c) || /^M0*0(?![0-9])/i.test(c) || /(?<![A-Z_])G52(?![0-9])/i.test(c);
};

export function convertFanucToHaas(fanucCode: string, defaultFilename: string = 'haas_program.txt'): FanucToHaasResult {
  // "%O01234": the O number on the % line is the program's own line.
  const input = fanucCode.replace(/\r/g, '').split('\n').map((l) => l.replace(/^\s*%\s*(?=O\d)/i, '')).filter((l) => l.trim() !== '%');
  const out: string[] = [];
  let haasFilename = defaultFilename.endsWith('.txt') ? defaultFilename : `${defaultFilename.replace(/\.[^/.]+$/, '')}.txt`;
  let lastToolNumber = '';

  const stats = {
    oCodeRenamed: false,
    m98LinesDeleted: 0,
    securityLinesReplaced: 0,
    g43Converted: 0,
    feedRatesFixed: 0,
    trailingZFixed: 0,
    g53Y0Added: 0,
    hOverRange: 0,
    totalLines: 0,
  };

  // The table out at the end of the program: the last M98 P7999 with nothing but comments and the
  // end codes after it.
  let end = -1;
  for (let k = input.length - 1; k >= 0; k--) {
    const c = bare(input[k]);
    if (TABLE_OUT.test(c)) {
      end = k;
      break;
    }
    if (c && !/^(?:M0*(?:30|2|5|9)(?![0-9])\s*)+$/i.test(c)) break;
  }

  // The tool's optional stop, taken off its comment line: written again right before the G43 line.
  let pendingStop = false;

  for (let index = 0; index < input.length; index++) {
    let line = input[index].trim();
    if (!line) continue;

    const o = line.match(/^O(\d+)(\s*)(\(.*\))?\s*$/i);
    if (o && !stats.oCodeRenamed) {
      stats.oCodeRenamed = true;
      // The file extension in brackets right after the number ("O0999784(X20)", as all 49 of the
      // shop's FANUC files) goes; a program name stays ("O01234 (ROD)").
      const ext = !o[2] && !!o[3] && /^\(\s*[A-Z0-9]{1,4}\s*\)$/i.test(o[3]);
      const name = o[3] && !ext ? ` ${o[3].trim()}` : '';
      const num = haasProgramNumber(o[1]);
      haasFilename = `O${num}.txt`;
      out.push(`O${num}${name}`);
      continue;
    }

    if (TABLE_OUT.test(codeOnly(line))) {
      stats.m98LinesDeleted++;
      out.push(index === end ? 'G0 G53 G49 Y0 Z0 M89' : 'G53 Y0');
      continue;
    }

    if (/^(N\d+\s+)?G0?0\s+G53\s+G49\s+Z0(?:\.0*)?\s+G94\s+M95$/i.test(line)) {
      stats.securityLinesReplaced++;
      out.push('G40 G17 G53 G49 G80 G90');
      continue;
    }

    // The tool's stop goes right before the first line that is not part of a part flip.
    if (pendingStop && !isFlipLine(line)) {
      out.push('M01 (CHECK TOOL)');
      pendingStop = false;
    }

    // Tool change, written either way round: "T12 M6", "M06 T12" or "M6T12".
    const toolCode = codeOnly(line);
    if (/(?<![A-Z])M0*6(?![0-9.])/i.test(toolCode) && /(?<![A-Z])T\d+/i.test(toolCode)) {
      lastToolNumber = toolCode.match(/(?<![A-Z])T(\d+)/i)![1].padStart(2, '0');
      // A G43 on the tool change line is split off and converted below, as on its own line.
      if (!/(?<![A-Z])G0*43(?![0-9.]).*H#513/i.test(toolCode)) {
        out.push(line);
        // "M01 (tool comment)" right after it: the comment stays where it is.
        const next = input[index + 1]?.trim() ?? '';
        if (/^(N\d+\s+)?M0?1\s*\(/i.test(next) && /^M0?1$/i.test(bare(next))) {
          out.push(next.replace(/^(N\d+\s+)?M0?1\s*/i, '$1'));
          pendingStop = true;
          index++;
        }
        continue;
      }
    }

    // An H the HAAS control cannot take stays (it alarms, where a valid wrong one would run): the remap sets it.
    if (/(?<![A-Z])G0*43(?![0-9.]).*H#513/i.test(codeOnly(line)) && !(Number(lastToolNumber) >= 1 && Number(lastToolNumber) <= 200)) stats.hOverRange++;
    // A feed approach ("G01 G43 Z5. H#513 D#513 M254 F500"): the block stays whole and only the
    // offset words change (split, the G00 G43 line would turn it and the moves after it into
    // rapids); its feed and Z get their dots below.
    if (/(?<![A-Z])G0*43(?![0-9.]).*H#513/i.test(codeOnly(line)) && /(?<![A-Z])G0*[123](?![0-9])/i.test(codeOnly(line))) {
      stats.g43Converted++;
      line = replaceInCode(replaceInCode(replaceInCode(line, /(?<![A-Z])H#513/i, `H${lastToolNumber}`), /\s*(?<![A-Z])D#513/i, ''), /\s*(?<![A-Z0-9])M254(?![0-9])/i, '');
    } else if (/(?<![A-Z])G0*43(?![0-9.]).*H#513/i.test(codeOnly(line))) {
      // FANUC G43 line -> HAAS
      stats.g43Converted++;
      const zMatch = codeOnly(line).match(/(?<![A-Z])Z[-+]?(?:\d+\.?\d*|\.\d+)/i);
      // No Z on the line: never "Z0." (a rapid down to the part top); the approach rapid after it.
      const z = zMatch ? zMatch[0] : nextRapidZ(input, index + 1);
      const zVal = /^Z[-+]?\d+$/i.test(z) ? `${z}.` : z;
      const hasCoolant = /(?<![A-Z])M0?8(?![0-9])/i.test(codeOnly(line));
      // Everything else on the FANUC block (G90, G54, X/Y position, S speed, M3 spindle...) goes on
      // its own block just before the G43 line, so no move or spindle start is lost.
      const otherWords = codeOnly(line)
        .replace(/^\s*N\d+/i, ' ')
        .replace(/(?<![A-Z])G0*43(?![0-9.])|(?<![A-Z])[HD]#?\d+|(?<![A-Z])M254(?![0-9])|(?<![A-Z])Z[-+]?\d*\.?\d*|(?<![A-Z])M0*8(?![0-9])/gi, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      // A lone G00 left over is the G43 line's own rapid ("G00 G43 Z.. H#513 ..."), not a block.
      if (otherWords.some((w) => !/^G0*0$/i.test(w))) {
        const needsRapid = !otherWords.some((w) => /^G0*[0-3]$/i.test(w)) && otherWords.some((w) => /^[XY]/i.test(w));
        out.push(`${needsRapid ? 'G00 ' : ''}${otherWords.join(' ')}`);
      }
      out.push(`G00 G43 H${lastToolNumber}${zVal ? ` ${zVal}` : ''}${hasCoolant ? ' M08' : ''}`);
      continue;
    }

    // Tapping: the HAAS files have no M84 on the G84 line.
    if (/(?<![A-Z])G84(?![0-9])/i.test(codeOnly(line))) line = replaceInCode(line, /\s*(?<![A-Z0-9])M84(?![0-9])/gi, '');

    // Whole-number feeds get their dot, in the code only (never "(PC-GF30)" in a comment).
    const fed = replaceInCode(line, /(?<![A-Z])F(\d+)(?![\d.])/gi, 'F$1.');
    if (fed !== line) stats.feedRatesFixed++;
    line = fed;

    // A Z ending the line gets its dot (Z50 -> Z50.).
    if (/(?<![A-Z])Z[-+]?\d+$/i.test(line)) {
      stats.trailingZFixed++;
      line = `${line}.`;
    }
    out.push(line);
  }
  if (pendingStop) out.push('M01 (CHECK TOOL)');

  const { lines: withG53, addedCount } = applyG53BeforeG52(out);
  stats.g53Y0Added = addedCount;
  const haasLines = ['%', ...numberLines(withG53), '%'];
  stats.totalLines = haasLines.length;
  return { haasCode: haasLines.join('\n'), haasFilename, stats };
}

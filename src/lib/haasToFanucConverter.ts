/**
 * HAAS to FANUC G-Code Converter
 * 
 * Reverses the FANUC-to-HAAS dialect transformation rules to generate compliant FANUC G-Code:
 * 1. Security line conversion: (G40 G17 G53 G49 G80 G90 -> G0 G53 G49 Z0 G94 M95). A bare end
 *    retract "G53 G49 Z0" becomes "G0 G53 G49 Z0" (M95 only once, at the start).
 * 2. G43 line conversion: (G00 G43 Hxx Z.. -> G00 G43 Z.. H#513 D#513 M254 [M08], the shop's order).
 *    A G43 line without Z takes the Z of the rapid right after it, never an invented one.
 * 3. Coolant consolidation: Merges standalone M08 into the G43 line
 * 4. M98 P7999 detection & removal (strictly deleted in FANUC)
 * 5. Decimal points: never removed; whole-number X/Y/Z get one (Z50 -> Z50.), FANUC reads them
 *    in thousandths of a mm otherwise. Other words keep their source form.
 * 7. G53 Y0 check: Only apply G53 Y0 when G52 is present in the code, placed right before G52
 * 8. Program wrapping: Ensures leading % and trailing % standard for FANUC controls
 * 9. O-Code preservation / formatting
 * 10. N numbers in steps of 1 (N1, N2...), as the shop's FANUC programs: steps of 10 reached 6
 *     digits in big programs.
 * 11. HAAS-only M89 (through-spindle coolant off) is removed: on a Robodrill it is an external output.
 * Every rule reads the code only, never the text of a (comment).
 */

import { addCoordinateDots, applyG53BeforeG52, codeOnly, replaceInCode } from './gcodeProcessor';

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

export function convertHaasToFanuc(haasCode: string, defaultFilename: string = 'fanuc_program.nc'): HaasToFanucResult {
  const rawLines = haasCode.split('\n');
  const fanucLines: string[] = [];
  let fanucFilename = defaultFilename.replace(/\.[^/.]+$/, '') + '.nc';
  let nNumber = 1;

  const stats = {
    oCodeFormatted: false,
    securityLinesReplaced: 0,
    g43Converted: 0,
    coolantMerged: 0,
    m98LinesDeleted: 0,
    g53Y0Added: 0,
    percentWrapped: false,
    totalLines: 0
  };

  // Step 1: Detect and format O-code
  for (let i = 0; i < Math.min(6, rawLines.length); i++) {
    const match = rawLines[i].trim().match(/^%?\s*O(\d+)/i);
    if (match) {
      const oNum = match[1];
      fanucFilename = `O${oNum}.nc`;
      stats.oCodeFormatted = true;
      break;
    }
  }

  // Pre-filter: remove empty edges or stand-alone % to cleanly re-wrap
  const filteredInput: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    if (line === '%') continue; // We will wrap with % properly
    filteredInput.push(rawLines[i]);
  }

  // Step 2: Line-by-line processing
  for (let i = 0; i < filteredInput.length; i++) {
    let line = filteredInput[i].trim();

    // Skip empty lines
    if (!line) {
      fanucLines.push('');
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
      continue; // Delete this line
    }

    // Rule: Security line replacement (HAAS -> FANUC)
    // Matches HAAS security lines like: G40 G17 G53 G49 G80 G90 or G00 G40 G17 G53 G49 G80 G90
    const isHaasSecurityLine = 
      /^(N\d+\s+)?(?:G0?0\s+)?G40\s+G17\s+G53\s+G49\s+G80\s+G90/i.test(code) ||
      (/G40/i.test(code) && /G17/i.test(code) && /G53/i.test(code) && /G49/i.test(code) && /G80/i.test(code) && /G90/i.test(code));

    // Also check for end-of-program retract like: G53 G49 Z0 or G00 G53 G49 Z0. before M30
    const isHaasRetractSecurity = /^(N\d+\s+)?(?:G0?0\s+)?G53\s+G49\s+Z0(?:\.0*)?$/i.test(code);

    if (isHaasSecurityLine || isHaasRetractSecurity) {
      stats.securityLinesReplaced++;
      // M95 belongs to the start of the program only; a retract elsewhere stays a plain retract.
      line = isHaasSecurityLine ? `N${nNumber} G0 G53 G49 Z0 G94 M95` : `N${nNumber} G0 G53 G49 Z0`;
      nNumber += 1;
      fanucLines.push(line);
      continue;
    }

    // Rule: G43 Height/Diameter offset conversion (HAAS -> FANUC)
    // HAAS: [N...] [G00] G43 H<num> Z<val> [M08]
    if (/\bG43\b.*H\d+/i.test(code)) {
      stats.g43Converted++;
      const zMatch = code.match(/Z[-+]?(?:\d+\.?\d*|\.\d+)/i);
      // No Z on the line: the Z of the rapid right after it (the approach), never an invented one.
      const zVal = zMatch ? zMatch[0] : nextRapidZ(filteredInput, i + 1);

      let hasCoolant = /\bM0?8\b/i.test(code);

      // Check if the next non-empty line is a standalone M08
      if (!hasCoolant && i + 1 < filteredInput.length) {
        const nextTrimmed = codeOnly(filteredInput[i + 1]).trim();
        if (/^(N\d+\s+)?M0?8$/i.test(nextTrimmed)) {
          hasCoolant = true;
          stats.coolantMerged++;
          i++; // Skip the standalone M08 line
        }
      }

      // Keep any other words of the HAAS block (X/Y position, spindle S/M3, feed...) on their own
      // block just before the G43 line, so no motion or spindle command is silently lost.
      const codePart = code;
      const otherWords = codePart
        .replace(/^\s*N\d+/i, ' ')
        .replace(/\bG0?0\b|\bG43\b|\bH\d+\b|\bZ[-+]?\d*\.?\d*|\bM0?8\b/gi, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (otherWords.length > 0) {
        const hadRapid = /\bG0?0\b/i.test(codePart);
        const hasMotionCode = otherWords.some(w => /^G0?[0-3]$/i.test(w));
        const needsRapid = hadRapid && !hasMotionCode && otherWords.some(w => /^[XY]/i.test(w));
        fanucLines.push(`N${nNumber} ${needsRapid ? 'G0 ' : ''}${otherWords.join(' ')}`);
        nNumber += 1;
      }

      const coolantSuffix = hasCoolant ? ' M08' : '';
      // G00 kept: the approach is a rapid even when the program is restarted at this tool.
      line = `N${nNumber} G00 G43${zVal ? ` ${zVal}` : ''} H#513 D#513 M254${coolantSuffix}`;
      nNumber += 1;
      fanucLines.push(line);
      continue;
    }

    // Standardize N-numbering if line starts with N\d+
    if (/^N\d+\s+/i.test(line)) {
      const withoutN = line.replace(/^N\d+\s+/i, '');
      line = `N${nNumber} ${withoutN}`;
      nNumber += 1;
    }

    fanucLines.push(line);
  }

  // Step 3: For G53 Y0, ensure G53 Y0 is ALWAYS written before G52 on all machines
  const isG52Regex = /(?<![A-Z_])G52(?![0-9])/i;
  const hasG52InCode = fanucLines.some(l => isG52Regex.test(l.split('(')[0]));

  let cleanedFanucLines = fanucLines;
  if (!hasG52InCode) {
    // If there is NO G52 in the entire program, remove any misplaced G53 Y0 lines that might have been carried over
    cleanedFanucLines = fanucLines.filter(l => {
      const codePart = l.split('(')[0].trim();
      return !/^\s*(N\d+\s*)?G53(?![0-9])\s*Y\s*0(?:\.0*)?\s*$/i.test(codePart);
    });
  }

  const { lines: withG53, addedCount: g53Added } = applyG53BeforeG52(cleanedFanucLines);
  const linesWithG53 = addCoordinateDots(withG53);
  stats.g53Y0Added = g53Added;

  // Step 4: Ensure FANUC % wrappers (start and end)
  const finalFanucLines: string[] = [];
  if (linesWithG53.length === 0 || linesWithG53[0].trim() !== '%') {
    finalFanucLines.push('%');
    stats.percentWrapped = true;
  }

  for (const l of linesWithG53) {
    finalFanucLines.push(l);
  }

  const lastLine = finalFanucLines[finalFanucLines.length - 1]?.trim();
  if (lastLine !== '%') {
    finalFanucLines.push('%');
    stats.percentWrapped = true;
  }

  stats.totalLines = finalFanucLines.length;

  return {
    fanucCode: finalFanucLines.join('\n'),
    fanucFilename,
    stats
  };
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

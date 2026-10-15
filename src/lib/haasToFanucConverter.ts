/**
 * HAAS to FANUC G-Code Converter
 * 
 * Reverses the FANUC-to-HAAS dialect transformation rules to generate compliant FANUC G-Code:
 * 1. Security line conversion: (G40 G17 G53 G49 G80 G90 -> G0 G53 G49 Z0 G94 M95)
 * 2. G43 line conversion: (G00 G43 Hxx Z.. -> G43 H#513 D#513 M254 Z.. [M08])
 * 3. Coolant consolidation: Merges standalone M08 into the G43 line
 * 4. M98 P7999 detection & removal (strictly deleted in FANUC)
 * 5. Feedrate integer formatting (F1200. -> F1200)
 * 6. Integer Z coordinate formatting (Z50. -> Z50)
 * 7. G53 Y0 check: Only apply G53 Y0 when G52 is present in the code, placed right before G52
 * 8. Program wrapping: Ensures leading % and trailing % standard for FANUC controls
 * 9. O-Code preservation / formatting
 */

import { applyG53BeforeG52 } from './gcodeProcessor';

export interface HaasToFanucResult {
  fanucCode: string;
  fanucFilename: string;
  stats: {
    oCodeFormatted: boolean;
    securityLinesReplaced: number;
    g43Converted: number;
    coolantMerged: number;
    feedRatesFixed: number;
    trailingZFixed: number;
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
  let nNumber = 10;

  const stats = {
    oCodeFormatted: false,
    securityLinesReplaced: 0,
    g43Converted: 0,
    coolantMerged: 0,
    feedRatesFixed: 0,
    trailingZFixed: 0,
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

    // Rule: In FANUC if the app detects M98 P7999 then it should be deleted
    if (/M98\s*P7999/i.test(line)) {
      stats.m98LinesDeleted++;
      continue; // Delete this line
    }

    // Rule: Security line replacement (HAAS -> FANUC)
    // Matches HAAS security lines like: G40 G17 G53 G49 G80 G90 or G00 G40 G17 G53 G49 G80 G90
    const isHaasSecurityLine = 
      /^(N\d+\s+)?(?:G0?0\s+)?G40\s+G17\s+G53\s+G49\s+G80\s+G90/i.test(line) ||
      (/G40/i.test(line) && /G17/i.test(line) && /G53/i.test(line) && /G49/i.test(line) && /G80/i.test(line) && /G90/i.test(line));

    // Also check for end-of-program retract like: G53 G49 Z0 or G00 G53 G49 Z0. before M30
    const isHaasRetractSecurity = /^(N\d+\s+)?(?:G0?0\s+)?G53\s+G49\s+Z0(?:\.0*)?$/i.test(line);

    if (isHaasSecurityLine || isHaasRetractSecurity) {
      stats.securityLinesReplaced++;
      line = `N${nNumber} G0 G53 G49 Z0 G94 M95`;
      nNumber += 10;
      fanucLines.push(line);
      continue;
    }

    // Rule: G43 Height/Diameter offset conversion (HAAS -> FANUC)
    // HAAS: [N...] [G00] G43 H<num> Z<val> [M08]
    if (/\bG43\b.*H\d+/i.test(line)) {
      stats.g43Converted++;
      const zMatch = line.match(/Z[-+]?\d+(?:\.\d*)?/i);
      let zVal = zMatch ? zMatch[0] : 'Z50';
      // Convert Z integer with dot: Z50. -> Z50
      if (zVal.endsWith('.')) {
        zVal = zVal.slice(0, -1);
      }

      let hasCoolant = /\bM0?8\b/i.test(line);

      // Check if the next non-empty line is a standalone M08
      if (!hasCoolant && i + 1 < filteredInput.length) {
        const nextTrimmed = filteredInput[i + 1].trim();
        if (/^(N\d+\s+)?M0?8$/i.test(nextTrimmed)) {
          hasCoolant = true;
          stats.coolantMerged++;
          i++; // Skip the standalone M08 line
        }
      }

      // Keep any other words of the HAAS block (X/Y position, spindle S/M3, feed...) on their own
      // block just before the G43 line, so no motion or spindle command is silently lost.
      const codePart = line.replace(/\([^)]*\)?/g, ' ');
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
        nNumber += 10;
      }

      const coolantSuffix = hasCoolant ? ' M08' : '';
      line = `N${nNumber} G43 H#513 D#513 M254 ${zVal}${coolantSuffix}`;
      nNumber += 10;
      fanucLines.push(line);
      continue;
    }

    // Rule: Fix Feedrate decimals (F1200. -> F1200)
    const fMatches = line.match(/F(\d+)\.(?!\d)/g);
    if (fMatches) {
      stats.feedRatesFixed += fMatches.length;
      line = line.replace(/F(\d+)\.(?!\d)/g, 'F$1');
    }

    // Rule: Fix trailing Z decimals (Z50. -> Z50)
    const zMatches = line.match(/(\bZ[-+]?\d+)\.(?!\d)/g);
    if (zMatches) {
      stats.trailingZFixed += zMatches.length;
      line = line.replace(/(\bZ[-+]?\d+)\.(?!\d)/g, '$1');
    }

    // Standardize N-numbering if line starts with N\d+
    if (/^N\d+\s+/i.test(line)) {
      const withoutN = line.replace(/^N\d+\s+/i, '');
      line = `N${nNumber} ${withoutN}`;
      nNumber += 10;
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

  const { lines: linesWithG53, addedCount: g53Added } = applyG53BeforeG52(cleanedFanucLines);
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

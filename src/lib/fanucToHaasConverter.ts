/**
 * Fanuc to HAAS (experimental) G-Code Converter
 * 
 * Implements dialect conversion rules from FANUC to HAAS CNC controls:
 * 1. O-Code renaming (last 4 digits)
 * 2. Rule 3: Drop M98 P7999 lines entirely
 * 3. Rule 1: Replace security line (G0 G53 G49 Z0 G94 M95 -> G40 G17 G53 G49 G80 G90)
 * 4. Tool change detection & tracking (Txx M6)
 * 5. G43 line conversion (G43 H#513 D#513 M254 -> G00 G43 Hxx Z..)
 * 6. Feed rate decimal formatting (Fxxx -> Fxxx.)
 * 7. First N-line removal
 * 8. Auto-numbering (N100, N110, ...)
 * 9. Rule 2: Trailing Z decimal fix (Z50 -> Z50.)
 */

import { applyG53BeforeG52 } from './gcodeProcessor';

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
    n100n110Deleted: number;
    g53Y0Added: number;
    totalLines: number;
  };
}

export function convertFanucToHaas(fanucCode: string, defaultFilename: string = 'haas_program.txt'): FanucToHaasResult {
  const lines = fanucCode.split('\n');
  const haasLines: string[] = [];
  let haasFilename = defaultFilename.endsWith('.txt') ? defaultFilename : `${defaultFilename.replace(/\.[^/.]+$/, '')}.txt`;
  let lastToolNumber = '';
  let nNumber = 100;
  let firstNLineRemoved = false;
  let toolAlreadyCalled = false;

  const stats = {
    oCodeRenamed: false,
    m98LinesDeleted: 0,
    securityLinesReplaced: 0,
    g43Converted: 0,
    feedRatesFixed: 0,
    trailingZFixed: 0,
    n100n110Deleted: 0,
    g53Y0Added: 0,
    totalLines: 0
  };

  // Step 1: Rename O-code in the first 5 lines
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const match = lines[i].trim().match(/^%?\s*O(\d{4,})/i);
    if (match) {
      const last4 = match[1].slice(-4);
      // Keep the program name comment, e.g. "O01203 (BRIDE ACIER)" -> "O1203 (BRIDE ACIER)".
      const comment = lines[i].match(/\(.*\)\s*$/)?.[0];
      lines[i] = comment ? `O${last4} ${comment.trim()}` : `O${last4}`;
      haasFilename = `O${last4}.txt`;
      stats.oCodeRenamed = true;
      break;
    }
  }

  // Step 2: Per-line processing
  lines.forEach(rawLine => {
    let line = rawLine.trim();

    // Rule 3 (delete M98 P7999 lines) — do this first as an early skip/continue
    if (/M98\s*P7999/i.test(line)) {
      stats.m98LinesDeleted++;
      return; // line does not appear at all in output
    }

    // Rule 1 (security line replacement)
    // FANUC: G0/G00 G53 G49 Z0/Z0. G94 M95 (with optional leading Nxxx)
    // Becomes: G40 G17 G53 G49 G80 G90
    const securityMatch = line.match(/^(N\d+\s+)?G0?0\s+G53\s+G49\s+Z0(?:\.0*)?\s+G94\s+M95$/i);
    if (securityMatch) {
      stats.securityLinesReplaced++;
      // Always replaced with the HAAS security line (also when it carries the first N number:
      // deleting it would leave the HAAS program without its safety line).
      if (securityMatch[1]) firstNLineRemoved = true;
      line = 'G40 G17 G53 G49 G80 G90';
    }

    // Detect and remember Txx M6
    const toolCode = line.replace(/\([^)]*\)?/g, ' ');
    if (/(?<![A-Z])M0*6(?![0-9.])/i.test(toolCode) && /(?<![A-Z])T\d+/i.test(toolCode)) {
      // Tool change written either way round: "T12 M6", "M06 T12" or "M6T12".
      const toolMatch = toolCode.match(/(?<![A-Z])T(\d+)/i);
      if (toolMatch) {
        lastToolNumber = toolMatch[1].padStart(2, '0');
        toolAlreadyCalled = true;
      }
    }

    // Convert FANUC G43 line
    if (/G43.*H#513.*D#513.*M254/i.test(line)) {
      stats.g43Converted++;
      const zMatch = line.match(/Z[-+]?\d+(\.\d+)?/i);
      const zVal = zMatch ? zMatch[0] : 'Z0.';
      const hasCoolant = /\bM0?8\b/i.test(line.split('(')[0]);

      if (!toolAlreadyCalled && lastToolNumber) {
        haasLines.push(`N${nNumber} T${lastToolNumber} M6`);
        nNumber += 10;
        toolAlreadyCalled = true;
      }

      // Everything else on the FANUC block (G90, G54, X/Y position, S speed, M3 spindle...) goes
      // on its own block just before the G43 line, so no move or spindle start is lost.
      const codePart = line.replace(/\([^)]*\)?/g, ' ');
      const otherWords = codePart
        .replace(/^\s*N\d+/i, ' ')
        .replace(/(?<![A-Z])G0*43(?![0-9.])|(?<![A-Z])[HD]#?\d+|(?<![A-Z])M254(?![0-9])|(?<![A-Z])Z[-+]?\d*\.?\d*|(?<![A-Z])M0*8(?![0-9])/gi, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (otherWords.length > 0) {
        const hasMotion = otherWords.some(w => /^G0*[0-3]$/i.test(w));
        const needsRapid = !hasMotion && otherWords.some(w => /^[XY]/i.test(w));
        haasLines.push(`N${nNumber} ${needsRapid ? 'G00 ' : ''}${otherWords.join(' ')}`);
        nNumber += 10;
      }

      haasLines.push(`N${nNumber} G00 G43 H${lastToolNumber} ${zVal}`);
      nNumber += 10;

      if (hasCoolant) {
        haasLines.push(`N${nNumber} M08`);
        nNumber += 10;
      }
      return; // Skip original line
    }

    // Fix F to F.
    const fMatches = line.match(/F(\d+)(?!\.)\b/g);
    if (fMatches) {
      stats.feedRatesFixed += fMatches.length;
      line = line.replace(/F(\d+)(?!\.)\b/g, 'F$1.');
    }

    // The very first N line is removed only when it holds no code, e.g. "N10 (PROGRAM NAME)".
    // A first N line with a real command (move, tool, spindle) is kept.
    if (!firstNLineRemoved && /^N\d+\s+/i.test(line)) {
      firstNLineRemoved = true;
      if (!line.replace(/^N\d+\s*/i, '').replace(/\([^)]*\)?/g, '').trim()) return;
    }

    // Program start/end marker stays alone on its line.
    if (line === '%') {
      haasLines.push(line);
      return;
    }

    // Add line number if missing
    if (!/^N\d+\s+/i.test(line) && line.length > 0) {
      line = `N${nNumber} ${line}`;
      nNumber += 10;
    }

    haasLines.push(line);
  });

  // Step 3: Rule 2 (trailing Z decimal fix)
  // Apply this last, as a final pass over the fully assembled output lines
  const finalHaasLines = haasLines.map(l => {
    const trimmed = l.trimEnd();
    if (/(\bZ[-+]?\d+)$/i.test(trimmed)) {
      stats.trailingZFixed++;
      return trimmed.replace(/(\bZ[-+]?\d+)$/i, '$1.');
    }
    return l;
  });

  // Step 4: Always delete N100 and N110 on the first 2 rows
  for (let r = 0; r < Math.min(2, finalHaasLines.length); r++) {
    const orig = finalHaasLines[r];
    const stripped = orig
      .replace(/^N100\s*/i, '')
      .replace(/^N110\s*/i, '')
      .replace(/\bN100\b\s*/gi, '')
      .replace(/\bN110\b\s*/gi, '')
      .trim();
    if (stripped !== orig) {
      stats.n100n110Deleted++;
      finalHaasLines[r] = stripped;
    }
  }

  // Step 5: For G53 Y0, ensure G53 Y0 is ALWAYS written before G52 on all machines
  const { lines: linesWithG53, addedCount: g53Added } = applyG53BeforeG52(finalHaasLines);
  stats.g53Y0Added = g53Added;
  stats.totalLines = linesWithG53.length;

  return {
    haasCode: linesWithG53.join('\n'),
    haasFilename,
    stats
  };
}

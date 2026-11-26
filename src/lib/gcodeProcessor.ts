import { Tool, ToolCategory, ToolChangeBlock, MATERIALS, Material } from '../types';
import { hasProgramMark } from './programMark';

export function detectMaterial(input: string): Material | undefined {
  if (typeof input !== 'string') return undefined;
  const limit = Math.min(input.split('\n').length, 50);
  const headerLines = input.split('\n').slice(0, limit).join('\n').toUpperCase();
  for (const m of MATERIALS) {
    const regex = new RegExp(`\\b${m}\\b`, 'i');
    if (regex.test(headerLines)) {
      return m;
    }
  }
  return undefined;
}

/** Brass (MS) as the program header names it: "MS58.ZN40B", "CUZN39PB3", "MESSING". */
export const BRASS_RE = /\b(MS|MS58|CUZN\w*|MESSING|BRASS)\b/;

/**
 * What the part's material needs (shop rule), read from the comments of the program's first lines
 * (the part line): FH, pressed wood, must stay dry (air only); aluminium, PC GF, brass and
 * stainless always need lubricant. POM, PEEK and anything else: null, either way.
 */
export function coolantNeed(code: string): 'air' | 'lubricant' | null {
  const head = code
    .split('\n')
    .slice(0, 12)
    .flatMap((l) => l.match(/\(([^)]*)\)/g) ?? [])
    .join(' ')
    .toUpperCase();
  const dry = /\bFH\b/.test(head);
  const wet = /\bALU(?:MINIUM)?\b|\bPC[\s-]?GF|\bINOX\b|\bVA\s?1\.4\d{3}\b|\b1\.4\d{3}\b/.test(head) || BRASS_RE.test(head);
  return dry === wet ? null : dry ? 'air' : 'lubricant';
}

/**
 * The air jet code each machine always uses (shop rule): air machines (HAAS-2, HAAS-4) turn the
 * auto air jet on (M83) wherever the program turns the coolant on (M08); the HAAS lubricant
 * machines (HAAS-1, HAAS-5) switch it off with M84 on the safety line. FANUC: nothing yet, their
 * programs use M84 only on tapping lines. Never inside a (comment); running it again changes nothing.
 */
export function applyMachineCoolant(lines: string[], machineId: string): string[] {
  if (machineId === 'HAAS-2' || machineId === 'HAAS-4') {
    return lines.map((l) => (l === '__REMOVE_ME__' ? l : replaceInCode(l, /(?<![A-Z0-9.])M0?8(?![0-9.])/gi, 'M83')));
  }
  if (machineId !== 'HAAS-1' && machineId !== 'HAAS-5') return lines;
  if (lines.some((l) => l !== '__REMOVE_ME__' && /(?<![A-Z0-9])M84(?![0-9])/i.test(codeOnly(l)))) return lines;
  const safety = lines.findIndex((l) => {
    const c = codeOnly(l);
    return l !== '__REMOVE_ME__' && /G40/i.test(c) && /G17/i.test(c) && /G53/i.test(c) && /G49/i.test(c) && /G80/i.test(c) && /G90/i.test(c) && !/(?<![A-Z])M\d/i.test(c);
  });
  if (safety !== -1) return lines.map((l, i) => (i === safety ? l.replace(/^(\s*[^(]*?)\s*(\(.*)?$/, (_w, code: string, c?: string) => `${code} M84${c ? ` ${c}` : ''}`) : l));
  // No safety line: on its own line right after the program number (or the leading %: a block
  // above it is not part of the program).
  const o = lines.findIndex((l) => /^\s*%?\s*O\d/i.test(l));
  const at = o !== -1 ? o + 1 : /^\s*%\s*$/.test(lines[0] ?? '') ? 1 : 0;
  return [...lines.slice(0, at), 'M84', ...lines.slice(at)];
}

/** Aluminium or brass part, from the program header. */
export function isAluOrBrass(code: string): boolean {
  const m = detectMaterial(code);
  return m === 'ALU' || (!m && BRASS_RE.test(code.split('\n').slice(0, 15).join('\n').toUpperCase()));
}

/**
 * FANUC-2 limits: the spindle never turns faster than S5000 (feeds unchanged), and in aluminium and
 * brass programs the peck of G83/G73 is always 2 mm. A value keeps its own notation (with or without
 * a dot). Macro and subprogram calls keep their Q (an argument there, not a peck).
 */
export function fanuc2Limits(lines: string[], aluOrBrass: boolean): string[] {
  const keepDot = (v: string, to: string) => to + (v.includes('.') ? '.' : '');
  return lines.map((l) => {
    if (l === '__REMOVE_ME__') return l;
    let out = replaceInCode(l, /(?<![A-Z])S(\d+\.?\d*|\.\d+)/gi, (w: string, v: string) => (Number(v) > 5000 ? keepDot(v, 'S5000') : w));
    const code = codeOnly(out);
    if (aluOrBrass && /(?<![A-Z])G(?:83|73)(?![0-9])/i.test(code) && !/(?<![A-Z])(?:G65|M98|M97)(?![0-9])/i.test(code)) {
      out = replaceInCode(out, /(?<![A-Z])Q(\d+\.?\d*|\.\d+)/gi, (_w: string, v: string) => keepDot(v, 'Q2'));
    }
    return out;
  });
}

/**
 * A program from the history as it is handed out again (History, Recent codes): the table comes out
 * before each flip and the end, and on FANUC-2 the spindle never over S5000 (a program exported before
 * that rule, or from a page not yet reloaded, was saved with its higher speeds); everything else stays
 * as it was exported. `engineId`: the record's machine, as regions.ts engineMachineId gives it.
 */
export function savedProgramFor(code: string, engineId: string): string {
  const { lines } = applyG53BeforeG52(code.split('\n'));
  return (engineId === 'FANUC-2' ? fanuc2Limits(lines, false) : lines).join('\n');
}

/** The simulator's corrected program as it is copied or downloaded: it may be the remapper's source, never processed, so FANUC-2's limits apply. */
export function simulatorProgramFor(code: string, engineId?: string): string {
  return engineId === 'FANUC-2' ? fanuc2Limits(code.split('\n'), isAluOrBrass(code)).join('\n') : code;
}

/**
 * FH (pressed wood) programs: a pass (Q, the peck of G83/G73) is never more than 5 mm. Macro and
 * subprogram calls keep their Q (an argument there, not a pass).
 */
export function fhPecks(lines: string[]): string[] {
  return lines.map((l) =>
    l === '__REMOVE_ME__' || /(?<![A-Z])(?:G65|M98|M97)(?![0-9])/i.test(codeOnly(l))
      ? l
      : replaceInCode(l, /(?<![A-Z])Q(\d+\.?\d*|\.\d+)/gi, (w: string, v: string) => (Number(v) > 5 ? 'Q5.' : w)),
  );
}

/**
 * Every FANUC machine (FANUC-2 included): whole-number X/Y/Z get their decimal point, and no N
 * number goes over N9999 (the shop's FANUC post repeats N9999 after it).
 */
export function fanucNumbers(lines: string[]): string[] {
  const labels = jumpsToLabels(lines); // a jump needs its label: no cap then
  return addCoordinateDots(lines).map((l) => (labels ? l : l.replace(/^(\s*)N(\d{5,})/i, (w, s: string, n: string) => (Number(n) > FANUC_MAX_N ? `${s}N${FANUC_MAX_N}` : w))));
}

/** The executable part of a line, with every (comment) removed. */
export function codeOnly(line: string): string {
  return line.replace(/\([^)]*\)?/g, ' ');
}

/** Applies a regex replacement to the code parts of a line only, never inside (comments). */
export function replaceInCode(line: string, pattern: RegExp, replacement: string | ((match: string, ...groups: string[]) => string)): string {
  let out = '';
  let replaced = false;
  const global = pattern.flags.includes('g');
  const re = /(\([^)]*\)?)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const doReplace = (segment: string) => {
    if (replaced && !global) return segment;
    const next = typeof replacement === 'string' ? segment.replace(pattern, replacement) : segment.replace(pattern, replacement);
    if (next !== segment) replaced = true;
    return next;
  };
  while ((m = re.exec(line))) {
    out += doReplace(line.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + doReplace(line.slice(last));
}

/**
 * FANUC reads a coordinate written without a decimal point in thousandths of a mm (Z-5 is
 * -0.005 mm), so every X, Y and Z that is a whole number gets its dot (Z-5 -> Z-5.). Values that
 * already have a dot, other words (F, S, Q, R...), macro values (X#1) and comments are never
 * touched, and no dot is ever removed. A machine-coordinate move to 0 stays as the shop writes it
 * ("G0 G53 G49 Z0 G94 M95", "G53 Y0"): 0 is 0 in any unit. Running it again changes nothing.
 */
export function addCoordinateDots(lines: string[]): string[] {
  return lines.map((l) => {
    if (l === '__REMOVE_ME__') return l;
    const machine = /(?<![A-Z_])G53(?![0-9])/i.test(codeOnly(l));
    return replaceInCode(l, /(?<![A-Z_#\]])([XYZ])(\s*[-+]?\d+)(?![\d.])/gi, (w: string, a: string, n: string) => (machine && Number(n) === 0 ? w : `${a}${n}.`));
  });
}

/** The program jumps to N labels (M97, M99 P, GOTO): its N numbers are jump targets and never change. */
export const jumpsToLabels = (lines: string[]) => lines.some((l) => l !== '__REMOVE_ME__' && /(?<![A-Z])(?:M97|M99\s*P|GOTO)/i.test(codeOnly(l)));

/**
 * N1, N2, N3... on every line but "%" and the O line, as the shop's programs are numbered. `cap`:
 * the highest N the control takes; the shop's FANUC files repeat N9999 from there on. A program
 * that jumps to labels keeps its numbers (renumbered, every jump would land on another block).
 */
export function numberLines(lines: string[], cap = Infinity): string[] {
  if (jumpsToLabels(lines)) return lines;
  let n = 0;
  return lines.map((l) => {
    const t = l.trim();
    if (l === '__REMOVE_ME__' || !t || t === '%' || /^O\d/i.test(t)) return l;
    n++;
    // Block delete: the slash stays first ("/N8 M00"), the control reads it only there.
    const slash = t.startsWith('/') ? '/' : '';
    return `${slash}N${Math.min(n, cap)} ${t.slice(slash.length).trimStart().replace(/^N\d+\s*/i, '')}`;
  });
}

/** The highest N number a FANUC control takes (the shop's FANUC post repeats N9999 after it). */
export const FANUC_MAX_N = 9999;

/** True when the line performs a tool change (M6 / M06 in the code, not in a comment). */
export function isToolChangeLine(line: string): boolean {
  if (line.trimStart().startsWith('(')) return false;
  return /(?<![A-Z])M0*6(?![0-9.])/i.test(codeOnly(line));
}

const PREFIX_TO_CATEGORY: Record<string, ToolCategory> = {
  ST: 'chanfrein',
  SB: 'foret',
  ZB: 'pointeur',
  GB: 'taraud',
  SF: 'fraise finition',
  SFH: 'fraise ebauche',
  KF: 'fraise boule',
  MK: 'tourteau',
  TF: 'fraise T',
  UDM: 'fraise rayon'
};

function getMaterialPriority(t: Tool, detectedMaterial: Material | undefined): number {
  if (!detectedMaterial) return 1; // If no material detected, everything is equal
  if (t.materials && t.materials.includes(detectedMaterial)) return 3; // Best priority
  if (!t.materials || t.materials.length === 0) return 2; // General priority
  return 1; // Tool is for a different material
}

export function analyzeGCode(input: string, tools: Tool[], machineId?: string): { success: boolean; blocks: ToolChangeBlock[]; lines: string[]; detectedMaterial?: Material } {
  const safeInput = typeof input === 'string' ? input : String(input || '');
  const detectedMaterial = detectMaterial(safeInput);
  const lines = safeInput.split('\n');
  const blocks: ToolChangeBlock[] = [];
  const processedIndices = new Set<number>();
  
  const toolChangeIndices: number[] = [];
  lines.forEach((line, i) => {
    // Tool change = M6/M06 in the executable part of the line (comments such as "(TARAUD M6)" are ignored)
    if (isToolChangeLine(line)) {
      toolChangeIndices.push(i);
    }
  });

  for (const idx of toolChangeIndices) {
    if (processedIndices.has(idx)) continue;

    // Look at previous line and a few next lines for the comment
    const start = Math.max(0, idx - 2);
    const end = Math.min(lines.length - 1, idx + 4);
    const contextLines = lines.slice(start, end + 1);
    const contextStr = contextLines.join(' ');
    // Diameter/length hints are read from the (comments) only, so words like "G41 D1" or "L5" in the code are not misread.
    const commentStr = (contextStr.match(/\([^)]*\)?/g) || []).join(' ');

    let parsedCategory: ToolCategory | null = null;
    let parsedDiameter: number | null = null;
    let parsedLength: number | null = null;

    // Advanced search for structured tool designation
    const designatorRegex = /([A-Z]{2,3})_(\d+\.\d+)_(\d+)_([A-Z0-9]+)_[A-Z]+/i;
    const designatorMatch = contextStr.match(designatorRegex);

    if (designatorMatch) {
      const prefix = designatorMatch[1].toUpperCase();
      parsedDiameter = parseFloat(designatorMatch[2]);
      parsedLength = parseFloat(designatorMatch[3]);
      if (PREFIX_TO_CATEGORY[prefix]) {
        parsedCategory = PREFIX_TO_CATEGORY[prefix];
        // Automatically make them fraise
        if (parsedCategory === 'fraise finition' || parsedCategory === 'fraise ebauche') {
           parsedCategory = 'fraise';
        }
      }
    }

    // Fallback standard feature extraction
    const dMatch = commentStr.match(/(?:D|DIAMETER|DIAMETRE\s*)[=:\s]?\s*(\d+(?:\.\d+)?)/i);
    const mmMatch = commentStr.match(/(\d+(?:\.\d+)?)\s*MM\b/i) || commentStr.match(/\b(?:ZENTRIE[R]?BOHRER|POINTEUR)\s*(\d+(?:\.\d+)?)/i);
    const lMatch = commentStr.match(/(?:L|LENGTH|LONGUEUR\s*)[=:\s]?\s*(\d+(?:\.\d+)?)/i);

    const d = parsedDiameter !== null ? parsedDiameter : (dMatch ? parseFloat(dMatch[1]) : (mmMatch ? parseFloat(mmMatch[1]) : null));
    const l = parsedLength !== null ? parsedLength : (lMatch ? parseFloat(lMatch[1]) : null);

    // Lookahead for min Z depth before next M6
    let minZDepth = 0;
    let nextIdx = lines.length;
    for (let cLine = idx + 1; cLine < lines.length; cLine++) {
      if (isToolChangeLine(lines[cLine])) {
        nextIdx = cLine;
        break;
      }
    }
    
    let hasG81SmallZ = false;
    let hasDeepZ = false;

    for (let cLine = idx; cLine < nextIdx; cLine++) {
      const gCodePart = codeOnly(lines[cLine]);
      // Accepts Z-10, Z-10., Z-.5 and Z.5
      const zMatch = gCodePart.match(/(?<![A-Z])Z\s*(-?\d*\.?\d+)/i);
      if (zMatch) {
         const zVal = parseFloat(zMatch[1]);
         if (zVal < minZDepth) minZDepth = zVal; 
         
         if (zVal < 0) {
            const absZ = Math.abs(zVal);
            if (/G81/i.test(gCodePart)) {
               if (absZ >= 0.1 && absZ <= 2.0) {
                  hasG81SmallZ = true;
               } else if (absZ > 2.0) {
                  hasDeepZ = true;
               }
            } else if (hasG81SmallZ && !/G8[0-9]/i.test(gCodePart)) {
               // Checking subsequent coordinates in the cycle
               if (absZ > 2.0) hasDeepZ = true;
            }
         }
      }
    }
    const requiredMinLength = Math.abs(minZDepth) + 1.0; // 1mm safety

    // Pointeur override logic
    // If the comment says 'foret' or parsed category is 'foret' but it matches the pointeur criteria
    let isForetContext = parsedCategory === 'foret' || /foret/i.test(contextStr);
    let forcePointeur = false;
    if (isForetContext && hasG81SmallZ && !hasDeepZ) {
       parsedCategory = 'pointeur';
       forcePointeur = true;
    }
    if (/NC-ANBOHREN/i.test(contextStr) || /ZENTRIE[R]?BOHR/i.test(contextStr)) {
       parsedCategory = 'pointeur';
       forcePointeur = true;
    }

    let bestExactTool: Tool | null = null;
    let exactMatPriority = -1;
    let maxScore = 0;
    
    let bestApproxTool: Tool | null = null;
    let minLengthDiff = Infinity;
    let approxMatPriority = -1;

    for (const t of tools) {
      if (t.category === 'empty') continue;

      const matPri = getMaterialPriority(t, detectedMaterial);

      let categoryMatches = false;

      const isFraiseCategory = (cat: string) => cat === 'fraise' || cat === 'fraise ebauche' || cat === 'fraise finition';

      if (parsedCategory) {
        if (t.category === parsedCategory) { 
          categoryMatches = true; 
        } else if (isFraiseCategory(t.category) && isFraiseCategory(parsedCategory)) {
          categoryMatches = true;
        }
      } else {
        if (contextStr.toLowerCase().includes(t.category.toLowerCase())) {
          categoryMatches = true;
        } else if (isFraiseCategory(t.category) && contextStr.toLowerCase().includes('fraise')) {
          categoryMatches = true;
        } else if (t.category === 'foret' && /bohrer|bohren|\bdrill\b/i.test(contextStr)) {
          categoryMatches = true;
        } else if (isFraiseCategory(t.category) && /fraeser|fräser|\bmill\b/i.test(contextStr)) {
          categoryMatches = true;
        } else if (t.category === 'taraud' && /gewinde|\btap\b/i.test(contextStr)) {
          categoryMatches = true;
        }
      }

      // If category doesn't match at all, skip
      if (!categoryMatches) {
        continue;
      }

      // If no attributes were extracted, we can't be confident
      if (d === null && l === null && !parsedCategory) {
        continue;
      }
      
      if (forcePointeur && t.category === 'pointeur') {
         if (!bestExactTool || matPri > exactMatPriority) {
            bestExactTool = t;
            exactMatPriority = matPri;
         }
         continue;
      }

      let diamExactMatch = true;
      let diamApproxMatches = true;

      if (d !== null) {
        if (Math.abs(t.diameter - d) < 0.001) { 
          diamExactMatch = true; 
          diamApproxMatches = true; 
        } else {
          diamExactMatch = false;
          if (t.category === 'foret') {
             let validApprox = false;
             
             if (d === 4.8) {
                validApprox = false; // 4.8 must be exact, handled above
             } else {
                // Rule: any foret with diameter less by a max of 0.2
                if (t.diameter < d && (d - t.diameter) <= 0.201) {
                   validApprox = true;
                }
                // Keep the specific exceptions we had for legacy cases
                if (d === 4.0 && (t.diameter === 4.1 || t.diameter === 4.2 || t.diameter === 4.3)) validApprox = true;
                if (d === 4.5 && (t.diameter === 4.2 || t.diameter === 4.3 || t.diameter === 4.4)) validApprox = true;
                if (d === 3.0 && t.diameter === 2.3) validApprox = true;
                if (d === 3.0 && (t.diameter === 2.9 || t.diameter === 2.96 || t.diameter === 3.1 || t.diameter === 3.2)) validApprox = true;
                if (d === 2.0 && (t.diameter === 1.9 || t.diameter === 1.97 || t.diameter === 2.1)) validApprox = true;
             }
             
             if (validApprox) {
                diamApproxMatches = true;
             } else {
                diamApproxMatches = false;
             }
          } else if (['pointeur', 'chanfrein', 'taraud', 'fraise boule', 'tourteau'].includes(t.category)) {
             // For these, diameter doesn't have to match exactly, we just pick closest later
             diamApproxMatches = true;
          } else {
             // For fraise, fraise ebauche, fraise finition... diameter MUST be exact
             diamApproxMatches = false;
          }
        }
      }

      let lenExactMatch = true;
      let lenApproxMatches = true;

      if (l !== null) {
        if (Math.abs(t.length - l) <= 0.05) { 
          lenExactMatch = true; 
        } else {
          lenExactMatch = false;
        }

        if (t.length >= requiredMinLength) {
          lenApproxMatches = true;
        } else {
          lenApproxMatches = false;
        }
      }

      // Exact match logic
      if (diamExactMatch && lenExactMatch) {
         if (!bestExactTool || matPri > exactMatPriority) {
           bestExactTool = t;
           exactMatPriority = matPri;
         }
      }
      
      // Approximate logic (Category must match, diameter rule respected, length valid)
      if (diamApproxMatches && lenApproxMatches) {
        let diff = 0;
        if (l !== null) diff += Math.abs(t.length - l);
        if (d !== null) diff += Math.abs(t.diameter - d) * 1000; // heavy penalty for diameter diff

        if (matPri > approxMatPriority || (matPri === approxMatPriority && diff < minLengthDiff)) {
           minLengthDiff = diff;
           bestApproxTool = t;
           approxMatPriority = matPri;
        }
      }
    }

    // The T word on the M6 line itself wins, then the lines just before it (T selects, M6 executes),
    // and only then the following lines. Comments are ignored, and a T already used by another block is skipped.
    let foundTLine = -1;
    let originalT: string | null = null;
    const searchOrder: number[] = [idx];
    for (let k = idx - 1; k >= start; k--) searchOrder.push(k);
    for (let k = idx + 1; k <= end; k++) searchOrder.push(k);
    for (const cLine of searchOrder) {
      if (processedIndices.has(cLine) && cLine !== idx) continue;
      const tMatch = codeOnly(lines[cLine]).match(/(?<![A-Z])T\d+/i);
      if (tMatch) {
        foundTLine = cLine;
        originalT = tMatch[0].toUpperCase();
        break;
      }
    }

    const tLineToUse = foundTLine !== -1 ? foundTLine : idx;
    
    const finalMatchedTool = bestExactTool || bestApproxTool;
    const zDepthError = finalMatchedTool ? (finalMatchedTool.length < Math.abs(minZDepth)) : false;

    blocks.push({
      blockId: `block-${tLineToUse}`,
      lineIndex: tLineToUse,
      originalT,
      originalLine: lines[tLineToUse],
      contextStr,
      parsedCategory,
      parsedDiameter: d,
      parsedLength: l,
      matchedTool: finalMatchedTool,
      matchType: bestExactTool ? 'exact' : (bestApproxTool ? 'approximate' : undefined),
      minZDepth,
      zDepthError
    });

    processedIndices.add(idx);
    if (foundTLine !== -1) processedIndices.add(foundTLine);
  }

  // Apply HAAS-1 specific rules for fraise D16
  if (machineId === 'HAAS-1') {
    const isFraiseCategory = (cat: string | null | undefined) => cat === 'fraise' || cat === 'fraise ebauche' || cat === 'fraise finition';
    const isFraise16 = (b: ToolChangeBlock) => {
      const catMatch = isFraiseCategory(b.parsedCategory) || (b.matchedTool && isFraiseCategory(b.matchedTool.category)) || /fraise/i.test(b.contextStr);
      // The text's "D16" or "16 MM" only when no Ø was read: a 16 mm long mill of another Ø is not the Ø16 one.
      const diamMatch = b.parsedDiameter === 16 || (b.matchedTool && b.matchedTool.diameter === 16) || (b.parsedDiameter === null && (/D16(?:\.0+)?\b/i.test(b.contextStr) || /16(?:\.0+)?\s*MM/i.test(b.contextStr)));
      return catMatch && diamMatch;
    };

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (isFraise16(block)) {
        const nextBlock = blocks[i + 1];
        
        const forceTool = (targetBlock: ToolChangeBlock, num: number, defaultCategory: ToolCategory) => {
          let t = tools.find((x: Tool) => x.number === num && x.category !== 'empty');
          if (!t) {
             t = { id: `auto-${num}`, number: num, category: defaultCategory, diameter: 16, length: 50, description: `Auto-assigned T${num}` };
          }
          targetBlock.matchedTool = t;
          targetBlock.matchType = 'exact';
        };

        if (nextBlock && isFraise16(nextBlock)) {
           // Followed by another fraise diam 16
           forceTool(block, 2, 'fraise ebauche');
           forceTool(nextBlock, 21, 'fraise finition');
           // Skip next block logic as it's already handled
           i++;
        } else {
           // Not followed by another one with diam 16
           forceTool(block, 21, 'fraise finition');
        }
      }
    }
  }

  // Apply HAAS-2, HAAS-4, and HAAS-5 ZENTRIEBOHRER rule
  if (machineId && ['HAAS-2', 'HAAS-4', 'HAAS-5'].includes(machineId)) {
    // Only look for tools named as Pointeur to be used
    const pointeurTools = tools.filter(t => 
      t.category !== 'empty' && 
      (t.category.toLowerCase() === 'pointeur' || t.description.toLowerCase().includes('pointeur'))
    );

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const isZentriebohrer = /ZENTRIE[R]?BOHR/i.test(block.contextStr) || /ZENTRIE[R]?BOHR/i.test(block.originalLine);
      if (isZentriebohrer) {
        block.parsedCategory = 'pointeur';
        if (pointeurTools.length === 1) {
          // If there is only 1 pointeur in the machine use it, regardless of length
          block.matchedTool = pointeurTools[0];
          block.matchType = (block.parsedDiameter !== null && Math.abs(pointeurTools[0].diameter - block.parsedDiameter) < 0.001) ? 'exact' : 'approximate';
          block.zDepthError = false;
        } else if (pointeurTools.length > 1) {
          // Multiple pointeurs: look for the tool with the closest diameter, regardless of length
          let bestPointeur = pointeurTools[0];
          let minDiff = Infinity;
          const targetDiam = block.parsedDiameter !== null ? block.parsedDiameter : bestPointeur.diameter;
          for (const pt of pointeurTools) {
            const diff = Math.abs(pt.diameter - targetDiam);
            if (diff < minDiff) {
              minDiff = diff;
              bestPointeur = pt;
            }
          }
          block.matchedTool = bestPointeur;
          block.matchType = (block.parsedDiameter !== null && minDiff < 0.001) ? 'exact' : 'approximate';
          block.zDepthError = false;
        } else {
          // 0 pointeurs in the machine
          block.matchedTool = null;
          block.matchType = undefined;
          block.zDepthError = false;
        }
      }
    }
  }

  // The shop's spot drill number: T4 on HAAS-1, T250550 on the FANUCs. Only when the machine has that
  // tool and it is a pointeur (never invented, never its end mill); every other machine, and these
  // without it, pick their spot drill like any other tool (or the dialog asks).
  const pointeurNumber = machineId === 'HAAS-1' ? 4 : machineId?.startsWith('FANUC') ? 250550 : null;
  const shopPointeur = tools.find((x: Tool) => x.number === pointeurNumber && x.category === 'pointeur');
  for (let i = 0; i < blocks.length && shopPointeur; i++) {
    const block = blocks[i];
    const isPointeur = block.parsedCategory === 'pointeur' || /pointeur|ZENTRIERBOHREN|CENTER\s*DRILL/i.test(block.contextStr) || (block.matchedTool && block.matchedTool.category === 'pointeur');
    if (isPointeur) {
      block.matchedTool = shopPointeur;
      block.matchType = 'exact';
    }
  }

  // Apply taraud rule
  if (machineId?.includes('FANUC')) {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const isTaraud = block.parsedCategory === 'taraud' || /taraud/i.test(block.contextStr) || (block.matchedTool && block.matchedTool.category === 'taraud');
      if (isTaraud) {
        const commentsOnly = (block.contextStr.match(/\(.*?\)/g) || []).join(' ');
        const mSizeMatch = commentsOnly.match(/\bM(\d+(?:\.\d+)?)\b/i);
        const reqMSize = mSizeMatch ? parseFloat(mSizeMatch[1]) : null;

        let isDiam6 = false;
        if (reqMSize !== null) {
            isDiam6 = reqMSize === 6;
        } else if (block.parsedDiameter !== null) {
            isDiam6 = block.parsedDiameter === 6;
        } else {
            isDiam6 = /D6(?:\.0+)?\b/i.test(block.contextStr) || /6(?:\.0+)?\s*MM/i.test(block.contextStr) || !!(block.matchedTool && block.matchedTool.diameter === 6);
        }

        if (isDiam6) {
          let t27 = tools.find((x: Tool) => x.number === 27);
          if (!t27) {
             t27 = { id: `auto-27`, number: 27, category: 'taraud', diameter: 6, length: 50, description: `Auto-assigned T27` };
          }
          block.matchedTool = t27;
          block.matchType = 'exact';
        } else {
          block.pendingSkipConfirmation = true;
          block.matchedTool = null;
          block.matchType = undefined;
        }
      }
    }
  }

  // Apply HAAS taraud exception rule
  if (machineId?.includes('HAAS')) {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const isTaraud = block.parsedCategory === 'taraud' || 
                       /taraud|GB_|taraudage|\btap\b/i.test(block.contextStr) || 
                       /taraud/i.test(block.originalLine) || 
                       (block.matchedTool && block.matchedTool.category === 'taraud');
      if (isTaraud) {
        block.isHaasTaraudException = true;
        block.taraudException = true;
        block.matchedTool = null;
        block.matchType = undefined;
      }
    }
  }

  // CAM AI plans with the machine's own tools and simulates them: a tool change whose T number is that
  // machine's tool of the same kind and Ø keeps it (the rules above give other programs' tools the
  // machine's numbers), so Send gives the numbers CAM AI's Download gives.
  if (hasProgramMark(safeInput)) {
    const mill = (c: string | null | undefined) => c === 'fraise' || c === 'fraise ebauche' || c === 'fraise finition';
    for (const block of blocks) {
      const n = Number(block.originalT?.match(/\d+/)?.[0] ?? NaN);
      const own = tools.find((x) => x.number === n && x.category !== 'empty');
      if (!own || block.parsedDiameter === null || Math.abs(own.diameter - block.parsedDiameter) >= 0.01) continue;
      if (own.category !== block.parsedCategory && !(mill(own.category) && mill(block.parsedCategory))) continue;
      block.matchedTool = own;
      block.matchType = 'exact';
    }
  }

  const hasUnresolved = blocks.some(b => (!b.skipOperation && !b.matchedTool) || b.pendingSkipConfirmation || b.isHaasTaraudException);

  return {
    success: !hasUnresolved,
    blocks,
    lines,
    detectedMaterial
  };
}

export function generateRemappedCode(lines: string[], blocks: ToolChangeBlock[], resolutions: Record<string, Tool>, machineId?: string): { finalCode: string, addedFanucOffsets: boolean } {
  let outputLines = [...lines];
  let addedFanucOffsets = false;
  
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const nextBlockIndex = i + 1 < blocks.length ? blocks[i + 1].lineIndex : outputLines.length;

    if (block.skipOperation || (resolutions[block.blockId] && resolutions[block.blockId].category === 'empty' && resolutions[block.blockId].description === 'Skip Operation')) {
      // From the tool change up to the next one; the last tool up to the end-of-program codes,
      // which stay (spindle and coolant off, retract, M30). Part flips in the section (M0 notes,
      // G52 shift) stay too: the next tools are set up by them.
      const end = i + 1 < blocks.length ? nextBlockIndex : Math.max(block.lineIndex + 1, endCodesStart(outputLines));
      let flip = false;
      let tableOut = false;
      for (let j = block.lineIndex + 1; j < end; j++) {
        if (hasG53Y0(outputLines[j], machineId !== 'FANUC-2')) tableOut = true;
        else if (isPartSetup(outputLines[j])) flip = true;
        else outputLines[j] = '__REMOVE_ME__';
      }
      // The table still comes to the operator before a flip kept from the section: the tool change
      // line becomes "G53 Y0" (keeping its N number).
      outputLines[block.lineIndex] = flip && !tableOut ? `${codeOnly(outputLines[block.lineIndex]).match(N_RE)?.[0].trim() ?? ''} G53 Y0`.trim() : '__REMOVE_ME__';
      // The tool's pre-staging call ("T27" alone, before its M6) goes with it.
      const t = block.originalT?.match(/\d+/)?.[0];
      if (t) {
        for (let j = i > 0 ? blocks[i - 1].lineIndex + 1 : 0; j < block.lineIndex; j++) {
          if (new RegExp(`^T0*${Number(t)}$`, 'i').test(bareCode(outputLines[j]))) outputLines[j] = '__REMOVE_ME__';
        }
      }
      continue;
    }

    const toolToUse = resolutions[block.blockId] || block.matchedTool;
    if (toolToUse) {
      const isApprox = block.matchType === 'approximate' && !resolutions[block.blockId];
      const remapTypeStr = resolutions[block.blockId] ? 'MANUAL-REMAP' : (isApprox ? 'APPROX-REMAP' : 'AUTO-REMAP');
      
      if (block.originalT) {
        // Replace existing T Number
        const newLine = replaceInCode(block.originalLine, /(?<![A-Z])T\d+/i, `T${toolToUse.number}`);
        outputLines[block.lineIndex] = newLine + ` (${remapTypeStr}: T${toolToUse.number} ${toolToUse.category})`;
      } else {
        // Prepend T number to M6 line
        outputLines[block.lineIndex] = replaceInCode(block.originalLine, /(?<![A-Z])M0*6(?![0-9.])/i, `T${toolToUse.number} M6`) + ` (${remapTypeStr}: T${toolToUse.number} ${toolToUse.category})`;
      }

      // FANUC-2 runs the HAAS code: plain H<tool> offsets, never H#513 D#513.
      const isFanuc = machineId && machineId.startsWith('FANUC') && machineId !== 'FANUC-2';
      const isPureCommentLine = (l: string) => /^(N\d+\s*)?\(.*?\)\s*$/i.test(l.trim());

      if (isFanuc) {
        let foundOffsets = false;
        let insertIndex = -1;

        for (let j = block.lineIndex; j < nextBlockIndex; j++) {
          if (outputLines[j] === '__REMOVE_ME__' || isPureCommentLine(outputLines[j])) continue;
          
          const code = codeOnly(outputLines[j]);
          if (/H#513/i.test(code) && /D#513/i.test(code)) {
            foundOffsets = true;
            break;
          }
          
          if (insertIndex === -1 && /G43/i.test(code)) {
            insertIndex = j;
          } else if (insertIndex === -1 && /(?<![A-Z])H\d+/i.test(code)) {
            insertIndex = j;
          }
        }

        if (!foundOffsets) {
          addedFanucOffsets = true;
          if (insertIndex === -1) {
             // find first valid line after original toolchange (that isn't a comment block)
             for (let j = block.lineIndex + 1; j < nextBlockIndex; j++) {
               if (outputLines[j] !== '__REMOVE_ME__' && !isPureCommentLine(outputLines[j]) && !outputLines[j].trim().startsWith('O')) {
                 insertIndex = j;
                 break;
               }
             }
          }
          
          if (insertIndex !== -1) {
             const target = outputLines[insertIndex];
             const offsetWord = /(?<![A-Z])(?:H[#\d][^\s(]*(\s+D[#\d][^\s(]*)?|D[#\d][^\s(]*(\s+H[#\d][^\s(]*)?)/i;
             if (offsetWord.test(codeOnly(target))) {
               // Replace the existing H/D words in the code (comments are left untouched)
               outputLines[insertIndex] = replaceInCode(target, offsetWord, 'H#513 D#513') + ' (AI-MOD: FANUC OFFSETS)';
             } else {
               const commentAt = target.indexOf('(');
               outputLines[insertIndex] = commentAt === -1
                 ? target + ' H#513 D#513 (AI-MOD: FANUC OFFSETS)'
                 : target.slice(0, commentAt).trimEnd() + ' H#513 D#513 ' + target.slice(commentAt) + ' (AI-MOD: FANUC OFFSETS)';
             }
          }
        }
      } else {
        // Look for the closest H after this tool change and replace it
        for (let j = block.lineIndex; j < nextBlockIndex; j++) {
          // Ignore lines that are comments
          if (outputLines[j] !== '__REMOVE_ME__' && !isPureCommentLine(outputLines[j])) {
            const codePart = codeOnly(outputLines[j]);
            // FANUC offsets (H#513 D#513 M254) on a HAAS-style machine: the plain tool offset.
            if (/(?<![A-Z])H#513/i.test(codePart)) {
              const l = replaceInCode(outputLines[j], /(?<![A-Z])H#513(?:\s+D#513)?/i, `H${toolToUse.number}`);
              outputLines[j] = replaceInCode(l, /\s*(?<![A-Z0-9])M254(?![0-9.])/i, '') + ` (AI-MOD: OFFSET H${toolToUse.number})`;
              break;
            }
            if (/(?<![A-Z])H\d+/i.test(codePart)) {
              outputLines[j] = replaceInCode(outputLines[j], /(?<![A-Z])H\d+/i, `H${toolToUse.number}`) + ` (AI-MOD: OFFSET H${toolToUse.number})`;
              break; 
            }
          }
        }
        // Cutter compensation follows the tool too: "G41 D7" of the old T7 becomes D<new tool>.
        // A D that is not the old tool's number was chosen on purpose and stays.
        const oldT = block.originalT?.match(/\d+/)?.[0];
        if (oldT && Number(oldT) !== Number(toolToUse.number)) {
          // So does every later length offset of the section ("G43 H18" again after a G49): an H
          // of another register stays.
          const hOld = new RegExp(`(?<![A-Z])H0*${Number(oldT)}(?![0-9.])`, 'i');
          for (let j = block.lineIndex + 1; j < nextBlockIndex; j++) {
            const l = outputLines[j];
            if (l === '__REMOVE_ME__' || !/(?<![A-Z])G0*4[34](?![0-9])/i.test(codeOnly(l)) || !hOld.test(codeOnly(l))) continue;
            outputLines[j] = replaceInCode(l, hOld, `H${toolToUse.number}`) + ` (AI-MOD: OFFSET H${toolToUse.number})`;
          }
          const dOld = new RegExp(`(?<![A-Z])D0*${Number(oldT)}(?![0-9.])`, 'i');
          for (let j = block.lineIndex + 1; j < nextBlockIndex; j++) {
            const l = outputLines[j];
            if (l === '__REMOVE_ME__' || !/(?<![A-Z])G4[12](?![0-9])/i.test(codeOnly(l)) || !dOld.test(codeOnly(l))) continue;
            outputLines[j] = replaceInCode(l, dOld, `D${toolToUse.number}`) + ` (AI-MOD: D${toolToUse.number})`;
          }
        }
      }
    } else {
      // Still unresolved for whatever reason
      outputLines[block.lineIndex] = block.originalLine + ` (ATTENTION: PAS D'OUTIL DEFINI)`;
    }
  }

  // Taps: the spindle starts with the tapping cycle ("G84 ... S400 M03"), not on the move before it.
  // Only when the cycle line has its own speed (else the tap would turn at the tool before's speed).
  blocks.forEach((block, b) => {
    const tool = resolutions[block.blockId] || block.matchedTool;
    if (!(block.parsedCategory === 'taraud' || tool?.category === 'taraud' || /taraud|GEWINDE|\bGB_/i.test(block.contextStr))) return;
    const end = b + 1 < blocks.length ? blocks[b + 1].lineIndex : outputLines.length;
    const lines = Array.from({ length: end - block.lineIndex }, (_, n) => block.lineIndex + n).filter((j) => outputLines[j] !== '__REMOVE_ME__');
    const speedWord = /\s*(?<![A-Z])S\d+\.?\d*\s+M0?3(?![0-9.])/i;
    if (!lines.some((j) => /(?<![A-Z])G84(?![0-9])/i.test(codeOnly(outputLines[j])) && /(?<![A-Z])S\d/i.test(codeOnly(outputLines[j])))) return;
    for (const j of lines) {
      const code = codeOnly(outputLines[j]);
      if (/(?<![A-Z])G84(?![0-9])/i.test(code) || !speedWord.test(code)) continue;
      const l = replaceInCode(outputLines[j], speedWord, '');
      outputLines[j] = /^\s*(N\d+)?\s*$/i.test(l) ? '__REMOVE_ME__' : l;
    }
  });

  // FANUC-2 only: cancel the tool length offset right on the tool change line ("T3 M6 G49").
  if (machineId === 'FANUC-2') {
    outputLines = addG49AfterM6(outputLines);
    outputLines = fanuc2Limits(outputLines, isAluOrBrass(lines.join('\n')));
  }

  // HAAS-2 and HAAS-4 cool with air, not coolant: M08 (or M8) becomes M83; HAAS-1 and HAAS-5 run
  // lubricant: M84 (air jet off) on the safety line.
  outputLines = applyMachineCoolant(outputLines, machineId ?? '');

  if (detectMaterial(lines.join('\n')) === 'FH') outputLines = fhPecks(outputLines);

  // In FANUC, if the app detects M98 P7999 then it should be deleted (code only, never a comment).
  // The shop's machines have no O7999: the table comes out with G53 Y0 right there instead (the
  // shop's FANUC files call O7999 exactly where their HAAS twins have G53 Y0), N number kept.
  const isFanuc = machineId !== 'FANUC-2' && ((machineId && machineId.toUpperCase().includes('FANUC')) ||
                  outputLines.some(l => l !== '__REMOVE_ME__' && /H#513|M95|M254/i.test(codeOnly(l))));
  if (isFanuc) {
    outputLines = outputLines.map(l => {
      if (l === '__REMOVE_ME__' || !/M98\s*P7999/i.test(codeOnly(l))) return l;
      const n = l.match(/^\s*N\d+/i)?.[0].trim();
      return n ? `${n} G53 Y0` : 'G53 Y0';
    });
  }

  // FANUC machines that take the FANUC dialect: the HAAS-only M89 (through-spindle coolant off)
  // is a Robodrill external output, so it is removed (FANUC-2 runs HAAS code and keeps it).
  if (machineId && machineId.toUpperCase().startsWith('FANUC') && machineId !== 'FANUC-2') {
    outputLines = outputLines.map((l) => {
      if (l === '__REMOVE_ME__' || !/(?<![A-Z0-9])M89(?![0-9.])/i.test(codeOnly(l))) return l;
      const rest = replaceInCode(l, /\s*(?<![A-Z0-9])M89(?![0-9.])/gi, '');
      return bareCode(rest) === '' && !/\(/.test(rest) ? '__REMOVE_ME__' : rest;
    });
  }

  // Bring the table to the operator only where they need it: before each part flip (G52)
  // and before the end of the program (to unload the parts). Not at every tool change.
  const { lines: linesWithG53 } = applyG53BeforeG52(outputLines, machineId !== 'FANUC-2');
  outputLines = linesWithG53;

  if (machineId?.toUpperCase().startsWith('FANUC')) outputLines = fanucNumbers(outputLines);

  return {
    finalCode: outputLines.filter(l => l !== '__REMOVE_ME__').join('\n'),
    addedFanucOffsets
  };
}

// ---------------------------------------------------------------------------------------------
// G53 Y0: bring the table to the operator
// ---------------------------------------------------------------------------------------------
//
// "G53 Y0" moves the table to the machine Y0 position (close to the door). It belongs right
// after the tool change, under the tool's comment block and BEFORE the operator stops (M0) and
// the work-offset shift (G52) that tells the operator to turn the part, e.g.:
//
//   N6181 T13 M6
//   N6182 (MESSERKOPF D93 / MK_93.00_030_000_KS)
//   N6183 (DIAMETER 93.00 MM/LENGTH 30.00 MM)
//   N6184 G53 Y0                                  <-- here
//   N6185 M0 (TEIL 180 GRAD UM X DREHEN/)
//   N6186 M0 (36 MM UNTERLAGE/IN 10.5 MM)
//   N6187 G52 X-50.000 Y50.000 Z-10.500
//
// It is also placed right before the end of the program (M30 / M02) so the operator can take the
// parts out. It is NOT added at other tool changes.
//
// When a line is inserted it gets the next N number, and the following N numbers are shifted
// by one where they would otherwise collide, so every N stays unique and in order.

const REMOVED_LINE = '__REMOVE_ME__';
const G53_Y0_RE = /(?<![A-Z_])G53(?![0-9])\s*Y\s*0(?:\.0*)?(?![0-9.])/i;
const G52_RE = /(?<![A-Z_])G52(?![0-9])/i;
const N_RE = /^(\s*)N(\d+)/i;

interface Entry { text: string; inserted: boolean }

const isRemoved = (l: string) => l === REMOVED_LINE;
/**
 * The table comes to the operator here: "G53 Y0", or "M98 P7999" in the shop's FANUC files (their
 * HAAS twins have G53 Y0 at exactly those places), so a FANUC program is not given a second one.
 * `call` false: the O7999 call does not count (FANUC-2 keeps it and gets its G53 Y0 all the same).
 */
const hasG53Y0 = (l: string, call = true) => !isRemoved(l) && (G53_Y0_RE.test(codeOnly(l)) || (call && /(?<![A-Z])M98\s*P7999(?![0-9])/i.test(codeOnly(l))));
const hasG52 = (l: string) => !isRemoved(l) && G52_RE.test(codeOnly(l));
/** A G53 line that moves Y to 0 among other words ("G0 G53 G49 Y0 Z0"). */
const hasG53WithY0 = (l: string) =>
  !isRemoved(l) && /(?<![A-Z_])G53(?![0-9])/i.test(codeOnly(l)) && /(?<![A-Z])Y\s*0(?:\.0*)?(?![0-9.])/i.test(codeOnly(l));
/** A G52 that moves the work offset (part flip / new face). "G52 X0 Y0 Z0" only cancels it. */
const isG52Shift = (l: string) => {
  if (!hasG52(l)) return false;
  const words = bareCode(l).match(/(?<![A-Z])[XYZABC]\s*[-+]?(?:\d+\.?\d*|\.\d+)/gi) || ([] as string[]);
  return words.some(w => Math.abs(parseFloat(w.slice(1).replace(/\s+/g, ''))) > 1e-9);
};
const isProgramEnd = (l: string) => !isRemoved(l) && /(?<![A-Z])M0*(?:30|2)(?![0-9.])/i.test(bareCode(l));
/** The code of a line without comments and without its N number. */
const bareCode = (l: string) => codeOnly(l).replace(N_RE, '').trim();
const isCommentOrBlank = (l: string) => isRemoved(l) || bareCode(l) === '';
/** M0 / M00 / M01 operator stops (alone on their line). */
const isOperatorStop = (l: string) => /^(?:M0*[01](?![0-9])\s*)+$/i.test(bareCode(l));
/** Part flip lines (operator stops with their notes, G52 shift): kept when a tool's section is deleted. */
const isPartSetup = (l: string) => isG52Shift(l) || /^M0*0(?![0-9.])/i.test(bareCode(l));
/** Cutting, spindle or tool words: a line with them is not part of the end-of-program codes. */
const NOT_END_CODE = /(?<![A-Z])(?:G0*[123]|G7[346]|G8[1-9])(?![0-9])|(?<![A-Z])[ST]\s*\d|(?<![A-Z])M0*[34](?![0-9.])/i;
/**
 * Where the end-of-program codes start: the lines right before (and including) M30/M02 that do not
 * cut, start the spindle, move in work coordinates or change tool (M05, M09, G80, G53 retracts,
 * G53 Y0, M30, %...). The program length when it has no end.
 */
function endCodesStart(lines: string[]): number {
  let k = -1;
  for (let j = lines.length - 1; j >= 0; j--) if (isProgramEnd(lines[j])) { k = j; break; }
  if (k === -1) return lines.length;
  const isEndCode = (l: string) =>
    isRemoved(l) || (!isToolChangeLine(l) && !(isMotionLine(l) && !/(?<![A-Z])G(?:28|30)(?![0-9])/i.test(bareCode(l))) && !NOT_END_CODE.test(bareCode(l)));
  while (k > 0 && isEndCode(lines[k - 1])) k--;
  return k;
}
/** True when the line moves an axis (G52/G53/G10/G92 lines only set coordinates or are G53 itself). */
const isMotionLine = (l: string) => {
  if (isRemoved(l)) return false;
  const code = bareCode(l);
  if (!/(?<![A-Z])[XYZABC]\s*[-+.#\d]/i.test(code)) return false;
  return !/(?<![A-Z_])G(?:52|53|10|92)(?![0-9])/i.test(code);
};

/** Index of the first line after the tool change line and the comment block that follows it. */
function afterToolCommentBlock(lines: string[], m6Idx: number): number {
  let k = m6Idx + 1;
  while (k < lines.length && isCommentOrBlank(lines[k])) k++;
  // Don't place it behind trailing removed lines; put it right after the last real comment.
  while (k - 1 > m6Idx && isRemoved(lines[k - 1])) k--;
  return k;
}

/**
 * Writes the final lines. Inserted lines get "N<previous + 1>" (when the program uses N numbers)
 * and following N numbers are shifted while they would collide. When the program jumps to N
 * labels (M97 / M99 P / GOTO), existing numbers are never changed.
 */
function renumberWithInsertions(entries: Entry[]): string[] {
  const real = entries.filter(e => !e.inserted && !isRemoved(e.text)).map(e => e.text);
  const usesN = real.some(l => N_RE.test(l));
  const jumps = jumpsToLabels(real);
  const usedNumbers = new Set(real.map(l => l.match(N_RE)?.[2]).filter(Boolean).map(Number));

  const format = (orig: string, value: number) => orig.startsWith('0') ? String(value).padStart(orig.length, '0') : String(value);

  const out: string[] = [];
  let lastOut: number | null = null; // last N written
  let lastIn: number | null = null;  // last N that was in the original program
  let lastDigits = '';

  for (const e of entries) {
    if (isRemoved(e.text)) { out.push(e.text); continue; }
    if (e.inserted) {
      let text = e.text;
      if (usesN) {
        const candidate = (lastOut ?? 0) + 1;
        if (!jumps || !usedNumbers.has(candidate)) {
          text = `N${format(lastDigits, candidate)} ${e.text}`;
          lastOut = candidate;
          usedNumbers.add(candidate);
        }
      }
      out.push(text);
      continue;
    }
    const m = e.text.match(N_RE);
    if (!m) { out.push(e.text); continue; }
    const value = parseInt(m[2], 10);
    let emitted = value;
    if (!jumps && lastOut !== null && value <= lastOut && (lastIn === null || value > lastIn)) {
      emitted = lastOut + 1; // was in order, but now collides with an inserted number
    }
    out.push(emitted === value ? e.text : e.text.replace(N_RE, `$1N${format(m[2], emitted)}`));
    lastIn = value;
    lastOut = emitted;
    lastDigits = m[2];
  }
  return out;
}

function insertBefore(lines: string[], positions: number[]): string[] {
  const at = new Map<number, number>();
  for (const p of positions) at.set(p, (at.get(p) || 0) + 1);
  const entries: Entry[] = [];
  for (let i = 0; i <= lines.length; i++) {
    for (let c = at.get(i) || 0; c > 0; c--) entries.push({ text: 'G53 Y0', inserted: true });
    if (i < lines.length) entries.push({ text: lines[i], inserted: false });
  }
  return renumberWithInsertions(entries);
}

/**
 * Makes sure a "G53 Y0" comes before every G52 that shifts the work offset (part flip), except the
 * first clamping at the start of the program (a G52 before anything moves), and
 * right before the end of the program (M30 / M02) so the parts can be unloaded. For each G52 the program is scanned upwards to
 * the tool change it belongs to (or to the start of the program). If no G53 Y0 is found on the
 * way, one is added:
 *  - after the tool change and its comment block (before the M0 stops), or
 *  - when there is no tool change above, just before the M0 stops / comments that precede the G52.
 * `call` false: an M98 P7999 (O7999 call) is not taken for the table out (FANUC-2).
 * Running it again changes nothing.
 */
export function applyG53BeforeG52(lines: string[], call = true): { lines: string[]; addedCount: number } {
  const positions: number[] = [];
  // One pass: the last G53 Y0 and the last tool change seen so far stand for the scan upwards
  // (a scan per G52 was quadratic: a program of many G52 lines froze the page).
  let lastG53 = -1;
  let lastToolChange = -1;
  // Nothing has moved yet: a G52 here is the first clamping at the start of the program (the
  // operator loads the raw part), not a flip, and gets no G53 Y0.
  let moved = false;

  for (let g = 0; g < lines.length; g++) {
    if (g > 0 && !isRemoved(lines[g - 1]) && isToolChangeLine(lines[g - 1])) lastToolChange = g - 1;
    if (g > 0 && isMotionLine(lines[g - 1])) moved = true;
    if (hasG53Y0(lines[g], call)) lastG53 = g;
    if (!isG52Shift(lines[g]) || !moved) continue;

    // Found when the nearest G53 Y0 above (this line included) is not before the nearest tool change.
    if (lastG53 !== -1 && lastG53 >= lastToolChange) continue;
    const toolChange = lastToolChange;

    let pos: number;
    if (toolChange !== -1) {
      pos = Math.min(afterToolCommentBlock(lines, toolChange), g);
    } else {
      pos = g;
      while (pos > 0 && (isCommentOrBlank(lines[pos - 1]) || isOperatorStop(lines[pos - 1]))) {
        const t = lines[pos - 1].trim();
        if (t === '%' || /^O\d+/i.test(t)) break;
        pos--;
      }
    }
    // One insertion covers every G52 after it in the same tool section. Positions only grow, so
    // the last one is the only candidate.
    const last = positions[positions.length - 1];
    if (last === undefined || last < (toolChange === -1 ? 0 : toolChange)) positions.push(pos);
  }

  // End of program: the table must come to the operator to unload the parts.
  let end = -1;
  for (let k = lines.length - 1; k >= 0; k--) if (isProgramEnd(lines[k])) { end = k; break; }
  if (end !== -1 && !hasG53Y0(lines[end], call)) {
    let present = false;
    for (let k = end - 1; k >= 0; k--) {
      // "G0 G53 G49 Y0 Z0" (the HAAS end line) already brings the table out: no second Y0 move.
      if (hasG53Y0(lines[k], call) || hasG53WithY0(lines[k])) { present = true; break; }
      if (isMotionLine(lines[k]) || (!isRemoved(lines[k]) && isToolChangeLine(lines[k]))) break;
    }
    if (!present && !positions.includes(end)) positions.push(end);
  }

  if (!positions.length) return { lines, addedCount: 0 };
  return { lines: insertBefore(lines, positions), addedCount: positions.length };
}

/**
 * FANUC-2 needs G49 (cancel tool length offset) on every tool change line, written right
 * after M6 and before any comment:  "N16 T3 M6 (...)"  ->  "N16 T3 M6 G49 (...)".
 * Lines that already have G49 are left as they are.
 */
export function addG49AfterM6(lines: string[]): string[] {
  return lines.map(l => {
    if (l === '__REMOVE_ME__' || !isToolChangeLine(l)) return l;
    if (/(?<![A-Z])G49(?![0-9])/i.test(codeOnly(l))) return l;
    return replaceInCode(l, /(?<![A-Z])(M0*6)(?![0-9.])/i, '$1 G49');
  });
}

/** A whole program, with its own O line (program number), not a few lines of one. */
export const isWholeProgram = (text: string) => /^\s*%?\s*O\d/im.test(text);

/** A program written in the FANUC dialect (H#513, M254 or the "G94 M95" safety line), code only. */
export function isFanucDialect(code: string): boolean {
  return code.split('\n').some((l) => /(?<![A-Z])H#513|(?<![A-Z0-9])M254(?![0-9])|G94\s+M95(?![0-9])/i.test(codeOnly(l)));
}

/**
 * A program still in the HAAS dialect for a FANUC that takes the FANUC dialect: the HAAS safety
 * line "G40 G17 G53 G49 G80 G90", or a G43 line with a plain H number and no M254.
 */
export function isHaasDialectForFanuc(code: string): boolean {
  return code.split('\n').some((l) => {
    const c = codeOnly(l);
    if (/G40/i.test(c) && /G17/i.test(c) && /G53/i.test(c) && /G49/i.test(c) && /G80/i.test(c) && /G90/i.test(c)) return true;
    return /(?<![A-Z])G0*43(?![0-9.])/i.test(c) && /(?<![A-Z])H\d/i.test(c) && !/(?<![A-Z0-9])M254(?![0-9])/i.test(c);
  });
}

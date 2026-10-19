import { Tool, ToolCategory, ToolChangeBlock, MATERIALS, Material } from '../types';

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

/** The executable part of a line, with every (comment) removed. */
export function codeOnly(line: string): string {
  return line.replace(/\([^)]*\)?/g, ' ');
}

/** Applies a regex replacement to the code parts of a line only, never inside (comments). */
export function replaceInCode(line: string, pattern: RegExp, replacement: string): string {
  let out = '';
  let replaced = false;
  const global = pattern.flags.includes('g');
  const re = /(\([^)]*\)?)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const doReplace = (segment: string) => {
    if (replaced && !global) return segment;
    const next = segment.replace(pattern, replacement);
    if (next !== segment) replaced = true;
    return next;
  };
  while ((m = re.exec(line))) {
    out += doReplace(line.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + doReplace(line.slice(last));
}

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
      const diamMatch = b.parsedDiameter === 16 || (b.matchedTool && b.matchedTool.diameter === 16) || /D16(?:\.0+)?\b/i.test(b.contextStr) || /16(?:\.0+)?\s*MM/i.test(b.contextStr);
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

  // Apply pointeur rule for other machines (FANUC or HAAS-1)
  const isFanuc = machineId?.includes('FANUC');
  const pointeurNumber = isFanuc ? 250550 : 4;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    // HAAS-2, HAAS-4, HAAS-5 have their own pointeur rules and should not force tool #4
    if (machineId && ['HAAS-2', 'HAAS-4', 'HAAS-5'].includes(machineId)) {
      continue;
    }
    const isPointeur = block.parsedCategory === 'pointeur' || /pointeur|ZENTRIERBOHREN|CENTER\s*DRILL/i.test(block.contextStr) || (block.matchedTool && block.matchedTool.category === 'pointeur');
    if (isPointeur) {
      let targetT = tools.find((x: Tool) => x.number === pointeurNumber);
      if (!targetT) {
         targetT = { id: `auto-${pointeurNumber}`, number: pointeurNumber, pocket: isFanuc ? 4 : undefined, category: 'pointeur', diameter: 0, length: 50, description: `Auto-assigned T${pointeurNumber}` };
      }
      block.matchedTool = targetT;
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
      for (let j = block.lineIndex; j < nextBlockIndex; j++) {
        outputLines[j] = '__REMOVE_ME__';
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

      const isFanuc = machineId && machineId.startsWith('FANUC');
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
            if (/(?<![A-Z])H\d+/i.test(codePart)) {
              outputLines[j] = replaceInCode(outputLines[j], /(?<![A-Z])H\d+/i, `H${toolToUse.number}`) + ` (AI-MOD: OFFSET H${toolToUse.number})`;
              break; 
            }
          }
        }
      }
    } else {
      // Still unresolved for whatever reason
      outputLines[block.lineIndex] = block.originalLine + ` (ATTENTION: PAS D'OUTIL DEFINI)`;
    }
  }

  // FANUC-2 only: cancel the tool length offset right on the tool change line ("T3 M6 G49").
  if (machineId === 'FANUC-2') {
    outputLines = addG49AfterM6(outputLines);
  }

  // In FANUC, if the app detects M98 P7999 then it should be deleted
  const isFanuc = (machineId && machineId.toUpperCase().includes('FANUC')) || 
                  outputLines.some(l => l !== '__REMOVE_ME__' && /H#513|M95|M254/i.test(l));
  if (isFanuc) {
    outputLines = outputLines.map(l => {
      if (l === '__REMOVE_ME__') return l;
      if (/M98\s*P7999/i.test(l)) {
        return '__REMOVE_ME__';
      }
      return l;
    });
  }

  // Bring the table to the operator only where they need it: before each part flip (G52)
  // and before the end of the program (to unload the parts). Not at every tool change.
  const { lines: linesWithG53 } = applyG53BeforeG52(outputLines);
  outputLines = linesWithG53;

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
const hasG53Y0 = (l: string) => !isRemoved(l) && G53_Y0_RE.test(codeOnly(l));
const hasG52 = (l: string) => !isRemoved(l) && G52_RE.test(codeOnly(l));
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
  const jumpsToLabels = real.some(l => /(?<![A-Z])(?:M97|M99\s*P|GOTO)/i.test(codeOnly(l)));
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
        if (!jumpsToLabels || !usedNumbers.has(candidate)) {
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
    if (!jumpsToLabels && lastOut !== null && value <= lastOut && (lastIn === null || value > lastIn)) {
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
 * Makes sure a "G53 Y0" comes before every G52 that shifts the work offset (part flip), and
 * right before the end of the program (M30 / M02) so the parts can be unloaded. For each G52 the program is scanned upwards to
 * the tool change it belongs to (or to the start of the program). If no G53 Y0 is found on the
 * way, one is added:
 *  - after the tool change and its comment block (before the M0 stops), or
 *  - when there is no tool change above, just before the M0 stops / comments that precede the G52.
 * Running it again changes nothing.
 */
export function applyG53BeforeG52(lines: string[]): { lines: string[]; addedCount: number } {
  const positions: number[] = [];

  for (let g = 0; g < lines.length; g++) {
    if (!isG52Shift(lines[g])) continue;

    let toolChange = -1;
    let found = false;
    for (let k = g; k >= 0; k--) {
      if (hasG53Y0(lines[k])) { found = true; break; }
      if (k < g && !isRemoved(lines[k]) && isToolChangeLine(lines[k])) { toolChange = k; break; }
    }
    if (found) continue;

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
    // One insertion covers every G52 after it in the same tool section.
    if (!positions.some(p => p <= g && p >= (toolChange === -1 ? 0 : toolChange))) positions.push(pos);
  }

  // End of program: the table must come to the operator to unload the parts.
  let end = -1;
  for (let k = lines.length - 1; k >= 0; k--) if (isProgramEnd(lines[k])) { end = k; break; }
  if (end !== -1 && !hasG53Y0(lines[end])) {
    let present = false;
    for (let k = end - 1; k >= 0; k--) {
      if (hasG53Y0(lines[k])) { present = true; break; }
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

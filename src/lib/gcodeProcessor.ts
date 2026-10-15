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

  // Bring the table to the operator at every tool change:
  // insert "G53 Y0" right after the tool-name comment that follows the T.. M6 line.
  outputLines = insertG53Y0AfterToolChange(outputLines, blocks, resolutions);

  // Ensure G53 Y0 is ALWAYS written before G52 on all machines
  const { lines: linesWithG53 } = applyG53BeforeG52(outputLines);
  outputLines = linesWithG53;

  return {
    finalCode: outputLines.filter(l => l !== '__REMOVE_ME__').join('\n'),
    addedFanucOffsets
  };
}

/**
 * For every kept tool change (T.. M6), inserts "G53 Y0" so the table comes close to the operator.
 * Position: right AFTER the tool-name comment line that directly follows the M6 line, e.g.
 *   N6181 T13 M6 (...)
 *   N6182 (MESSERKOPF D93 / MK_93.00_030_000_KS)
 *   G53 Y0                      <-- inserted here
 *   N6183 (DIAMETER 93.00 MM/LENGTH 30.00 MM)
 * If the line after M6 is not a pure comment, it is inserted directly after the M6 line.
 * It is skipped when a G53 Y0 is already on the M6 line or directly adjacent (idempotent).
 * Lines are only inserted (never removed), and original line indexes are not shifted while scanning.
 */
export function insertG53Y0AfterToolChange(
  lines: string[],
  blocks: ToolChangeBlock[],
  resolutions: Record<string, Tool>
): string[] {
  const isG53Y0 = /(?<![A-Z_])G53(?![0-9])\s*Y\s*0(?:\.0*)?(?![0-9]|\.)/i;
  const isPureComment = (l: string) => /^\s*(N\d+\s*)?\(.*\)\s*$/i.test(l);
  const isRemoved = (l: string) => l === '__REMOVE_ME__';
  const getN = (l: string | undefined): number | null => {
    const m = l?.match(/^\s*N(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
  };
  const nextKept = (from: number): number => {
    for (let k = from; k < lines.length; k++) if (!isRemoved(lines[k])) return k;
    return -1;
  };

  const insertions = new Map<number, string>(); // anchor line index -> text inserted after it

  for (const block of blocks) {
    const skipped = block.skipOperation ||
      (resolutions[block.blockId]?.category === 'empty' && resolutions[block.blockId]?.description === 'Skip Operation');
    if (skipped) continue;
    if (!(resolutions[block.blockId] || block.matchedTool)) continue;

    const m6Idx = block.lineIndex;
    if (isRemoved(lines[m6Idx])) continue;

    // The M6 line already carries G53 Y0
    if (isG53Y0.test(lines[m6Idx].split('(')[0])) continue;

    // Anchor = tool-name comment line directly after M6 (if any), otherwise the M6 line
    let anchor = m6Idx;
    const nIdx = nextKept(m6Idx + 1);
    if (nIdx !== -1 && isPureComment(lines[nIdx]) && !isG53Y0.test(lines[nIdx].split('(')[0])) {
      anchor = nIdx;
    }

    // Already there (the line right after the anchor is a G53 Y0)
    const afterIdx = nextKept(anchor + 1);
    if (afterIdx !== -1 && isG53Y0.test(lines[afterIdx].split('(')[0])) continue;

    // N-number: use a free number between anchor and next line if there is a gap, else no N.
    const a = getN(lines[anchor]);
    const b = afterIdx !== -1 ? getN(lines[afterIdx]) : null;
    let text = 'G53 Y0';
    if (a !== null && b !== null && b - a > 1) text = `N${a + Math.floor((b - a) / 2)} G53 Y0`;
    else if (a !== null && b === null) text = `N${a + 1} G53 Y0`;

    insertions.set(anchor, text);
  }

  if (insertions.size === 0) return lines;

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const ins = insertions.get(i);
    if (ins) out.push(ins);
  }
  return out;
}

/**
 * Ensures that G53 Y0 is ALWAYS written before any occurrence of G52 on all machines.
 * If G52 is detected in the program, it verifies that each G52 command has a G53 Y0
 * safely preceding it, inserting G53 Y0 (with appropriate N-block numbering if used)
 * where missing, while avoiding redundant duplicate insertions.
 */
export function applyG53BeforeG52(lines: string[]): { lines: string[]; addedCount: number } {
  const isG52Regex = /(?<![A-Z_])G52(?![0-9])/i;
  const isG53Y0Regex = /(?<![A-Z_])G53(?![0-9])\s*Y\s*0(?:\.0*)?(?![0-9]|\.)/i;

  const hasG52 = lines.some(l => {
    if (l === '__REMOVE_ME__') return false;
    const codePart = l.split('(')[0];
    return isG52Regex.test(codePart);
  });

  if (!hasG52) {
    return { lines, addedCount: 0 };
  }

  const result: string[] = [];
  let addedCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '__REMOVE_ME__') {
      result.push(line);
      continue;
    }

    const codePart = line.split('(')[0];
    if (isG52Regex.test(codePart)) {
      // Check if G53 Y0 is already part of this line
      if (isG53Y0Regex.test(codePart)) {
        result.push(line);
        continue;
      }

      // Check if preceding executable line already has G53 Y0
      let alreadyHasG53 = false;
      let lastExecutableIdx = -1;

      for (let k = result.length - 1; k >= 0; k--) {
        if (result[k] === '__REMOVE_ME__') continue;
        const prevCode = result[k].split('(')[0].trim();
        if (!prevCode) continue; // Skip comments and blank lines

        if (isG53Y0Regex.test(prevCode)) {
          alreadyHasG53 = true;
        }
        lastExecutableIdx = k;
        break; // Only check the immediate preceding executable line
      }

      if (!alreadyHasG53) {
        let prevN: number | null = null;
        if (lastExecutableIdx !== -1) {
          const m = result[lastExecutableIdx].match(/^N(\d+)/i);
          if (m) prevN = parseInt(m[1], 10);
        }
        const currNMatch = line.match(/^N(\d+)/i);
        const currN = currNMatch ? parseInt(currNMatch[1], 10) : null;

        let g53Line = 'G53 Y0';
        if (prevN !== null && currN !== null) {
          if (prevN < currN) {
            const midN = prevN + 1 < currN ? Math.floor((prevN + currN) / 2) : prevN + 1;
            g53Line = `N${midN} G53 Y0`;
          } else {
            g53Line = `N${currN} G53 Y0`;
          }
        } else if (currN !== null) {
          g53Line = `N${Math.max(1, currN - 1)} G53 Y0`;
        } else if (prevN !== null) {
          g53Line = `N${prevN + 1} G53 Y0`;
        }

        result.push(g53Line);
        addedCount++;
      }
    }

    result.push(line);
  }

  return { lines: result, addedCount };
}


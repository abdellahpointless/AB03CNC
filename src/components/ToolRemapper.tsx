import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { MachineId, MACHINES, ToolChangeBlock, Tool, TOOL_CATEGORIES, ToolCategory, HistoryRecord } from '../types';
import CodeEditorPair from './CodeEditorPair';
import { analyzeGCode, generateRemappedCode, applyG53BeforeG52 } from '../lib/gcodeProcessor';
import { Settings, Info, AlertTriangle, CheckCircle, Plus, AlertCircle, Trash2, Clock, Sparkles, Database, ArrowUpRight, Wrench } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { waveItem, EASE_OUT, EXIT_FAST, FADE, SPRING_MODAL, SPRING_POP, SPRING_TOAST, iosBackdrop, iosSurface } from '../lib/motion';
import { useAuth } from '../contexts/AuthContext';
import { useSync } from '../contexts/SyncContext';
import { submitExport } from '../lib/historyApi';
import { downloadText } from '../lib/download';
import { formatTimeWon } from '../lib/extractionAnalytics';

interface ToolRemapperProps {
  onNavigateToDatabase?: (machineId: MachineId) => void;
  selectedMachine?: MachineId;
  setSelectedMachine?: (val: MachineId) => void;
  sourceCode?: string;
  setSourceCode?: (val: string) => void;
  fileName?: string;
  setFileName?: (val: string) => void;
  outputCode?: string;
  setOutputCode?: (val: string) => void;
  blocks?: ToolChangeBlock[];
  setBlocks?: React.Dispatch<React.SetStateAction<ToolChangeBlock[]>>;
  lines?: string[];
  setLines?: React.Dispatch<React.SetStateAction<string[]>>;
  detectedMat?: string | undefined;
  setDetectedMat?: React.Dispatch<React.SetStateAction<string | undefined>>;
  resolutions?: Record<string, Tool>;
  setResolutions?: React.Dispatch<React.SetStateAction<Record<string, Tool>>>;
  /** machine + source the current analysis/output was produced from (detects stale output) */
  analyzedSignature?: string;
  setAnalyzedSignature?: (sig: string) => void;
}

const signatureOf = (machine: string, source: string) => `${machine}\u0000${source}`;

export default function ToolRemapper({ 
  onNavigateToDatabase,
  selectedMachine: propSelectedMachine,
  setSelectedMachine: propSetSelectedMachine,
  sourceCode: propSourceCode,
  setSourceCode: propSetSourceCode,
  fileName: propFileName,
  setFileName: propSetFileName,
  outputCode: propOutputCode,
  setOutputCode: propSetOutputCode,
  blocks: propBlocks,
  setBlocks: propSetBlocks,
  lines: propLines,
  setLines: propSetLines,
  detectedMat: propDetectedMat,
  setDetectedMat: propSetDetectedMat,
  resolutions: propResolutions,
  setResolutions: propSetResolutions,
  analyzedSignature,
  setAnalyzedSignature
}: ToolRemapperProps) {
  const { user } = useAuth();
  const { toolbox, installTools, analytics } = useSync();
  const [internalSelectedMachine, setInternalSelectedMachine] = useState<MachineId>('HAAS-1');
  const selectedMachine = propSelectedMachine ?? internalSelectedMachine;
  const setSelectedMachine = propSetSelectedMachine ?? setInternalSelectedMachine;

  const getSafeString = (val: unknown, fallback = ''): string => {
    if (typeof val === 'string') return val;
    if (val && typeof (val as Record<string, unknown>).code === 'string') {
      return (val as Record<string, unknown>).code as string;
    }
    if (val && typeof (val as Record<string, unknown>).value === 'string') {
      return (val as Record<string, unknown>).value as string;
    }
    return val ? String(val) : fallback;
  };

  const [internalSourceCode, setInternalSourceCode] = useState('%\nO1000\nN14 T2 M6\nN15 (ST_10.00_050_G45_ALHS)\nN16 (DIAMETER 10.00 MM / LENGTH 50.00 MM)\nN20 G90 G54 G0 X0. Y0.\nN21 T3 M6\nN22 (MK_40.00_040_000_ALHS)\nN23 G0 Z50.\nN24 T5 M6\nN25 (SF_12.00_075_000_ALHS)\nN30 M30\n%');
  const sourceCode: string = getSafeString(propSourceCode ?? internalSourceCode, '%\nO1000\nN14 T2 M6\nN15 (ST_10.00_050_G45_ALHS)\nN16 (DIAMETER 10.00 MM / LENGTH 50.00 MM)\nN20 G90 G54 G0 X0. Y0.\nN21 T3 M6\nN22 (MK_40.00_040_000_ALHS)\nN23 G0 Z50.\nN24 T5 M6\nN25 (SF_12.00_075_000_ALHS)\nN30 M30\n%');
  const setSourceCode = propSetSourceCode ?? setInternalSourceCode;

  const [internalFileName, setInternalFileName] = useState('program.nc');
  const rawFileName = propFileName ?? internalFileName;
  const fileName = typeof rawFileName === 'string' ? rawFileName : 'program.nc';
  const setFileName = propSetFileName ?? setInternalFileName;

  const [internalOutputCode, setInternalOutputCode] = useState('');
  const outputCode: string = getSafeString(propOutputCode ?? internalOutputCode);
  const setOutputCode = propSetOutputCode ?? setInternalOutputCode;

  // The generated code no longer matches what is on screen (program edited or machine switched).
  const isStale = !!outputCode && analyzedSignature !== undefined && analyzedSignature !== signatureOf(selectedMachine, sourceCode);

  const [internalBlocks, setInternalBlocks] = useState<ToolChangeBlock[]>([]);
  const blocks = propBlocks ?? internalBlocks;
  const setBlocks = propSetBlocks ?? setInternalBlocks;

  const [internalResolutions, setInternalResolutions] = useState<Record<string, Tool>>({});
  const resolutions = propResolutions ?? internalResolutions;
  const setResolutions = propSetResolutions ?? setInternalResolutions;

  const [pendingToolboxAdditions, setPendingToolboxAdditions] = useState<Tool[]>([]);
  const [showChecklist, setShowChecklist] = useState(false);

  const [internalLines, setInternalLines] = useState<string[]>([]);
  const lines = propLines ?? internalLines;
  const setLines = propSetLines ?? setInternalLines;

  const [internalDetectedMat, setInternalDetectedMat] = useState<string | undefined>(undefined);
  const detectedMat = propDetectedMat !== undefined ? propDetectedMat : internalDetectedMat;
  const setDetectedMat = propSetDetectedMat ?? setInternalDetectedMat;
  
  // Resolution State
  const [showModal, setShowModal] = useState(false);
  
  // Inline Tool Creation State
  const [addingForBlock, setAddingForBlock] = useState<string | null>(null);
  const [newToolForm, setNewToolForm] = useState({ pocket: '', number: '', category: 'foret' as ToolCategory, description: '', diameter: '', length: '' });
  const [addError, setAddError] = useState<string | null>(null);

  const [showConfirm, setShowConfirm] = useState(false);
  const [showSpecialChecklist, setShowSpecialChecklist] = useState(false);
  const [specialToolsToCheck, setSpecialToolsToCheck] = useState<Tool[]>([]);
  const [checkedSpecialTools, setCheckedSpecialTools] = useState<Set<number>>(new Set());

  const [showCrashAlert, setShowCrashAlert] = useState(false);
  const [extractionToast, setExtractionToast] = useState<string | null>(null);

  const handleLoadFanucSample = () => {
    const sample = `%
O12345
N10 (SAMPLE FANUC PROGRAM FOR HAAS CONVERSION)
G0 G53 G49 Z0 G94 M95
N250 M98 P7999
T06 M6 (4MM BOHRER / SB_04.00_050_000_VAHS)
(DIAMETER 4.00 MM / LENGTH 50.00 MM)
G43 H#513 D#513 M254 Z50 M08
S3500 M03
F1200
G01 Z-10
G00 Z50
G00 Z50.
M09
M05
G0 G53 G49 Z0 G94 M95
M30
%`;
    setSourceCode(sample);
    setFileName('FANUC_SAMPLE.nc');
  };

  const handleLoadHaasSample = () => {
    const sample = `O2345 (SAMPLE HAAS PROGRAM FOR FANUC CONVERSION)
G40 G17 G53 G49 G80 G90
T06 M6 (4MM BOHRER / SB_04.00_050_000_VAHS)
(DIAMETER 4.00 MM / LENGTH 50.00 MM)
N100 G00 G43 H06 Z50.
N110 M08
N120 S3500 M03
N130 F1200.
N140 G01 Z-10.
N150 G00 Z50.
N160 M09
N170 M05
N180 G53 G49 Z0
N190 M30`;
    setSourceCode(sample);
    setFileName('HAAS_SAMPLE.txt');
  };

  const handleProcess = () => {
    let currentSource = sourceCode;
    if (currentSource.trim()) {
      const { lines: processedLines, addedCount } = applyG53BeforeG52(currentSource.split('\n'));
      if (addedCount > 0) {
        currentSource = processedLines.join('\n');
        setSourceCode(currentSource);
      }
    }
    const toolsForMachine = toolbox[selectedMachine] || [];
    const analysis = analyzeGCode(currentSource, toolsForMachine, selectedMachine);
    setAnalyzedSignature?.(signatureOf(selectedMachine, currentSource));
    setBlocks(analysis.blocks);
    setLines(analysis.lines);
    setDetectedMat(analysis.detectedMaterial);
    setResolutions({}); // Reset prior manual resolutions
    setPendingToolboxAdditions([]); // Reset pending additions
    
    // We want to show the modal if there are unresolved OR approximate tools so user can review them
    const needsReview = analysis.blocks.some(b => {
      const toolCrashed = b.matchedTool ? b.matchedTool.length < Math.abs(b.minZDepth || 0) : true;
      return !b.matchedTool || b.matchType === 'approximate' || toolCrashed || b.isHaasTaraudException;
    });
    
    if (needsReview) {
      setShowModal(true);
      setOutputCode(''); // Clear old output
    } else {
      setShowConfirm(true);
    }
  };

  const handleApplyResolutions = () => {
    const isMissingTools = blocks.some(b => {
      if (b.skipOperation || (resolutions[b.blockId] && resolutions[b.blockId].description === 'Skip Operation')) return false;
      const t = resolutions[b.blockId] || b.matchedTool;
      if (!t) return true;
      return false;
    });
    
    if (isMissingTools) {
      alert("Please resolve all missing tools before generating code.");
      return;
    }

    const isCrashing = blocks.some(b => {
      if (b.skipOperation || (resolutions[b.blockId] && resolutions[b.blockId].category === 'empty')) return false;
      const t = resolutions[b.blockId] || b.matchedTool;
      if (t && t.length < Math.abs(b.minZDepth || 0)) return true;
      return false;
    });

    if (isCrashing) {
      setShowCrashAlert(true);
      return;
    }

    proceedWithApplyResolutions();
  };

  const proceedWithApplyResolutions = () => {
    setShowCrashAlert(false);
    const usedTNumbers = new Set<number>();
    const specialTools: Tool[] = [];
    blocks.forEach(b => {
      const t = resolutions[b.blockId] || b.matchedTool;
      if (t && [1.68, 2.96, 1.97, 20, 1.3, 1.2, 1].includes(t.diameter)) {
        if (!usedTNumbers.has(t.number)) {
           usedTNumbers.add(t.number);
           specialTools.push(t);
        }
      }
    });
    setSpecialToolsToCheck(specialTools);
    setCheckedSpecialTools(new Set());
    
    if (pendingToolboxAdditions.length > 0) {
       setShowChecklist(true);
    } else {
       setShowModal(false);
       if (specialTools.length > 0) {
         setShowSpecialChecklist(true);
       } else {
         setShowConfirm(true);
       }
    }
  };

  const [isInstalling, setIsInstalling] = useState(false);

  const confirmChecklist = async () => {
    if (pendingToolboxAdditions.length > 0) {
      setIsInstalling(true);
      try {
        await installTools(selectedMachine, pendingToolboxAdditions.map(t => ({ ...t, changed: true })));
        setPendingToolboxAdditions([]);
      } catch (err: any) {
        setIsInstalling(false);
        alert(`The new tools could not be saved to the ${selectedMachine} inventory:\n${err?.message || err}\n\nCheck the connection and press "Approve & Install" again.`);
        return;
      }
      setIsInstalling(false);
    }
    setShowChecklist(false);
    setShowModal(false);
    
    if (specialToolsToCheck.length > 0) {
       setShowSpecialChecklist(true);
    } else {
       setShowConfirm(true);
    }
  };

  const finalizeCodeGeneration = () => {
    const { finalCode, addedFanucOffsets } = generateRemappedCode(lines, blocks, resolutions, selectedMachine);
    if (addedFanucOffsets) {
       alert("Attention: After tool changes on FANUC machine, 'H#513 D#513' were missing. They have been automatically added to the G-code.");
    }
    setOutputCode(finalCode);
    setShowConfirm(false);
  };

  const handleExport = () => {
    if (!outputCode) return;
    
    const { lines: processedExportLines } = applyG53BeforeG52(outputCode.split('\n'));
    const finalExportCode = processedExportLines.join('\n');

    let exportedName = fileName;
    const dotIdx = exportedName.lastIndexOf('.');
    if (dotIdx !== -1) {
      exportedName = exportedName.substring(0, dotIdx) + '-' + exportedName.substring(dotIdx + 1) + '.text';
    } else {
      exportedName += '.text';
    }

    // Process history record
    const recordId = crypto.randomUUID();
    const record: HistoryRecord = {
      id: recordId,
      date: new Date().toLocaleString(),
      isoDate: new Date().toISOString(),
      timestamp: new Date().getTime(),
      user: user?.username || 'Unknown',
      machine: selectedMachine,
      originalFileName: fileName,
      exportedFileName: exportedName,
      changes: blocks.map(b => {
        const resolution = resolutions[b.blockId] || b.matchedTool;
        return {
          originalT: b.originalT || 'M6',
          originalContext: b.contextStr,
          reqDiameter: b.parsedDiameter,
          reqLength: b.parsedLength,
          appChose: !resolutions[b.blockId] && !!b.matchedTool,
          chosenCategory: resolution?.category || 'unknown',
          chosenT: resolution?.number || 0,
          chosenDiameter: resolution?.diameter || 0,
          chosenLength: resolution?.length || 0
        };
      })
    };

    // Download first - the operator never waits on the network.
    downloadText(exportedName, finalExportCode);

    const saved = formatTimeWon(analytics?.savedSecondsPerExtraction ?? 285).formatted;
    setExtractionToast(`Code extracted! Saved ~${saved} on manual programming ⏱️`);
    setTimeout(() => {
      setExtractionToast(prev => (prev?.includes('Code extracted!') ? null : prev));
    }, 5000);

    // Log it in the shared history. If the server can't be reached it is queued and sent automatically later.
    submitExport(record, finalExportCode)
      .then(result => {
        if (result === 'queued') {
          setExtractionToast('Code extracted. No connection right now - the history entry will upload automatically.');
        }
      })
      .catch(err => console.error('Could not queue history record', err));
  };

  const startInlineAdd = (block: ToolChangeBlock) => {
    setAddingForBlock(block.blockId);
    setNewToolForm({
      pocket: '',
      number: '',
      category: block.parsedCategory || 'foret',
      description: `New Tool for ${block.originalT || 'M6'} (Dia: ${block.parsedDiameter || '-'}, L: ${block.parsedLength || '-'})`,
      diameter: block.parsedDiameter?.toString() || '',
      length: block.parsedLength?.toString() || ''
    });
    setAddError(null);
  };

  const saveInlineTool = () => {
    if (!addingForBlock) return;
    const isFanuc = selectedMachine.includes('FANUC');
    // For HAAS, pocket and number are usually the same, so if empty we can fallback.
    const pocketNum = parseInt(newToolForm.pocket);
    const macroNum = parseInt(newToolForm.number);
    
    if (!pocketNum) {
      setAddError("Please select a physical slot (pocket).");
      return;
    }
    
    const finalNumber = isFanuc ? macroNum : (macroNum || pocketNum);
    
    if (!finalNumber) {
       setAddError("Please enter the Tool No. (Macros).");
       return;
    }
    
    if (pocketNum > 41 && selectedMachine === 'HAAS-1') {
       setAddError(`HAAS-1 maximum slot is 41!`);
       return;
    }

    const toolsForMachine = toolbox[selectedMachine] || [];
    const existingTool = toolsForMachine.find(t => (t.pocket === pocketNum) || (t.pocket === undefined && t.number === pocketNum));
    
    // Check if slot is already actively used by the parsed program
    const isUsed = blocks.some(b => {
       const res = resolutions[b.blockId] || b.matchedTool;
       return res && (res.pocket === pocketNum || (res.pocket === undefined && res.number === pocketNum));
    }) || pendingToolboxAdditions.some(t => t.pocket === pocketNum || (t.pocket === undefined && t.number === pocketNum));

    if (isUsed) {
       setAddError(`Slot ${pocketNum} is already used in this new configuration.`);
       return;
    }

    const newTool: Tool = {
      id: existingTool ? existingTool.id : crypto.randomUUID().slice(0, 13),
      number: finalNumber,
      pocket: pocketNum,
      category: newToolForm.category,
      description: newToolForm.description,
      diameter: parseFloat(newToolForm.diameter) || 0,
      length: parseFloat(newToolForm.length) || 0
    };

    setPendingToolboxAdditions(prev => {
       const filtered = prev.filter(t => t.number !== finalNumber);
       return [...filtered, newTool];
    });

    // Auto-resolve
    setResolutions(prev => ({ ...prev, [addingForBlock]: newTool }));
    setAddingForBlock(null);
  };

  const renderInlineToolSelector = (block: ToolChangeBlock, dropdownPlaceholder = "-- Select Existing Tool --") => {
    if (addingForBlock === block.blockId) {
      return (
        <motion.div 
          initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
          className="glass-panel p-5 space-y-4 mt-4 border border-[var(--blue-500)]/40 rounded-[var(--radius-lg)]"
        >
          <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-2.5">
            <h4 className="font-bold text-sm text-[var(--text-primary)] flex items-center gap-2">
              <Plus size={16} className="text-[var(--accent-primary)]" />
              Create New Tool in <span className="text-[var(--accent-primary)]">{selectedMachine}</span>
            </h4>
            <span className="text-[11px] text-[var(--text-secondary)]">Enter tool name and specifications</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3.5">
            <div className="col-span-1 sm:col-span-2 md:col-span-4">
              <label className="section-label block mb-1 text-[var(--accent-primary)] font-bold">
                Tool Name / Description*
              </label>
              <input 
                type="text" 
                value={newToolForm.description} 
                onChange={e => setNewToolForm({...newToolForm, description: e.target.value})} 
                placeholder="e.g. Foret D4, Fraise ébauche D16, ST_10.00_050..."
                className="aurora-input w-full text-xs font-semibold" 
              />
            </div>

            <div>
              <label className="section-label block mb-1">Physical Slot / Pocket*</label>
              <select 
                value={newToolForm.pocket} 
                onChange={e => setNewToolForm({...newToolForm, pocket: e.target.value})} 
                className="aurora-input w-full text-xs cursor-pointer"
              >
                <option value="" disabled className="bg-[var(--bg-panel)]">-- Select Slot --</option>
                {getAvailableSlotsDropdown().map(slot => (
                  <option key={slot.pos} value={slot.pos.toString()} className="bg-[var(--bg-panel)] text-[var(--text-primary)]">
                    Slot {slot.pos} {slot.isPhysicallyEmpty ? '(Empty)' : `(Replace ${slot.existing?.description || slot.existing?.category} D${slot.existing?.diameter})`}
                  </option>
                ))}
              </select>
            </div>

            {selectedMachine.includes('FANUC') && (
              <div>
                <label className="section-label block mb-1">Tool No. (Macros)*</label>
                <input 
                  type="number" 
                  step="1" 
                  value={newToolForm.number} 
                  onChange={e => setNewToolForm({...newToolForm, number: e.target.value})} 
                  className="aurora-input w-full text-xs" 
                  placeholder="e.g. 161600" 
                />
              </div>
            )}

            <div>
              <label className="section-label block mb-1">Category</label>
              <select 
                value={newToolForm.category} 
                onChange={e => setNewToolForm({...newToolForm, category: e.target.value as ToolCategory})} 
                className="aurora-input w-full text-xs cursor-pointer"
              >
                {TOOL_CATEGORIES.map(c => (
                  <option key={c} value={c} className="bg-[var(--bg-panel)] text-[var(--text-primary)]">
                    {c.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="section-label block mb-1">Diameter (mm)</label>
              <input 
                type="number" 
                step="0.01" 
                value={newToolForm.diameter} 
                onChange={e => setNewToolForm({...newToolForm, diameter: e.target.value})} 
                className="aurora-input w-full text-xs" 
                placeholder="e.g. 10.0"
              />
            </div>

            <div>
              <label className="section-label block mb-1">Length (mm)</label>
              <input 
                type="number" 
                step="0.01" 
                value={newToolForm.length} 
                onChange={e => setNewToolForm({...newToolForm, length: e.target.value})} 
                className="aurora-input w-full text-xs" 
                placeholder="e.g. 50.0"
              />
            </div>
          </div>

          {addError && (
            <div className="badge-danger w-full py-2 px-3 text-xs font-medium">
              <AlertTriangle size={14} className="shrink-0" />
              <span>{addError}</span>
            </div>
          )}

          <div className="flex justify-end gap-2.5 pt-2 border-t border-[var(--border-subtle)]">
            <button 
              type="button"
              onClick={() => setAddingForBlock(null)} 
              className="btn-secondary text-xs py-1.5 px-3.5"
            >
              Cancel
            </button>
            <button 
              type="button"
              onClick={saveInlineTool} 
              className="btn-primary text-xs py-1.5 px-4 font-bold flex items-center gap-1.5"
            >
              <CheckCircle size={14} />
              <span>Save &amp; Use</span>
            </button>
          </div>
        </motion.div>
      );
    }
    
    return (
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 pt-3">
         <div className="flex-1">
           <select 
             className="w-full text-sm rounded-lg border-slate-300 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 py-2.5 shadow-sm focus:ring-2 focus:ring-blue-500"
             value={resolutions[block.blockId]?.id || ""}
             onChange={(e) => {
               const selectedTool = mergedAvailableTools.find(t => t.id === e.target.value);
               if (selectedTool) {
                 setResolutions(prev => ({...prev, [block.blockId]: selectedTool}));
               }
             }}
           >
             <option value="" disabled>{dropdownPlaceholder}</option>
             {mergedAvailableTools.filter(t => t.category !== 'empty').map(t => (
                <option key={t.id} value={t.id} className={block.minZDepth !== undefined && t.length < Math.abs(block.minZDepth) ? 'text-rose-500' : ''}>
                  {t.pocket !== undefined ? `[${t.pocket}] ` : ''}T{t.number} - {t.category.toUpperCase()} {t.diameter ? `(D${t.diameter})` : ''} {t.length ? `(L${t.length})` : ''} - {t.description}
                </option>
             ))}
           </select>
         </div>
         <div className="hidden sm:block text-slate-400 font-bold text-xs uppercase tracking-wider text-center">OR</div>
         <button 
           onClick={() => startInlineAdd(block)}
           className="flex items-center justify-center gap-2 px-5 py-2.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200 text-slate-700 text-sm font-bold rounded-lg transition-colors border border-slate-200 dark:border-slate-700 shadow-sm whitespace-nowrap active:scale-95"
         >
           <Plus size={18}/> Create New Tool
         </button>
      </div>
    );
  };

  const getAvailableSlotsDropdown = () => {
    const tools = toolbox[selectedMachine] || [];
    const isFanuc = selectedMachine.includes('FANUC');
    const maxSlots = selectedMachine === 'HAAS-1' ? 41 : (isFanuc ? 21 : 99);
    
    const usedPockets = new Set<number>();
    blocks.forEach(b => {
       const res = resolutions[b.blockId] || b.matchedTool;
       if (res) {
          const pocket = res.pocket ?? res.number;
          if (pocket) usedPockets.add(pocket);
       }
    });
    pendingToolboxAdditions.forEach(pt => usedPockets.add(pt.pocket ?? pt.number));

    const checkList: { pos: number; isPhysicallyEmpty: boolean; existing: Tool | undefined }[] = [];
    for (let i = 1; i <= maxSlots; i++) {
       if (!usedPockets.has(i)) {
          const existingTool = tools.find(t => t.pocket === i) || tools.find(t => t.pocket === undefined && t.number === i);
          const isPhysicallyEmpty = !existingTool || existingTool.category === 'empty';
          checkList.push({ pos: i, isPhysicallyEmpty, existing: existingTool });
       }
    }
    return checkList;
  };

  const unresolvedCount = blocks.filter(b => {
    if (b.skipOperation || (resolutions[b.blockId] && resolutions[b.blockId].description === 'Skip Operation')) return false;
    const usedTool = resolutions[b.blockId] || b.matchedTool;
    if (!usedTool) return true; // Missing Tool
    if (usedTool.length < Math.abs(b.minZDepth || 0)) return true; // Tool Too Short Crash
    return false;
  }).length;
  // Approximates don't count as unresolved (they have a default match that works), but they need display.

  // Merge toolbox with pending for the dropdown
  const mergedAvailableTools = [...(toolbox[selectedMachine] || [])];
  pendingToolboxAdditions.forEach(pt => {
    const idx = mergedAvailableTools.findIndex(t => t.id === pt.id || t.number === pt.number);
    if (idx !== -1) mergedAvailableTools[idx] = pt;
    else mergedAvailableTools.push(pt);
  });

  return (
    <div className="flex flex-col h-full relative space-y-4">
      {/* Floating Extraction / Time Won Toast (portaled: the animated tab container would otherwise pin it to the top-left) */}
      {typeof document !== 'undefined' && createPortal(<AnimatePresence>
        {extractionToast && (
          <motion.div
            initial={{ opacity: 0, y: 40, scale: 0.8, filter: 'blur(10px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)', transitionEnd: { filter: 'none' } }}
            exit={{ opacity: 0, y: 24, scale: 0.9, filter: 'blur(6px)', transition: { duration: 0.2, ease: EASE_OUT } }}
            transition={{ type: 'spring', duration: 0.55, bounce: 0.3 }}
            style={{ transformOrigin: 'bottom right' }}
            className="fixed bottom-6 right-6 z-[100] max-w-md flex items-center gap-3 glass-modal text-[var(--text-primary)] px-4 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.6)] border border-[var(--green-500)]/40 bg-[rgba(var(--surface),0.95)] rounded-[var(--radius-lg)]"
          >
            <div className="w-8 h-8 rounded-full bg-[var(--green-500)]/20 border border-[var(--green-500)]/40 flex items-center justify-center text-[var(--green-500)] shrink-0 shadow-[0_0_10px_var(--green-glow)]">
              <CheckCircle size={16} />
            </div>
            <div className="flex flex-col min-w-0 pr-1">
              <span className="font-bold text-xs text-[var(--text-primary)]">
                Extraction Complete
              </span>
              <span className="text-[11px] text-[var(--text-secondary)] font-normal truncate max-w-xs">
                {extractionToast}
              </span>
            </div>
            <button
              onClick={() => setExtractionToast(null)}
              className="ml-auto btn-icon text-xs w-6 h-6 shrink-0 cursor-pointer"
              title="Close notification"
            >
              ✕
            </button>
          </motion.div>
        )}
      </AnimatePresence>, document.body)}
      
      {/* Control Bar (Aurora Glass Floating Panel - Focused Elements 1 to 5) */}
      <div className="glass-panel px-4 sm:px-6 py-3.5 flex flex-wrap items-center justify-between gap-4 rounded-[var(--radius-lg)] border border-[rgba(var(--ov),0.12)] bg-[rgba(var(--surface),0.65)] shadow-[0_8px_32px_rgba(0,0,0,0.36)] backdrop-blur-xl">
        {/* Selector 5: Machine Selector & Tool Inventory block */}
        <div className="flex-1 min-w-[280px] max-w-md flex flex-col justify-center gap-1.5">
          <label className="section-label flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wider uppercase text-[var(--text-secondary)]">
              <Settings size={13} className="text-[var(--accent-primary)]"/> Target Machine
            </span>
            <span className="text-[10px] font-mono text-[var(--text-tertiary)] bg-[rgba(var(--ov),0.03)] px-1.5 py-0.5 rounded border border-[var(--border-subtle)]">
              {(toolbox[selectedMachine] || []).length} Tools Loaded
            </span>
          </label>
          <div className="flex items-center gap-2">
            <select 
              value={selectedMachine}
              onChange={(e) => setSelectedMachine(e.target.value as MachineId)}
              className="aurora-input flex-1 h-10 font-semibold cursor-pointer text-xs sm:text-sm py-2 px-3 rounded-[var(--radius-md)] border-[var(--border-subtle)] focus:border-[var(--accent-primary)] transition-colors"
            >
              {MACHINES.map(m => (
                <option key={m} value={m} className="bg-[var(--bg-panel)] text-[var(--text-primary)]">
                  {m} ({(toolbox[m] || []).length} tools)
                </option>
              ))}
            </select>
            {/* Selector 4: Tool Inventory button */}
            <button
              type="button"
              onClick={() => onNavigateToDatabase && onNavigateToDatabase(selectedMachine)}
              className="btn-secondary h-10 px-3.5 flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold shrink-0 rounded-[var(--radius-md)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] hover:bg-[rgba(var(--ov),0.06)] active:scale-[0.98] transition cursor-pointer shadow-xs"
              title={`Open ${selectedMachine} Tool Inventory`}
            >
              <Database size={14} className="text-[var(--accent-primary)]" />
              <span>Tool Inventory</span>
              <ArrowUpRight size={13} className="text-[var(--text-secondary)] opacity-70" />
            </button>
          </div>
        </div>

        {/* Action Buttons Container */}
        <div className="flex items-center gap-2.5 sm:gap-3 flex-wrap">
          {/* Selector 3: Analyze & Remap primary button */}
          <button 
            onClick={handleProcess}
            className="btn-primary h-10 px-5 sm:px-6 flex items-center gap-2 text-xs sm:text-sm font-bold tracking-wide rounded-[var(--radius-md)] shadow-[0_4px_18px_rgba(59,111,212,0.4)] hover:shadow-[0_6px_24px_rgba(59,111,212,0.6)] active:scale-[0.98] transition cursor-pointer"
            title="Analyze G-Code and remap tools to the selected machine"
          >
            <Sparkles size={15} />
            <span>Analyze &amp; Remap</span>
          </button>

          {/* Selector 2: Modify Resolutions button (always stable in DOM to prevent layout jitter) */}
          <button 
            onClick={() => {
              if (blocks.length > 0 && !isStale) {
                setShowModal(true);
              } else {
                handleProcess();
              }
            }}
            className={
              blocks.length > 0
                ? "btn-secondary h-10 px-4 flex items-center gap-2 text-xs sm:text-sm font-semibold rounded-[var(--radius-md)] border border-[var(--orange-500)]/40 bg-[rgba(224,138,77,0.12)] text-[var(--orange-500)] hover:bg-[rgba(224,138,77,0.2)] hover:border-[var(--orange-500)]/60 active:scale-[0.98] transition whitespace-nowrap cursor-pointer shadow-[0_2px_12px_rgba(224,138,77,0.15)]"
                : "btn-secondary h-10 px-4 flex items-center gap-2 text-xs sm:text-sm font-medium rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[rgba(var(--ov),0.02)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:border-[var(--border-strong)] transition whitespace-nowrap cursor-pointer opacity-70"
            }
            title={blocks.length > 0 ? "Inspect and customize tool match resolutions" : "Analyze code first to modify tool resolutions"}
          >
            <Wrench size={14} className={blocks.length > 0 ? "text-[var(--orange-500)]" : "text-[var(--text-tertiary)]"} />
            <span>Modify Resolutions{blocks.length > 0 ? ` (${blocks.length})` : ''}</span>
          </button>
          
          {detectedMat && (
             <div className="h-10 px-3 rounded-[var(--radius-md)] bg-[rgba(59,111,212,0.08)] border border-[rgba(59,111,212,0.25)] flex items-center gap-1.5 text-xs font-mono font-semibold tracking-wider text-[var(--text-secondary)]">
               <span className="text-[10px] text-[var(--text-tertiary)] uppercase">MAT:</span>
               <span className="text-[var(--accent-primary)] font-bold">{detectedMat}</span>
             </div>
          )}
        </div>

        {/* Right Info Helper Tip */}
        <div className="hidden lg:flex items-center gap-2 text-xs text-[var(--text-secondary)] font-normal ml-auto pl-3 border-l border-[var(--border-subtle)]">
          <Info size={14} className="text-[var(--accent-primary)] shrink-0"/>
          <span className="truncate max-w-xs">Analyzes comments to map tools accurately.</span>
        </div>
      </div>

      <CodeEditorPair 
        inputLabel="Source Code"
        outputLabel="Processed Code"
        sourceCode={sourceCode}
        setSourceCode={setSourceCode}
        outputCode={outputCode}
        fileName={fileName}
        setFileName={setFileName}
        onExport={handleExport}
        isOutputStale={isStale}
        onReanalyze={handleProcess}
        onLoadSample={handleLoadFanucSample}
        onLoadHaasSample={handleLoadHaasSample}
      />

      {/* Portaled Modals into document.body to ensure zero top-bar collision and proper viewport bounds */}
      {typeof document !== 'undefined' && createPortal(
        <>
          {/* Resolution Modal */}
          <AnimatePresence>
            {showModal && (
              <motion.div 
                {...iosBackdrop}
                className="fixed inset-0 modal-backdrop flex items-center justify-center p-3 sm:p-5 z-[99999] overflow-hidden"
              >
                <motion.div 
                  {...iosSurface}
                  className="glass-modal max-w-4xl w-full flex flex-col max-h-[82vh] overflow-hidden my-auto shadow-2xl border border-[var(--border-strong)]"
                >
                <div className="p-4 sm:p-5 border-b border-[var(--border-subtle)] flex items-center justify-between shrink-0 bg-[var(--bg-panel)]">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 bg-[var(--orange-500)]/15 border border-[var(--orange-500)]/30 rounded-[var(--radius-md)] text-[var(--orange-500)]">
                      <AlertTriangle size={22} />
                    </div>
                    <div>
                      <h2 className="text-lg sm:text-xl font-bold text-[var(--text-primary)] tracking-tight">Tool Resolution Needed</h2>
                      <p className="text-xs text-[var(--text-secondary)] mt-0.5">Match program tools against {selectedMachine} slots</p>
                    </div>
                  </div>
                  <div className="flex gap-2 items-center">
                    {unresolvedCount > 0 && (
                      <span className="badge-danger text-xs py-1 px-3">
                        {unresolvedCount} Missing
                      </span>
                    )}
                    {blocks.some(b => b.matchType === 'approximate') && (
                      <span className="badge-warning text-xs py-1 px-3">
                        Review Approximates
                      </span>
                    )}
                  </div>
                </div>

                <div className="p-4 sm:p-6 overflow-y-auto space-y-4 bg-[var(--bg-input)] custom-scrollbar flex-1">
                {blocks.map((block, i) => {
                  if (block.skipOperation || (resolutions[block.blockId] && resolutions[block.blockId].description === 'Skip Operation')) {
                    return (
                       <motion.div 
                         {...waveItem(i)}
                         key={block.blockId} 
                         className="group flex flex-col sm:flex-row sm:items-center justify-between p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-sm opacity-70 hover:opacity-100 transition"
                       >
                         <div className="flex items-start gap-3 overflow-hidden">
                           <div className="p-1.5 bg-slate-100 dark:bg-slate-800 text-slate-500 rounded-md mt-0.5">
                             <Trash2 size={18}/>
                           </div>
                           <div className="flex flex-col min-w-0">
                             <span className="font-mono text-sm line-through text-slate-400 dark:text-slate-500 truncate">L{block.lineIndex+1}: {block.originalLine}</span>
                             {block.contextStr && (
                               <span className="font-mono text-xs text-slate-400 dark:text-slate-500 truncate mt-1">Context: {block.contextStr}</span>
                             )}
                           </div>
                         </div>
                         <div className="mt-2 sm:mt-0 flex flex-wrap gap-2 items-center flex-shrink-0">
                           <span className="px-3 py-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 text-xs font-semibold rounded-md">
                             Skipped Operation (Deleted Section)
                           </span>
                           {resolutions[block.blockId] && (
                             <button
                               onClick={() => {
                                 setResolutions(prev => {
                                   const next = { ...prev };
                                   delete next[block.blockId];
                                   return next;
                                 });
                               }}
                               className="text-xs px-2.5 py-1 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 rounded font-semibold border border-blue-200 dark:border-blue-800 transition-colors"
                             >
                               Undo / Change
                             </button>
                           )}
                         </div>
                       </motion.div>
                    );
                  }

                  // HAAS Taraud Exception: requires choosing the machine's taraud or deleting the code section
                  if (block.isHaasTaraudException && (!resolutions[block.blockId] || resolutions[block.blockId].description !== 'Skip Operation')) {
                    if (!resolutions[block.blockId]) {
                      const machineTarauds = mergedAvailableTools.filter(t => t.category === 'taraud');
                      return (
                        <motion.div 
                          {...waveItem(i)}
                          key={block.blockId} 
                          className="bg-white dark:bg-slate-800 border-2 border-purple-400 dark:border-purple-600/70 p-5 rounded-xl shadow-md space-y-4 relative overflow-hidden"
                        >
                          <div className="absolute top-0 left-0 w-1.5 h-full bg-purple-500 dark:bg-purple-600"></div>
                          
                          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <span className="px-2.5 py-0.5 rounded text-xs font-black tracking-wide uppercase bg-purple-100 text-purple-800 dark:bg-purple-900/60 dark:text-purple-200 border border-purple-200 dark:border-purple-800">
                                  Exception: Taraud
                                </span>
                                <span className="text-xs font-bold text-slate-500 dark:text-slate-400">
                                  {selectedMachine} Rule
                                </span>
                              </div>
                              <h3 className="text-base sm:text-lg font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2 pt-1">
                                <AlertCircle size={20} className="text-purple-500 shrink-0"/>
                                Taraud Exception Required
                              </h3>
                            </div>
                          </div>

                          <div className="text-sm font-mono text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-900 p-3 rounded-lg border border-purple-100 dark:border-purple-900/30">
                            <div className="font-semibold text-purple-900 dark:text-purple-200">
                              L{block.lineIndex+1}: {block.originalLine}
                            </div>
                            {block.contextStr && (
                              <div className="text-xs text-slate-500 mt-1.5 border-t border-slate-200 dark:border-slate-800 pt-1.5 break-all">
                                Context: {block.contextStr}
                              </div>
                            )}
                            <div className="flex flex-wrap gap-4 mt-2 text-xs font-mono text-slate-600 dark:text-slate-400">
                              <span>Category: <strong className="text-purple-600 dark:text-purple-400">TARAUD</strong></span>
                              {block.parsedDiameter !== null && <span>Diameter: <strong>D{block.parsedDiameter}</strong></span>}
                              {block.parsedLength !== null && <span>Length: <strong>L{block.parsedLength}</strong></span>}
                            </div>
                          </div>

                          <p className="text-sm text-slate-600 dark:text-slate-400 font-medium">
                            For HAAS machines, taraud operations cannot be automatically mapped. You must either choose the taraud installed in the machine (if one is available) or delete the entire code section using this taraud all the way to the next tool change.
                          </p>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
                            {/* Option 1: Choose Machine Taraud */}
                            <div className="p-4 bg-purple-50/70 dark:bg-purple-950/30 border border-purple-200 dark:border-purple-800/40 rounded-xl flex flex-col justify-between gap-3">
                              <div>
                                <div className="text-xs font-bold uppercase tracking-wider text-purple-900 dark:text-purple-300 mb-1">
                                  Option 1: Machine Taraud
                                </div>
                                <p className="text-xs text-purple-700 dark:text-purple-400">
                                  {machineTarauds.length > 0 
                                    ? (machineTarauds.length === 1 ? 'Use the only taraud installed on this machine:' : 'Select from installed tarauds on this machine:')
                                    : `No taraud is installed on ${selectedMachine}.`}
                                </p>
                              </div>

                              {machineTarauds.length > 0 ? (
                                machineTarauds.length === 1 ? (
                                  <button 
                                    onClick={() => {
                                      setResolutions(prev => ({
                                        ...prev,
                                        [block.blockId]: machineTarauds[0]
                                      }));
                                    }}
                                    className="w-full bg-purple-600 hover:bg-purple-700 active:scale-95 text-white px-4 py-2.5 rounded-lg text-sm font-bold shadow transition flex items-center justify-center gap-2"
                                  >
                                    <CheckCircle size={16}/> Choose Taraud T{machineTarauds[0].number} (D{machineTarauds[0].diameter} L{machineTarauds[0].length})
                                  </button>
                                ) : (
                                  <div className="space-y-2">
                                    {machineTarauds.map(t => (
                                      <button
                                        key={t.id}
                                        onClick={() => {
                                          setResolutions(prev => ({ ...prev, [block.blockId]: t }));
                                        }}
                                        className="w-full bg-white dark:bg-slate-900 hover:bg-purple-50 dark:hover:bg-purple-950/50 border border-purple-300 dark:border-purple-700 text-purple-900 dark:text-purple-200 px-3 py-2 rounded-lg text-xs font-bold shadow-sm transition flex items-center justify-between"
                                      >
                                        <span>T{t.number} - {t.description || 'Taraud'}</span>
                                        <span>D{t.diameter} L{t.length}</span>
                                      </button>
                                    ))}
                                  </div>
                                )
                              ) : (
                                <div className="text-xs text-slate-500 dark:text-slate-400 italic">
                                  Machine has no taraud. Use Option 2 to delete this section or create a tool below.
                                </div>
                              )}
                            </div>

                            {/* Option 2: Delete Code Section */}
                            <div className="p-4 bg-orange-50/70 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-800/40 rounded-xl flex flex-col justify-between gap-3">
                              <div>
                                <div className="text-xs font-bold uppercase tracking-wider text-orange-900 dark:text-orange-300 mb-1">
                                  Option 2: Delete Code Section
                                </div>
                                <p className="text-xs text-orange-700 dark:text-orange-400">
                                  Delete the whole code section using this taraud, all the way until the next tool change.
                                </p>
                              </div>
                              <button 
                                onClick={() => {
                                  setResolutions(prev => ({
                                    ...prev,
                                    [block.blockId]: { id: `dummy-remove-${block.blockId}`, number: 0, category: 'empty', diameter: 0, length: 0, description: 'Skip Operation' }
                                  }));
                                }}
                                className="w-full bg-orange-500 hover:bg-orange-600 active:scale-95 text-white px-4 py-2.5 rounded-lg text-sm font-bold shadow transition flex items-center justify-center gap-2"
                              >
                                <Trash2 size={16}/> Delete Section (Till Next Tool Change)
                              </button>
                            </div>
                          </div>

                          <div className="border-t border-purple-100 dark:border-purple-900/20 pt-2">
                            {renderInlineToolSelector(block, "Or select another tool from toolbox / create new...")}
                          </div>
                        </motion.div>
                      );
                    }
                  }

                  if (block.pendingSkipConfirmation && (!resolutions[block.blockId] || resolutions[block.blockId].description !== 'Skip Operation')) {
                    return (
                       <motion.div 
                         {...waveItem(i)}
                         key={block.blockId} 
                         className="bg-white dark:bg-slate-800 border-2 border-orange-300 dark:border-orange-800/50 p-5 rounded-xl shadow-md space-y-4 relative overflow-hidden"
                       >
                         <div className="absolute top-0 left-0 w-1 h-full bg-orange-400 dark:bg-orange-500"></div>
                         
                         <div className="flex items-start justify-between">
                           <div>
                             <h3 className="font-bold text-orange-900 dark:text-orange-200 flex items-center gap-3">
                               <AlertCircle size={20} className="text-orange-500"/>
                               Unsupported Taraud Tool
                             </h3>
                             <div className="text-sm font-mono text-slate-600 dark:text-slate-300 mt-2 bg-slate-50 dark:bg-slate-900 p-2 rounded border border-orange-100 dark:border-orange-900/30">
                               L{block.lineIndex+1}: {block.originalLine}
                                <div className="text-xs text-slate-500 mt-2 border-t border-orange-200 dark:border-orange-900/40 pt-2 break-all">Context: {block.contextStr}</div>
                              </div>
                              <p className="mt-3 text-sm text-slate-600 dark:text-slate-400 font-medium">
                                The machine cannot execute this operation because the tool diameter is not 6mm. Would you like to remove this operation from the code?
                              </p>
                           </div>
                         </div>
                         <div className="flex flex-col gap-4 pt-3 border-t border-orange-100 dark:border-orange-900/30">
                            <div className="flex justify-end">
                              <button 
                                onClick={() => {
                                  setResolutions(prev => ({
                                    ...prev,
                                    [block.blockId]: { id: `dummy-remove-${block.blockId}`, number: 0, category: 'empty', diameter: 0, length: 0, description: 'Skip Operation' }
                                  }));
                                }}
                                className="bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-lg text-sm font-bold shadow transition-colors flex items-center gap-2"
                              >
                                <Trash2 size={16}/> Confirm Removal
                              </button>
                            </div>
                            <div className="border-t border-orange-100/50 dark:border-orange-900/10 pt-2">
                              {renderInlineToolSelector(block, "Or select a different tool...")}
                            </div>
                          </div>
                       </motion.div>
                    );
                  }

                  const usedTool = resolutions[block.blockId] || block.matchedTool;
                  const hasCrash = usedTool ? usedTool.length < Math.abs(block.minZDepth || 0) : false;

                  const isExactlyResolved = !hasCrash && ((block.matchedTool && block.matchType === 'exact') || resolutions[block.blockId]);
                  const isApproximate = !hasCrash && block.matchedTool && block.matchType === 'approximate' && !resolutions[block.blockId];
                  
                  if (hasCrash) {
                    return (
                       <motion.div 
                         {...waveItem(i)}
                         key={block.blockId} 
                         className="bg-white dark:bg-slate-800 border-2 border-rose-400 dark:border-rose-900/50 p-5 rounded-xl shadow-md space-y-5 relative overflow-hidden"
                       >
                         <div className="absolute top-0 left-0 w-1 h-full bg-rose-500 dark:bg-rose-600"></div>
                         
                         <div className="flex flex-col sm:flex-row gap-4 justify-between items-start">
                           <div className="space-y-2 flex-1">
                             <h3 className="font-bold text-rose-800 dark:text-rose-200 flex items-center gap-3">
                               <AlertCircle size={20} className="text-rose-500"/>
                               Tool Too Short (Crash Risk)
                             </h3>
                             <div className="font-mono text-sm bg-rose-50 dark:bg-rose-950/30 px-3 py-2 rounded-lg border border-rose-100 dark:border-rose-900/40 text-slate-700 dark:text-slate-300">
                               L{block.lineIndex+1}: {block.originalLine}
                               <div className="text-xs text-slate-500 mt-2 border-t border-rose-200 dark:border-rose-900/40 pt-2 break-all">Context: {block.contextStr}</div>
                             </div>
                             <p className="text-sm text-rose-700 dark:text-rose-300 font-medium">
                               The selected tool (T{usedTool!.number} {usedTool!.category.toUpperCase()}) has a length of <span className="font-bold">{usedTool!.length}mm</span> but the program reaches a deep Z of <span className="font-bold font-mono">Z-{Math.abs(block.minZDepth || 0)}</span>.
                             </p>
                           </div>
                         </div>
                         
                         <div className="pt-3 border-t border-rose-100 dark:border-rose-900/30">
                            {renderInlineToolSelector(block, "Change to a longer tool...")}
                          </div>
                       </motion.div>
                    );
                  }

                  if (isExactlyResolved) {
                    const blockResolutionId = resolutions[block.blockId]?.id || '';
                    return (
                       <motion.div 
                         {...waveItem(i)}
                         key={block.blockId} 
                         className="group flex flex-col sm:flex-row sm:items-center justify-between p-4 bg-white dark:bg-slate-900 border border-emerald-200 dark:border-emerald-900/50 rounded-xl shadow-sm hover:shadow transition"
                       >
                         <div className="flex items-start gap-3 overflow-hidden">
                           <div className="p-1.5 bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400 rounded-md mt-0.5">
                             <CheckCircle size={18}/>
                           </div>
                           <div className="flex flex-col min-w-0">
                             <span className="font-mono text-sm dark:text-slate-300 truncate">L{block.lineIndex+1}: {block.originalLine}</span>
                             {block.contextStr && (
                               <span className="font-mono text-xs text-slate-500 dark:text-slate-400 truncate mt-1">Context: {block.contextStr}</span>
                             )}
                           </div>
                         </div>
                         <div className="mt-2 sm:mt-0 flex flex-wrap gap-2 items-center flex-shrink-0">
                           <span className="px-3 py-1 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 text-xs font-semibold rounded-md border border-emerald-100 dark:border-emerald-800/30">
                             {block.isHaasTaraudException ? 'Taraud Resolved' : (resolutions[block.blockId] ? 'Manually Resolved' : 'Perfect Match')}
                           </span>
                           
                           {block.isHaasTaraudException && (
                             <button
                               onClick={() => {
                                 setResolutions(prev => ({
                                   ...prev,
                                   [block.blockId]: { id: `dummy-remove-${block.blockId}`, number: 0, category: 'empty', diameter: 0, length: 0, description: 'Skip Operation' }
                                 }));
                               }}
                               className="text-xs px-2.5 py-1 text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-950/40 rounded font-semibold border border-orange-200 dark:border-orange-800 transition-colors flex items-center gap-1"
                               title="Delete entire code section using this taraud until next tool change"
                             >
                               <Trash2 size={13} />
                               Delete Section Instead
                             </button>
                           )}
                           
                           {resolutions[block.blockId] && (
                              <select 
                                className="text-xs rounded border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 dark:text-slate-200 py-1 shadow-sm font-semibold"
                                value={blockResolutionId}
                                onChange={(e) => {
                                  const selectedTool = mergedAvailableTools.find(t => t.id === e.target.value);
                                  if (selectedTool) {
                                    setResolutions(prev => ({...prev, [block.blockId]: selectedTool}));
                                  }
                                }}
                              >
                                {mergedAvailableTools.filter(t => t.category !== 'empty').map(t => (
                                   <option key={t.id} value={t.id}>
                                     {t.pocket !== undefined ? `[${t.pocket}] ` : ''}T{t.number} ({t.category.toUpperCase()} D{t.diameter})
                                   </option>
                                ))}
                              </select>
                           )}

                           {!resolutions[block.blockId] && block.matchedTool && (
                             <span className="text-xs text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">
                               T{block.matchedTool.number} ({block.matchedTool.category.toUpperCase()} D{block.matchedTool.diameter})
                             </span>
                           )}
                         </div>
                       </motion.div>
                    );
                  }

                  if (isApproximate) {
                    return (
                       <motion.div 
                         {...waveItem(i)}
                         key={block.blockId} 
                         className="flex flex-col p-5 bg-gradient-to-r from-amber-50 to-white dark:from-amber-950/20 dark:to-slate-900 border border-amber-300 dark:border-amber-700/50 rounded-xl shadow-md space-y-4 relative overflow-hidden"
                       >
                         <div className="absolute top-0 left-0 w-1 h-full bg-amber-400 dark:bg-amber-500"></div>
                         
                         <div className="flex items-start justify-between">
                           <div>
                             <h3 className="font-bold text-amber-900 dark:text-amber-100 flex items-center gap-3">
                               <AlertCircle size={20} className="text-amber-500"/>
                               Approximate Match Used
                             </h3>
                             <div className="text-sm font-mono text-slate-600 dark:text-slate-300 mt-2 bg-white/50 dark:bg-black/20 p-2 rounded border border-amber-100 dark:border-amber-900/30">
                               L{block.lineIndex+1}: {block.originalLine}
                                <div className="text-xs text-slate-500 mt-2 border-t border-amber-200 dark:border-amber-900/40 pt-2 break-all">Context: {block.contextStr}</div>
                              </div>
                              <div className="mt-4 grid grid-cols-2 gap-3 text-xs w-full sm:w-auto">
                                <div className="bg-white/50 dark:bg-black/20 p-2 rounded border border-amber-100 dark:border-amber-900/40">
                                  <div className="text-slate-400 font-semibold uppercase tracking-wider mb-0.5">Required</div>
                                  <div className="font-medium text-slate-700 dark:text-slate-300">
                                    {(block.parsedCategory)?.toUpperCase() || "?"} D{block.parsedDiameter ?? "?"} L{block.parsedLength ?? "?"}
                                    <div className="text-amber-600 dark:text-amber-500 text-[10px] mt-0.5">Req Min: {block.minZDepth !== undefined ? Math.abs(block.minZDepth) + 1 : "?"}mm</div>
                                  </div>
                                </div>
                                <div className="bg-white/50 dark:bg-black/20 p-2 rounded border border-amber-100 dark:border-amber-900/40">
                                  <div className="text-slate-400 font-semibold uppercase tracking-wider mb-0.5">Assigned</div>
                                  <div className="font-medium text-amber-700 dark:text-amber-400">
                                    {(block.matchedTool?.category)?.toUpperCase() || "?"} D{block.matchedTool?.diameter ?? "?"} L{block.matchedTool?.length ?? "?"}
                                  </div>
                                </div>
                              </div>
                            </div>
                            <div className="text-right flex-shrink-0 ml-4 hidden sm:block">
                             <div className="text-xs text-slate-500 dark:text-slate-400 uppercase font-bold tracking-wider mb-1">Assigned Tool</div>
                             <div className="relative text-lg font-black text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/40 px-3 py-1 mt-2 rounded-lg">
                               {block.matchedTool?.pocket !== undefined && (
                                 <div className="absolute -top-3 -right-3 w-6 h-6 bg-red-500 rounded-full text-white flex items-center justify-center text-xs font-bold shadow-sm">
                                   {block.matchedTool.pocket}
                                 </div>
                               )}
                               T{block.matchedTool?.number}
                               <div className="text-xs font-semibold uppercase tracking-wide opacity-80 mt-0.5">
                                 {block.matchedTool?.category} D{block.matchedTool?.diameter}
                               </div>
                             </div>
                           </div>
                         </div>
                         
                         <div className="flex flex-wrap gap-x-8 gap-y-3 p-4 bg-white dark:bg-slate-800 rounded-lg border border-amber-100 dark:border-slate-700 shadow-inner">
                           <div className="flex-1 min-w-[120px]">
                             <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">Required Min Depth</div>
                             <div className="font-mono text-sm font-semibold dark:text-slate-200">Z{block.minZDepth ?? 0} ({Math.abs(block.minZDepth || 0) + 1}mm)</div>
                           </div>
                           <div className="flex-1 min-w-[120px]">
                             <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">Chosen Tool Length</div>
                             <div className="font-mono text-sm font-bold text-emerald-600 dark:text-emerald-400">{block.matchedTool?.length}mm (Safe)</div>
                           </div>
                           <div className="flex-1 min-w-[120px]">
                             <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">Requested Length</div>
                             <div className="font-mono text-sm font-semibold dark:text-slate-200">{block.parsedLength}mm</div>
                           </div>
                         </div>
                         
                         {/* Option to override */}
                         <div className="flex justify-end border-t border-amber-100 dark:border-amber-900/30 pt-3">
                           <select 
                             className="text-sm rounded border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 dark:text-slate-200 py-1.5 shadow-sm"
                             value=""
                             onChange={(e) => {
                               const selectedTool = mergedAvailableTools.find(t => t.id === e.target.value);
                               if (selectedTool) {
                                 setResolutions(prev => ({...prev, [block.blockId]: selectedTool}));
                               }
                             }}
                           >
                             <option value="" disabled>Change Tool...</option>
                             {mergedAvailableTools.filter(t => t.category !== 'empty').map(t => (
                                <option key={t.id} value={t.id}>
                                  {t.pocket !== undefined ? `[${t.pocket}] ` : ''}T{t.number} - {t.category.toUpperCase()} D{t.diameter} L{t.length}
                                </option>
                             ))}
                           </select>
                         </div>
                       </motion.div>
                    );
                  }

                  // Needs resolution
                  return (
                    <motion.div 
                      {...waveItem(i)}
                      key={block.blockId} 
                      className="bg-white dark:bg-slate-800 border-2 border-red-200 dark:border-red-900/30 p-5 rounded-xl shadow-md space-y-5 relative overflow-hidden"
                    >
                      <div className="absolute top-0 left-0 w-1 h-full bg-red-400 dark:bg-red-600"></div>
                      
                      <div className="flex flex-col sm:flex-row gap-4 justify-between items-start">
                        <div className="space-y-2 flex-1">
                          <h3 className="font-bold text-slate-800 dark:text-slate-100 flex items-center gap-3">
                            <span className="bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400 px-2.5 py-0.5 rounded text-xs font-black tracking-wide uppercase">Missing Tool L{block.lineIndex+1}</span>
                          </h3>
                          <div className="font-mono text-sm bg-slate-100 dark:bg-slate-900 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300">
                            {block.originalLine}
                            <div className="text-xs text-slate-500 mt-2 border-t border-slate-200 dark:border-slate-700 pt-2 break-all">Context: {block.contextStr}</div>
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-4 text-sm bg-slate-50 dark:bg-slate-900/50 p-4 rounded-lg border border-slate-100 dark:border-slate-800 shadow-inner">
                        <div>
                          <div className="text-slate-400 text-xs mb-1 uppercase tracking-wider font-semibold">Category</div>
                          <div className="font-medium text-slate-900 dark:text-slate-100">{block.parsedCategory || '?'}</div>
                        </div>
                        <div>
                          <div className="text-slate-400 text-xs mb-1 uppercase tracking-wider font-semibold">Diameter</div>
                          <div className="font-medium text-slate-900 dark:text-slate-100">{block.parsedDiameter !== null ? block.parsedDiameter : '?'}</div>
                        </div>
                        <div>
                          <div className="text-slate-400 text-xs mb-1 uppercase tracking-wider font-semibold">Length</div>
                          <div className="font-medium text-slate-900 dark:text-slate-100">
                            {block.parsedLength !== null ? block.parsedLength : '?'}
                            <div className="text-xs text-rose-500 mt-1 font-semibold">Req: {block.minZDepth !== undefined ? Math.abs(block.minZDepth) + 1 : '?'}mm min</div>
                          </div>
                        </div>
                      </div>

                      {renderInlineToolSelector(block)}
                    </motion.div>
                  );
                })}
              </div>

              <div className="p-5 border-t border-[var(--border-subtle)] bg-[var(--bg-panel)] flex justify-between items-center shadow-lg relative z-10">
                 <button 
                   onClick={() => setShowModal(false)} 
                   className="btn-secondary text-sm py-2 px-5"
                 >
                   Cancel
                 </button>
                 <button 
                   onClick={handleApplyResolutions} 
                   disabled={unresolvedCount > 0}
                   className="btn-primary text-sm py-2.5 px-6 flex items-center gap-2"
                 >
                   {unresolvedCount > 0 ? `${unresolvedCount} Tool(s) Still Missing` : 'Apply & Generate Code'}
                 </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Crash Warning Modal */}
      <AnimatePresence>
        {showCrashAlert && (
          <motion.div 
            {...iosBackdrop}
            className="fixed inset-0 modal-backdrop flex items-center justify-center p-6 z-[99999]"
          >
             <motion.div 
              {...iosSurface}
              className="glass-modal p-8 max-w-lg w-full border-2 border-[var(--rose-500)]"
            >
              <div className="flex items-center gap-4 mb-6">
                <div className="p-3 bg-[var(--rose-500)]/15 border border-[var(--rose-500)]/30 text-[var(--rose-500)] rounded-full">
                  <AlertTriangle size={32} />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-[var(--rose-500)]">CRITICAL WARNING</h3>
                  <p className="text-[var(--text-secondary)] text-sm mt-1">Short Z Length Detected</p>
                </div>
              </div>
              <div className="space-y-4 mb-8 text-[var(--text-secondary)] text-sm leading-relaxed">
                <p>
                  Some tools appear to have a Z length shorter than the deepest Z requested in their operation. <strong className="text-[var(--text-primary)]">This might cause a physical collision or crash!</strong>
                </p>
                <p>
                  Have you physically verified that these tools are long enough or that it is safe to proceed?
                </p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowCrashAlert(false)}
                  className="btn-secondary flex-1 py-2.5 text-sm"
                >
                  Go Back
                </button>
                <button
                  onClick={proceedWithApplyResolutions}
                  className="btn-danger flex-1 py-2.5 text-sm"
                >
                  I&apos;m Sure, Proceed
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Checklist Modal */}
      <AnimatePresence>
        {showChecklist && (
          <motion.div 
            {...iosBackdrop}
            className="fixed inset-0 modal-backdrop flex items-center justify-center p-6 z-[99999]"
          >
            <motion.div 
              {...iosSurface}
              className="glass-modal p-8 max-w-lg w-full"
            >
              <div className="flex items-center gap-4 mb-6">
                <div className="p-3 bg-[var(--blue-500)]/15 border border-[var(--blue-500)]/30 text-[var(--blue-500)] rounded-full">
                  <CheckCircle size={24} />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-[var(--text-primary)]">Review Tool Changes</h3>
                  <p className="text-[var(--text-secondary)] text-sm mt-1">These tools will be saved to the database.</p>
                </div>
              </div>
              <ul className="space-y-2 mb-8 max-h-60 overflow-y-auto custom-scrollbar pr-2">
                 {pendingToolboxAdditions.map(pt => (
                    <li key={pt.id} className="flex flex-col bg-[var(--bg-card)] p-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
                       <span className="font-bold text-[var(--text-primary)]">T{pt.number} - {pt.category.toUpperCase()} D{pt.diameter}</span>
                       <span className="text-xs text-[var(--text-secondary)] mt-1">{pt.description || "No description"}</span>
                    </li>
                 ))}
              </ul>
              <div className="flex gap-3">
                <button 
                  onClick={() => { setShowChecklist(false); setShowModal(true); }}
                  className="btn-secondary flex-1 py-2.5 text-sm"
                >
                  Go Back
                </button>
                <button 
                  onClick={confirmChecklist}
                  disabled={isInstalling}
                  className="btn-primary flex-1 py-2.5 text-sm flex items-center justify-center gap-2"
                >
                  {isInstalling ? 'Saving to inventory...' : <>Approve &amp; Install</>}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Special Checklist Modal */}
      <AnimatePresence>
        {showSpecialChecklist && (
          <motion.div 
            {...iosBackdrop}
            className="fixed inset-0 modal-backdrop flex items-center justify-center p-6 z-[99999]"
          >
            <motion.div 
              {...iosSurface}
              className="glass-modal overflow-hidden max-w-lg w-full"
            >
              <div className="p-6 border-b border-[var(--border-subtle)] bg-[rgba(255,102,121,0.08)]">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 bg-[var(--rose-500)]/15 border border-[var(--rose-500)]/30 text-[var(--rose-500)] rounded-[var(--radius-md)]">
                    <AlertTriangle size={24} />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-[var(--rose-500)]">Special Tools Checklist</h3>
                    <p className="text-[var(--text-secondary)] text-xs mt-1">Please confirm you have these critical tools set up correctly.</p>
                  </div>
                </div>
              </div>
              <div className="p-6 space-y-3 max-h-80 overflow-y-auto">
                 {specialToolsToCheck.map(t => (
                    <label key={t.number} className={`flex items-center gap-4 p-4 rounded-[var(--radius-md)] border transition cursor-pointer ${
                      checkedSpecialTools.has(t.number) 
                        ? 'border-[var(--green-500)] bg-[rgba(22,163,74,0.12)]' 
                        : 'border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--bg-card-hover)]'
                    }`}>
                       <input 
                         type="checkbox" 
                         className="w-5 h-5 rounded border-[var(--border-strong)] text-[var(--green-500)] focus:ring-[var(--green-500)] cursor-pointer"
                         checked={checkedSpecialTools.has(t.number)}
                         onChange={(e) => {
                           setCheckedSpecialTools(prev => {
                             const next = new Set(prev);
                             if (e.target.checked) next.add(t.number);
                             else next.delete(t.number);
                             return next;
                           });
                         }}
                       />
                       <div>
                         <span className="font-bold text-[var(--text-primary)] block">
                           {t.pocket !== undefined && (
                             <span className="inline-flex items-center justify-center w-5 h-5 mr-2 bg-[var(--rose-500)] rounded-full text-white text-[10px] font-bold">
                               {t.pocket}
                             </span>
                           )}
                           T{t.number} - {t.category.toUpperCase()} D{t.diameter}
                         </span>
                         <span className="text-xs text-[var(--text-tertiary)] font-medium">Verify diameter and physical condition.</span>
                       </div>
                    </label>
                 ))}
              </div>
              <div className="p-4 bg-[var(--bg-panel)] border-t border-[var(--border-subtle)] flex justify-end gap-3">
                <button 
                  onClick={() => setShowSpecialChecklist(false)}
                  className="btn-secondary text-xs py-2 px-4"
                >
                  Cancel
                </button>
                <button 
                  onClick={() => {
                    setShowSpecialChecklist(false);
                    setShowConfirm(true);
                  }}
                  disabled={checkedSpecialTools.size < specialToolsToCheck.length}
                  className="btn-warning text-xs py-2 px-5"
                >
                  Confirm Checked Tools
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Confirmation Modal */}
      <AnimatePresence>
        {showConfirm && (
          <motion.div 
            {...iosBackdrop}
            className="fixed inset-0 modal-backdrop flex items-center justify-center p-6 z-[99999]"
          >
            <motion.div 
              {...iosSurface}
              className="glass-modal max-w-md w-full overflow-hidden"
            >
              <div className="p-6 text-center space-y-4">
                <div className="mx-auto w-16 h-16 bg-[var(--orange-500)]/15 border border-[var(--orange-500)]/30 text-[var(--orange-500)] rounded-full flex items-center justify-center mb-4">
                  <AlertTriangle size={32} />
                </div>
                <h2 className="text-2xl font-bold text-[var(--text-primary)] tracking-tight">Warning before generation</h2>
                <p className="text-[var(--text-secondary)] text-sm leading-relaxed">
                  You are about to generate the final G-code program.
                  <br /><br />
                  <strong className="text-[var(--orange-500)]">Important:</strong> Please ensure that you load the correct tools into the machine physically as generated in the new code. Running an incorrect tool can lead to machine crash or part destruction.
                </p>
              </div>
              <div className="p-4 bg-[var(--bg-panel)] border-t border-[var(--border-subtle)] flex gap-3 justify-end">
                 <button 
                   onClick={() => {
                     setShowConfirm(false);
                     setShowModal(true);
                   }}
                   className="btn-secondary text-xs py-2 px-4"
                 >
                   Go Back &amp; Modify
                 </button>
                 <button 
                   onClick={finalizeCodeGeneration}
                   className="btn-warning text-xs py-2 px-5 flex items-center gap-2"
                 >
                   Confirm &amp; Generate
                 </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
        </>,
        document.body
      )}
    </div>
  );
}

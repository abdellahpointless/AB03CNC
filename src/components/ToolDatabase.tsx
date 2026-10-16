import React, { useState, useMemo } from 'react';
import { Tool, MachineId, MACHINES, TOOL_CATEGORIES, ToolCategory, MATERIALS, Material } from '../types';
import { Plus, Trash2, Check, Server, CircleDashed, AlertCircle, RefreshCw } from 'lucide-react';
import { useSync } from '../contexts/SyncContext';
import { DrillIcon, EndMillIcon, RoughingEndMillIcon, BallNoseIcon, ChamferIcon, CenterDrillIcon, FaceMillIcon, TapIcon, EmptyIcon } from './ToolIcons';

interface ToolDatabaseProps {
  selectedMachine?: MachineId;
  setSelectedMachine?: (val: MachineId) => void;
}

export default function ToolDatabase({ 
  selectedMachine: propSelectedMachine,
  setSelectedMachine: propSetSelectedMachine
}: ToolDatabaseProps) {
  const { toolbox, toolboxLoaded, connection, saveTool, deleteTool, acknowledgeTool } = useSync();
  const [isSaving, setIsSaving] = useState(false);
  const [internalSelectedMachine, setInternalSelectedMachine] = useState<MachineId>('HAAS-1');
  const selectedMachine = propSelectedMachine ?? internalSelectedMachine;
  const setSelectedMachine = propSetSelectedMachine ?? setInternalSelectedMachine;
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [toolForm, setToolForm] = useState<Partial<Tool>>({
    number: '' as any,
    category: 'foret',
    description: '',
    diameter: '' as any,
    length: '' as any,
  });

  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const toggleMaterial = (mat: Material) => {
    setToolForm(prev => {
      const mats = prev.materials || [];
      if (mats.includes(mat)) {
        return { ...prev, materials: mats.filter(m => m !== mat) };
      }
      return { ...prev, materials: [...mats, mat] };
    });
  };

  const rawTools = toolbox[selectedMachine] || [];
  // Sort from smaller to larger T number
  const toolsForMachine = useMemo(() => {
    return [...rawTools].sort((a, b) => {
      const posA = a.pocket ?? a.number;
      const posB = b.pocket ?? b.number;
      return posA - posB;
    });
  }, [rawTools]);

  const generateId = () => crypto.randomUUID().slice(0, 13);

  const openAdd = () => {
    setIsAdding(true);
    setEditingId(null);
    setExpandedId(null);
    setErrorMsg(null);
    setToolForm({ number: '' as any, pocket: '' as any, category: 'foret', description: '', diameter: '' as any, length: '' as any });
  };

  const cancelForm = () => {
    setIsAdding(false);
    setEditingId(null);
    setErrorMsg(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!toolForm.number || isSaving) return;

    const num = Number(toolForm.number);
    
    if (num > 41 && selectedMachine === 'HAAS-1') {
      setErrorMsg(`HAAS-1 has a maximum of 41 tool slots!`);
      return;
    }

    const isEmptySlot = !toolForm.description?.trim() && !toolForm.diameter && !toolForm.length;
    let categoryToUse = toolForm.category || 'empty';
    if (isEmptySlot) {
      categoryToUse = 'empty';
    }

    // Check for unique T-number
    const existingTool = toolsForMachine.find(t => t.number === num);
    if (existingTool && existingTool.id !== editingId && existingTool.category !== 'empty') {
      setErrorMsg(`T-number ${num} is already used by another tool!`);
      return;
    }

    // Ensure tool description has a fallback name if left empty
    const resolvedDescription = toolForm.description?.trim() 
      ? toolForm.description.trim() 
      : (categoryToUse === 'empty' ? 'Empty Slot' : `${categoryToUse.toUpperCase()} D${toolForm.diameter || '-'}`);

    const newTool: Tool = {
      id: editingId || (existingTool ? existingTool.id : generateId()),
      number: num,
      pocket: toolForm.pocket ? Number(toolForm.pocket) : undefined,
      category: categoryToUse,
      description: resolvedDescription,
      diameter: Number(toolForm.diameter) || 0,
      length: Number(toolForm.length) || 0,
      materials: toolForm.materials,
      changed: true
    };

    setIsSaving(true);
    setErrorMsg(null);
    try {
      await saveTool(selectedMachine, newTool);
      cancelForm();
      setExpandedId(null);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Could not save the tool. Check the connection and try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm("Are you sure you want to remove this tool?")) return;
    setIsSaving(true);
    try {
      await deleteTool(selectedMachine, id);
      if (expandedId === id) setExpandedId(null);
      if (editingId === id) cancelForm();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Could not delete the tool.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleToolClick = (tool: Tool) => {
    if (tool.changed) {
      acknowledgeTool(selectedMachine, tool.id);
    }

    if (expandedId === tool.id) {
      setExpandedId(null);
      if (editingId === tool.id) {
        setIsAdding(false);
        setEditingId(null);
      }
    } else {
      setExpandedId(tool.id);
      setIsAdding(true);
      setEditingId(tool.id);
      setErrorMsg(null);
      setToolForm({ ...tool });
    }
  };

  const getToolIcon = (category: string) => {
    switch(category.toLowerCase()) {
      case 'foret': return <DrillIcon size={18} />;
      case 'fraise': return <EndMillIcon size={18} />;
      case 'fraise ebauche': return <RoughingEndMillIcon size={18} />;
      case 'fraise finition': return <EndMillIcon size={18} />;
      case 'pointeur': return <CenterDrillIcon size={18} />;
      case 'chanfrein': return <ChamferIcon size={18} />;
      case 'tourteau': return <FaceMillIcon size={18} />;
      case 'fraise boule': return <BallNoseIcon size={18} />;
      case 'taraud': return <TapIcon size={18} />;
      case 'empty': return <EmptyIcon size={18}  />;
      default: return <EndMillIcon size={18} />;
    }
  };

  return (
    <div className="flex flex-col h-full space-y-4 max-w-7xl mx-auto w-full pb-12">
      {/* Top Header Panel */}
      <div className="glass-panel p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-[var(--radius-md)] bg-[var(--blue-500)]/15 border border-[var(--blue-500)]/30 text-[var(--blue-500)]">
              <Server size={20} />
            </div>
            <h2 className="text-xl font-bold text-[var(--text-primary)]">
              Tool Inventory Database
            </h2>
          </div>
          <p className="text-xs text-[var(--text-secondary)] mt-1.5 pl-1">
            Configure physical slot allocations, macros, categories, and tool dimensions per machine.
          </p>
        </div>
        
        <div className="flex items-center gap-3">
          <div className="w-48">
            <select 
              value={selectedMachine}
              onChange={(e) => {
                setSelectedMachine(e.target.value as MachineId);
                cancelForm();
                setExpandedId(null);
              }}
              className="aurora-input w-full font-semibold cursor-pointer text-xs py-2"
            >
              {MACHINES.map(m => (
                <option key={m} value={m} className="bg-[var(--bg-panel)] text-[var(--text-primary)]">{m}</option>
              ))}
            </select>
          </div>

          {!isAdding && (
            <button
              onClick={openAdd}
              className="btn-primary text-xs py-2 px-4 whitespace-nowrap"
            >
              <Plus size={15} />
              <span>Add Tool</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Database Container */}
      <div className="aurora-card p-0 flex flex-col overflow-hidden">
        {/* Table Top Header */}
        <div className="px-5 py-3.5 border-b border-[var(--border-subtle)] bg-[rgba(var(--surface),0.6)] flex justify-between items-center">
          <div className="flex items-center gap-2">
            <span className="section-label text-[var(--text-primary)]">
              {selectedMachine} Slots
            </span>
            <span className="badge-neutral text-[10px] py-0 px-2 font-mono">
              {toolsForMachine.length} tools
            </span>
          </div>
          <span className="text-[11px] text-[var(--text-tertiary)] flex items-center gap-1.5">
            {!toolboxLoaded && connection !== 'offline' && <RefreshCw size={11} className="animate-spin" />}
            {connection === 'offline' ? 'Offline - showing the last saved copy (read only)' : 'Click any row to edit or view details'}
          </span>
        </div>

        {/* Content Area */}
        <div className="p-4 md:p-6 space-y-3 overflow-y-auto">
          {/* Add New Tool Form Card */}
          {isAdding && !editingId && (
            <div className="glass-panel p-5 mb-4 border border-[var(--blue-500)]/40 animate-in fade-in zoom-in-95 duration-200">
              <div className="flex items-center gap-2 mb-4">
                <span className="section-label text-[var(--blue-500)]">
                  Add New Tool to {selectedMachine}
                </span>
              </div>
              <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="col-span-1 md:col-span-3">
                  <label className="section-label block mb-1.5 text-[var(--accent-primary)] font-bold">
                    Tool Name / Description*
                  </label>
                  <input 
                    type="text" 
                    value={toolForm.description || ''} 
                    onChange={e => setToolForm({ ...toolForm, description: e.target.value })}
                    className="aurora-input w-full text-xs font-semibold"
                    placeholder="e.g. Foret D4, Fraise ébauche D16, ST_10.00_050..."
                  />
                </div>
                <div>
                  <label className="section-label block mb-1.5">Tool No. (Macros)*</label>
                  <input 
                    type="number" 
                    required 
                    value={toolForm.number || ''} 
                    onChange={e => setToolForm({ ...toolForm, number: e.target.value as any })}
                    className="aurora-input w-full text-xs"
                    placeholder="e.g. 10"
                  />
                </div>
                <div>
                  <label className="section-label block mb-1.5">Position / Slot (Optional)</label>
                  <input 
                    type="number" 
                    value={toolForm.pocket || ''} 
                    onChange={e => setToolForm({ ...toolForm, pocket: e.target.value as any })}
                    className="aurora-input w-full text-xs"
                    placeholder="Physical pocket"
                  />
                </div>
                <div>
                  <label className="section-label block mb-1.5">Category</label>
                  <select 
                    value={toolForm.category || 'empty'} 
                    onChange={e => setToolForm({ ...toolForm, category: e.target.value as ToolCategory })}
                    className="aurora-input w-full text-xs cursor-pointer"
                  >
                    {TOOL_CATEGORIES.map(cat => <option key={cat} value={cat} className="bg-[var(--bg-panel)]">{cat.toUpperCase()}</option>)}
                  </select>
                </div>
                <div>
                  <label className="section-label block mb-1.5">Diameter (mm)</label>
                  <input 
                    type="number" 
                    step="0.01" 
                    value={toolForm.diameter || ''} 
                    onChange={e => setToolForm({ ...toolForm, diameter: e.target.value as any })}
                    className="aurora-input w-full text-xs"
                  />
                </div>
                <div>
                  <label className="section-label block mb-1.5">Length (mm)</label>
                  <input 
                    type="number" 
                    step="0.01" 
                    value={toolForm.length || ''} 
                    onChange={e => setToolForm({ ...toolForm, length: e.target.value as any })}
                    className="aurora-input w-full text-xs"
                  />
                </div>
                <div className="col-span-1 md:col-span-3">
                  <label className="section-label block mb-1.5">Materials supported (optional)</label>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {MATERIALS.map(mat => {
                      const isSelected = (toolForm.materials || []).includes(mat);
                      return (
                        <button 
                          key={mat} 
                          type="button" 
                          onClick={() => toggleMaterial(mat)}
                          className={`px-2.5 py-1 text-xs font-medium rounded-full border transition cursor-pointer ${
                            isSelected 
                              ? 'badge-positive border-[var(--green-500)] text-[var(--green-500)]' 
                              : 'badge-neutral'
                          }`}
                        >
                          {mat}
                        </button>
                      );
                    })}
                  </div>
                </div>
                
                {errorMsg && (
                  <div className="col-span-1 md:col-span-3 badge-danger py-2 px-3 text-xs font-semibold">
                    {errorMsg}
                  </div>
                )}
                
                <div className="col-span-1 md:col-span-3 flex justify-end gap-3 mt-2">
                  <button 
                    type="button" 
                    onClick={cancelForm} 
                    className="btn-secondary text-xs py-2 px-4"
                  >
                    Cancel
                  </button>
                  <button 
                    type="submit" 
                    disabled={isSaving || connection === 'offline'}
                    className="btn-primary text-xs py-2 px-5"
                  >
                    {isSaving ? <RefreshCw size={14} className="animate-spin" /> : <Check size={14}/>}
                    <span>{isSaving ? 'Saving...' : 'Save Tool'}</span>
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* List of Tools */}
          <div className="flex flex-col gap-2.5">
            {toolsForMachine.map(tool => {
              const isChanged = tool.changed;
              const isExpanded = expandedId === tool.id;

              return (
                <div 
                  key={tool.id} 
                  className={`flex flex-col rounded-[var(--radius-md)] border transition ${
                    isChanged 
                      ? 'border-[var(--orange-500)]/50 bg-[rgba(224,138,77,0.08)]' 
                      : 'border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--bg-card-hover)]'
                  }`}
                >
                  {/* Tool Data Row */}
                  <div 
                    onClick={() => handleToolClick(tool)}
                    className="flex flex-col sm:flex-row items-start sm:items-center p-3.5 sm:p-4 gap-4 cursor-pointer transition-colors"
                  >
                    <div className="flex items-center gap-4 min-w-[200px]">
                      <div className={`relative flex items-center justify-center p-2 rounded-[var(--radius-sm)] font-bold w-full max-w-[100px] shrink-0 gap-2 ${
                        isChanged ? 'bg-[var(--orange-500)] text-white shadow-[0_0_8px_var(--orange-glow)]' : 'bg-[var(--bg-input)] border border-[var(--border-subtle)] text-[var(--text-primary)]'
                      }`}>
                        {tool.pocket !== undefined && (
                          <div className="absolute -top-2 -left-2 w-5 h-5 bg-[var(--rose-500)] rounded-full text-white flex items-center justify-center text-[10px] font-bold shadow-xs">
                            {tool.pocket}
                          </div>
                        )}
                        {getToolIcon(tool.category)}
                        <span className="font-mono text-xs">T{tool.number}</span>
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="font-bold text-xs text-[var(--text-primary)] truncate max-w-[200px]" title={tool.description}>
                          {tool.description ? tool.description : (tool.category === 'empty' ? 'Empty Slot' : `${tool.category.toUpperCase()} D${tool.diameter}`)}
                        </span>
                        <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] mt-0.5 font-mono">
                          <span className="capitalize">{tool.category === 'empty' ? 'Empty Slot' : tool.category}</span>
                          {tool.pocket !== undefined && (
                            <>
                              <span>•</span>
                              <span>Slot {tool.pocket}</span>
                            </>
                          )}
                        </div>
                        {tool.materials && tool.materials.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {tool.materials.map(m => (
                              <span key={m} className="badge-neutral text-[9px] py-0 px-1 font-semibold">{m}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex-1 flex gap-8 font-mono text-xs">
                      {tool.category !== 'empty' && (
                        <>
                          <div className="flex items-center gap-2">
                            <span className="text-[var(--text-tertiary)] font-bold text-[10px] tracking-wider">DIA</span>
                            <span className="text-[var(--text-primary)] font-bold tabular-nums">
                              {tool.diameter ? tool.diameter.toFixed(2) : '-'} mm
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[var(--text-tertiary)] font-bold text-[10px] tracking-wider">LEN</span>
                            <span className="text-[var(--text-primary)] font-bold tabular-nums">
                              {tool.length ? tool.length.toFixed(2) : '-'} mm
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                    
                    {isChanged && (
                      <div className="hidden md:flex items-center gap-1.5 text-[10px] font-bold badge-warning py-0.5 px-2">
                        <AlertCircle size={12}/> MODIFIED
                      </div>
                    )}
                  </div>

                  {/* Inline Edit Form when Expanded */}
                  {isExpanded && editingId === tool.id && (
                    <div className="p-4 bg-[var(--bg-input)] border-t border-[var(--border-subtle)] rounded-b-[var(--radius-md)] animate-in fade-in duration-150">
                      <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="col-span-1 md:col-span-3">
                          <label className="section-label block mb-1.5 text-[var(--accent-primary)] font-bold">
                            Tool Name / Description*
                          </label>
                          <input 
                            type="text" 
                            value={toolForm.description || ''} 
                            onChange={e => setToolForm({ ...toolForm, description: e.target.value })}
                            className="aurora-input w-full text-xs font-semibold"
                            placeholder="e.g. Foret D4, Fraise ébauche D16, ST_10.00_050..."
                          />
                        </div>
                        <div>
                          <label className="section-label block mb-1.5">Tool No. (Macros)*</label>
                          <input 
                            type="number" 
                            required 
                            value={toolForm.number || ''} 
                            onChange={e => setToolForm({ ...toolForm, number: e.target.value as any })}
                            className="aurora-input w-full text-xs"
                          />
                        </div>
                        <div>
                          <label className="section-label block mb-1.5">Position / Slot (Optional)</label>
                          <input 
                            type="number" 
                            value={toolForm.pocket || ''} 
                            onChange={e => setToolForm({ ...toolForm, pocket: e.target.value as any })}
                            className="aurora-input w-full text-xs"
                          />
                        </div>
                        <div>
                          <label className="section-label block mb-1.5">Category</label>
                          <select 
                            value={toolForm.category || 'empty'} 
                            onChange={e => setToolForm({ ...toolForm, category: e.target.value as ToolCategory })}
                            className="aurora-input w-full text-xs cursor-pointer"
                          >
                            {TOOL_CATEGORIES.map(cat => <option key={cat} value={cat} className="bg-[var(--bg-panel)]">{cat.toUpperCase()}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="section-label block mb-1.5">Diameter (mm)</label>
                          <input 
                            type="number" 
                            step="0.01" 
                            value={toolForm.diameter || ''} 
                            onChange={e => setToolForm({ ...toolForm, diameter: e.target.value as any })}
                            className="aurora-input w-full text-xs"
                          />
                        </div>
                        <div>
                          <label className="section-label block mb-1.5">Length (mm)</label>
                          <input 
                            type="number" 
                            step="0.01" 
                            value={toolForm.length || ''} 
                            onChange={e => setToolForm({ ...toolForm, length: e.target.value as any })}
                            className="aurora-input w-full text-xs"
                          />
                        </div>
                        <div className="col-span-1 md:col-span-3">
                          <label className="section-label block mb-1.5">Materials supported (optional)</label>
                          <div className="flex flex-wrap gap-2 mt-1">
                            {MATERIALS.map(mat => {
                              const isSelected = (toolForm.materials || []).includes(mat);
                              return (
                                <button 
                                  key={mat} 
                                  type="button" 
                                  onClick={() => toggleMaterial(mat)}
                                  className={`px-2.5 py-1 text-xs font-medium rounded-full border transition cursor-pointer ${
                                    isSelected 
                                      ? 'badge-positive border-[var(--green-500)] text-[var(--green-500)]' 
                                      : 'badge-neutral'
                                  }`}
                                >
                                  {mat}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        
                        {errorMsg && (
                          <div className="col-span-1 md:col-span-3 badge-danger py-2 px-3 text-xs font-semibold">
                            {errorMsg}
                          </div>
                        )}
                        
                        <div className="col-span-1 md:col-span-3 flex justify-between items-center mt-2 border-t border-[var(--border-subtle)] pt-3">
                          <button 
                            type="button"
                            onClick={(e) => handleDelete(tool.id, e)}
                            disabled={isSaving || connection === 'offline'}
                            className="btn-danger text-xs py-1.5 px-3"
                          >
                            <Trash2 size={13} />
                            <span>Delete</span>
                          </button>

                          <div className="flex gap-2">
                            <button 
                              type="button" 
                              onClick={() => { cancelForm(); setExpandedId(null); }} 
                              className="btn-secondary text-xs py-1.5 px-3"
                            >
                              Cancel
                            </button>
                            <button 
                              type="submit" 
                              disabled={isSaving || connection === 'offline'}
                              className="btn-primary text-xs py-1.5 px-4"
                            >
                              {isSaving ? <RefreshCw size={14} className="animate-spin" /> : <Check size={14}/>}
                              <span>{isSaving ? 'Saving...' : 'Save Updates'}</span>
                            </button>
                          </div>
                        </div>
                      </form>
                    </div>
                  )}
                </div>
              );
            })}
            
            {toolsForMachine.length === 0 && !isAdding && (
              <div className="py-16 text-center text-[var(--text-tertiary)] flex flex-col items-center">
                <CircleDashed size={44} className="opacity-30 mb-3"/>
                <p className="text-sm font-semibold text-[var(--text-secondary)]">No tools configured for {selectedMachine}</p>
                <p className="text-xs text-[var(--text-tertiary)] mt-1">Click &quot;Add Tool&quot; above to populate the tool magazine.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

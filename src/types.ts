/** A machine id of the current country (each country has its own machines, see /api/fleet). */
export type MachineId = string;

export type ToolCategory = 'foret' | 'fraise ebauche' | 'pointeur' | 'fraise' | 'chanfrein' | 'tourteau' | 'fraise finition' | 'taraud' | 'fraise boule' | 'fraise T' | 'fraise rayon' | 'empty';

export const TOOL_CATEGORIES: ToolCategory[] = [
  'foret', 'fraise ebauche', 'pointeur', 'fraise', 'chanfrein', 'tourteau', 'fraise finition', 'taraud', 'fraise boule', 'fraise T', 'fraise rayon', 'empty'
];

export type Material = 'POM' | 'FH' | 'RESOPAL' | 'ALU' | 'EPOXYDE' | 'PC GF';
export const MATERIALS: Material[] = ['POM', 'FH', 'RESOPAL', 'ALU', 'EPOXYDE', 'PC GF'];

export interface ToolChangeBlock {
  blockId: string;
  lineIndex: number;
  originalT: string | null;
  originalLine: string;
  contextStr: string;
  parsedCategory: ToolCategory | null;
  parsedDiameter: number | null;
  parsedLength: number | null;
  matchedTool: Tool | null;
  matchType?: 'exact' | 'approximate';
  minZDepth?: number;
  zDepthError?: boolean;
  skipOperation?: boolean;
  pendingSkipConfirmation?: boolean;
  isHaasTaraudException?: boolean;
  taraudException?: boolean;
}

export interface RemapResult {
  output: string;
  unresolved: ToolChangeBlock[];
  lines: string[];
}
export interface Tool {
  id: string;
  number: number;
  pocket?: number;
  category: ToolCategory;
  description: string;
  diameter: number;
  length: number;
  changed?: boolean;
  materials?: Material[];
}

export type MachineToolbox = Record<MachineId, Tool[] | undefined>;



export interface HistoryRecord {
  id: string;
  date: string;
  isoDate?: string;
  timestamp?: number;
  user?: string;
  machine?: MachineId | string;
  originalFileName: string;
  exportedFileName: string;
  hasCode?: boolean;
  changes: {
    originalT: string;
    originalContext: string;
    reqDiameter: number | null;
    reqLength: number | null;
    appChose: boolean;
    chosenCategory: string;
    chosenT: number;
    chosenDiameter: number;
    chosenLength: number;
  }[];
}

export type PartKind = 'PRODUCED' | 'MODIFICATION';
export type PartStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface PartEntry {
  id: string;
  user_id: string;
  username: string;
  sap_number: string;
  qty: number;
  kind: PartKind;
  unit_value: number;
  status: PartStatus;
  month_key: string;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

export interface MonthlySummaryRow {
  month_key: string;
  user_id: string;
  username: string;
  total_qty: number;
  total_value: number;
}

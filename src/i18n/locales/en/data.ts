/* English texts: data. */
const data = {
  /** Full JSON backup / restore (DataManagement). */
  lessons: {
    title: 'Toolpath learning records',
    description:
      'Each time a program is checked with its 3D model in the toolpath, the app keeps the model, the program, the differences and how each operation was machined; after a turn search, also what the M0 comments say and the turns that made the part right. Download them for a period and send the file to improve CAM AI and how the app reads the turns.',
    from: 'From',
    to: 'To',
    progress: '{{count}} records read…',
    download: 'Download learning records',
    none: 'No learning records yet.',
    done: '{{count}} learning records downloaded.',
  },
  backup: {
    title: 'Backup & restore',
    descBefore: 'Download everything as one JSON file, or restore one. Old-version files (',
    descAfter: ') can be imported too, to bring back archived history.',
    download: 'Download full backup',
    includePrograms: 'Include G-code files (bigger file)',
    restore: 'Restore / import a backup file...',
    replaceTools: 'Replace tool inventory with the one in the file',
    reading: 'Reading {{name}} ({{size}} KB)...',
    invalidJson: 'This file is not valid JSON.',
  },
  /** History clean-up (DataManagement). */
  retention: {
    title: 'History clean-up (optional)',
    description:
      'History no longer blocks operators after 30 days. The free database holds years of records, so cleaning up is only needed if you want to.',
    olderThan: 'Delete records older than',
    days: 'days',
    archiveDelete: 'Archive & delete',
    clearAll: 'Clear all history',
    done: 'Done',
    confirmPrune:
      'Delete history records (and their stored G-code files) older than {{days}} days?\n\nA JSON archive of the deleted records is downloaded first.',
    confirmClearAll:
      'Delete ALL history records and stored G-code files?\n\nA full JSON archive is downloaded first. The "time saved" counter is not reset.',
    typeToConfirm: 'Type {{word}} to confirm',
    /** The word the admin has to type to clear all history. */
    deleteWord: 'DELETE',
    noneOlder: 'No records older than {{days}} days.',
    removed: 'Archive downloaded, {{count}} record(s) removed.',
  },
  /** Progress lines shown to the admin during import / backup / restore (lib/migration). */
  log: {
    createdAccounts: 'Created account(s): {{names}}',
    keptAccounts: 'Already present, kept as is: {{names}}',
    historyProgress: 'History: {{done}}/{{total}} processed',
    partsImported: 'Part entries: {{inserted}} new of {{total}}',
    downloadingTools: 'Downloading tool inventory...',
    downloadingAccounts: 'Downloading accounts...',
    downloadingHistory: 'Downloading history...',
    historyCount: 'History: {{count}} records...',
    downloadingParts: 'Downloading part entries...',
    programsCount: 'Programs: {{done}}/{{total}}...',
    backupReady: 'Backup ready.',
    toolsReplaced: 'Tool inventory replaced: {{count}} tools.',
    toolsSkipped: 'Tool inventory in the file was skipped (tick "Replace tool inventory" to restore it).',
    importingHistory: 'Importing {{count}} history record(s)...',
    historyRestored: 'History: {{added}} new record(s) added, {{present}} already present.',
    restoreFinished: 'Restore finished.',
  },
  errors: {
    notBackup: 'This file is not a CNC Process Pro backup',
    emptyBackup: 'No history, tools or part entries found in this file',
  },
};
export default data;

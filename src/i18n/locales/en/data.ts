/* English texts: data. */
const data = {
  /** Full JSON backup / restore (DataManagement). */
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
      'Delete ALL history records and stored G-code files?\n\nA full JSON archive is downloaded first. The "time won" counter is not reset.',
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

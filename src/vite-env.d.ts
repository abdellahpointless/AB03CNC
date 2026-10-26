/// <reference types="vite/client" />

// File System Access API permission methods (Chrome/Edge) used by the folder backup.
interface FileSystemHandle {
  queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

/** Short commit id of the build (vite.config.ts `define`). */
declare const __APP_VERSION__: string;

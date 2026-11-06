// Kept apart from the model code so the editor can check a file without loading the 3D code.

/** Model files and meshes bigger than these are refused (memory and time on a shop PC). */
export const MODEL_MAX_BYTES = 50 * 1024 * 1024;
export const MODEL_MAX_TRIS = 2_000_000;
/** Why a model was not shown (see toolpath.model.errors). */
export type ModelError = 'tooBig' | 'noModel' | 'compressed' | 'unreadable' | 'notPart';

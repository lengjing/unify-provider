import type { EditorId } from './adapter.js';

export interface EditorTarget {
  id: EditorId;
  name: string;
  verification: 'pending' | 'verified';
}

/**
 * Product scope, not a declaration of working integrations.
 * Qoder IDE and the newer Qoder desktop app are distinct products and are verified separately.
 */
export const editorTargets = [
  { id: 'vscode', name: 'Visual Studio Code', verification: 'pending' },
  { id: 'qoder-ide', name: 'Qoder IDE', verification: 'pending' },
  { id: 'qoder-app', name: 'Qoder App', verification: 'pending' },
  { id: 'trae', name: 'Trae', verification: 'pending' },
  { id: 'cursor', name: 'Cursor', verification: 'pending' },
] as const satisfies readonly EditorTarget[];

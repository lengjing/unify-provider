import * as vscode from 'vscode';
import type { AuthHost } from '@unify-provider/core';

export function createAuthHost(context: vscode.ExtensionContext): AuthHost {
  return {
    async openExternal(url) {
      if (!await vscode.env.openExternal(vscode.Uri.parse(url.href))) {
        throw new Error('Could not open the sign-in browser. Check your default browser and try again.');
      }
    },
    secrets: {
      get: async key => context.secrets.get(key),
      store: async (key, value) => context.secrets.store(key, value),
      delete: async key => context.secrets.delete(key),
    },
  };
}

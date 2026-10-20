import type { AuthHost } from '../core/provider.js';
import type { ProviderRegistry } from '../core/registry.js';

/**
 * Kept as a plain string until compatibility is verified. The formal set of editor IDs is
 * decided by the verification results in docs/compatibility.md, not fixed here in the types.
 * Known candidates are listed in `targets.ts`.
 */
export type EditorId = string;
export type IntegrationRoute = 'language-model-provider' | 'managed-local-endpoint';

export interface EditorProbe {
  editorId: EditorId;
  version: string;
  nativeAgentIntegration:
    | { status: 'available'; route: IntegrationRoute; automaticModelSelection: boolean }
    | { status: 'unavailable' | 'unverified'; reason: string };
}

export interface EditorConnection {
  /** Dispose runtime resources without deleting persistent user configuration. */
  dispose(): Promise<void>;
  /** Remove only configuration owned by this integration. */
  removeConfiguration(): Promise<void>;
}

export interface EditorAdapter {
  readonly id: EditorId;
  probe(): Promise<EditorProbe>;
  attach(registry: ProviderRegistry, host: AuthHost): Promise<EditorConnection>;
}

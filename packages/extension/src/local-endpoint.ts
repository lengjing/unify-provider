import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { ModelDescriptor, ProviderRegistry } from '@unify-provider/core';
import { startLocalEndpoint } from '@unify-provider/local-endpoint';
import type { LocalEndpoint } from '@unify-provider/local-endpoint';

const tokenKey = 'unifyProvider.localEndpoint.token';
const portKey = 'unifyProvider.localEndpoint.port';
const guideKey = 'unifyProvider.localEndpoint.guideShown';
/** Stable default so the Base URL pasted into the editor keeps working across restarts. */
const preferredPort = 46117;
const traeSettingsCommand = 'workbench.action.openTraeSettings';

/** Secondary-experience route: the editor's native agent calls a loopback HTTP endpoint managed here. */
export class LocalEndpointManager implements vscode.Disposable {
  private endpoint: LocalEndpoint | undefined;
  private starting: Promise<LocalEndpoint> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: ProviderRegistry,
    private readonly providerId: string,
    private readonly logger: { info(message: string): void; warn(message: string): void },
    private readonly connect: () => Promise<void>,
  ) {}

  /** Host detection by product name is only used to offer the route, never to claim compatibility. */
  get isTraeHost(): boolean { return /\btrae\b/i.test(vscode.env.appName); }
  get running(): LocalEndpoint | undefined { return this.endpoint; }

  async start(): Promise<LocalEndpoint> {
    if (this.endpoint) return this.endpoint;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const token = await this.token();
      const persisted = this.context.globalState.get<number>(portKey);
      const port = persisted ?? preferredPort;
      let endpoint: LocalEndpoint;
      try {
        endpoint = await startLocalEndpoint({ registry: this.registry, providerId: this.providerId, token, port, logger: this.logger });
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EADDRINUSE')) throw error;
        this.logger.warn(`Local endpoint port ${port} is in use; falling back to an OS-assigned port`);
        endpoint = await startLocalEndpoint({ registry: this.registry, providerId: this.providerId, token, port: 0, logger: this.logger });
        if (persisted !== undefined) {
          void vscode.window.showWarningMessage(vscode.l10n.t('The local endpoint port {0} was busy; it now listens on port {1}. Update the Base URL in your editor\'s custom model settings.', String(port), String(endpoint.port)));
        }
      }
      await this.context.globalState.update(portKey, endpoint.port);
      this.endpoint = endpoint;
      return endpoint;
    })();
    try { return await this.starting; } finally { this.starting = undefined; }
  }

  async stop(): Promise<void> {
    const endpoint = this.endpoint;
    this.endpoint = undefined;
    await endpoint?.close();
    if (endpoint) this.logger.info('Local endpoint stopped');
  }

  dispose(): void { void this.stop(); }

  /** Rotating the key invalidates whatever the editor has stored; the user must paste the new key once. */
  async rotateToken(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(vscode.l10n.t('Generate a new local API key? The editor will reject requests until you paste the new key into its custom model settings.'),
      { modal: true }, vscode.l10n.t('Generate new key'));
    if (!confirm) return;
    await this.context.secrets.delete(tokenKey);
    const wasRunning = !!this.endpoint;
    await this.stop();
    if (wasRunning) await this.start();
    await this.showConfig();
  }

  /** Remove only state owned by this integration; the editor's own settings are never touched. */
  async removeConfiguration(): Promise<void> {
    await this.stop();
    await this.context.secrets.delete(tokenKey);
    await this.context.globalState.update(portKey, undefined);
    await this.context.globalState.update(guideKey, undefined);
  }

  async showGuideOnce(): Promise<void> {
    if (this.context.globalState.get<boolean>(guideKey)) return;
    const copy = vscode.l10n.t('Copy configuration');
    const action = await vscode.window.showInformationMessage(
      vscode.l10n.t('Unify Provider is running a local endpoint for this editor\'s custom model settings. Paste the Base URL, API key and a model ID once to use your ChatGPT plan here.'),
      copy, vscode.l10n.t('Later'));
    await this.context.globalState.update(guideKey, true);
    if (action === copy) await this.showConfig();
  }

  async showConfig(): Promise<void> {
    const endpoint = await this.start();
    const baseUrl = `${endpoint.url}/v1`;
    type Item = vscode.QuickPickItem & { action: () => Promise<void> };
    const copy = (label: string, value: string) => async () => {
      await vscode.env.clipboard.writeText(value);
      void vscode.window.setStatusBarMessage(vscode.l10n.t('Copied {0}', label), 3000);
    };
    const items: Item[] = [
      { label: vscode.l10n.t('$(link) Base URL'), description: baseUrl, detail: vscode.l10n.t('API format: OpenAI Chat Completions. Leave the "full URL" switch off; the editor appends /chat/completions.'), action: copy(vscode.l10n.t('Base URL'), baseUrl) },
      { label: vscode.l10n.t('$(key) API key'), description: '••••••••', detail: vscode.l10n.t('A local one-time key; it is not your ChatGPT credential and only works on this computer.'), action: copy(vscode.l10n.t('API key'), await this.token()) },
    ];
    const models = await this.models();
    if (models.length) {
      for (const model of models) {
        items.push({ label: vscode.l10n.t('$(symbol-misc) Model ID: {0}', model.modelId), description: model.name,
          detail: vscode.l10n.t('Context {0} · tools {1} · images {2}', String(model.contextWindow), model.capabilities.tools ? '✓' : '✗', model.capabilities.images ? '✓' : '✗'),
          action: copy(vscode.l10n.t('model ID'), model.modelId) });
      }
    } else {
      items.push({ label: vscode.l10n.t('$(account) Sign in with ChatGPT to list model IDs'), action: async () => { await this.connect(); await this.showConfig(); } });
    }
    items.push(
      { label: vscode.l10n.t('$(settings-gear) Open the editor\'s model settings'), action: () => this.openEditorModelSettings() },
      { label: vscode.l10n.t('$(refresh) Generate a new API key'), action: () => this.rotateToken() },
      { label: vscode.l10n.t('$(debug-stop) Stop local endpoint'), action: () => this.stop() },
    );
    const picked = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('Unify Provider · Local endpoint ({0})', endpoint.url),
      placeHolder: vscode.l10n.t('Select an entry to copy it, then paste into Settings → Models → Add custom model → Custom configuration'),
    });
    if (picked) await picked.action();
  }

  private async openEditorModelSettings(): Promise<void> {
    const commands = await vscode.commands.getCommands(true);
    // Trae registers this command; it is undocumented, so fall back to standard settings when absent.
    if (commands.includes(traeSettingsCommand)) {
      try { await vscode.commands.executeCommand(traeSettingsCommand); return; }
      catch (error) { this.logger.warn(`${traeSettingsCommand} failed: ${error instanceof Error ? error.name : 'unknown'}`); }
    }
    await vscode.commands.executeCommand('workbench.action.openSettings');
  }

  private async token(): Promise<string> {
    const existing = await this.context.secrets.get(tokenKey);
    if (existing && existing.length >= 32) return existing;
    const token = `up_${randomBytes(24).toString('base64url')}`;
    await this.context.secrets.store(tokenKey, token);
    return token;
  }

  private async models(): Promise<readonly ModelDescriptor[]> {
    const provider = this.registry.get(this.providerId);
    if ((await provider.getConnectionState()).status !== 'connected') return [];
    try { return (await provider.listModels(AbortSignal.timeout(30_000))).filter(model => model.capabilities.tools); }
    catch (error) { this.logger.warn(`Local endpoint model listing failed: ${error instanceof Error ? error.name : 'unknown'}`); return []; }
  }
}

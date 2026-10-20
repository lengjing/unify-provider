import * as vscode from 'vscode';
import { ProviderRegistry } from '@unify-provider/core';
import type { AuthHost, ConnectionState, SubscriptionProvider } from '@unify-provider/core';
import { createAuthHost } from './host.js';
import { cancellation, ChatModelProvider } from './provider.js';
import { CompletionStreamError, ConversionError } from './convert.js';
import { localizeConversionError } from './localization.js';
import { logError } from './logging.js';

const usageUrl = vscode.Uri.parse('https://chatgpt.com/settings/usage');
let shutdown: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel('Unify Provider', { log: true });
  context.subscriptions.push(channel, vscode.commands.registerCommand('unifyProvider.showLogs', () => channel.show()));
  const logger = { info: (message: string) => channel.info(message), warn: (message: string) => channel.warn(message) };
  const host = createAuthHost(context);
  const registry = new ProviderRegistry();
  // Runtime check permits development while the parallel core implementation is
  // absent. The import is bundled; no fallback provider/models are manufactured.
  const core: unknown = await import('@unify-provider/core');
  const factory = (core as Record<string, unknown>).createCodexProvider;
  if (typeof factory !== 'function') {
    const notReady = async () => { await vscode.window.showErrorMessage(vscode.l10n.t('Core not ready: createCodexProvider is missing. Complete the core implementation, rebuild, and reload the window.')); };
    for (const command of ['connect', 'disconnect', 'manage', 'showStatus']) {
      context.subscriptions.push(vscode.commands.registerCommand(`unifyProvider.${command}`, notReady));
    }
    await notReady();
    return;
  }
  const provider = (factory as (options: { host: AuthHost; agentName: string; logger: typeof logger }) => SubscriptionProvider)({
    host, agentName: 'Unify Provider', logger,
  });
  registry.register(provider);
  if (provider.id !== 'codex') {
    await provider.dispose();
    await vscode.window.showErrorMessage(vscode.l10n.t('Core not ready: the Codex provider ID does not match the contract.'));
    return;
  }
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'unifyProvider.manage';
  statusBar.name = vscode.l10n.t('Unify Provider: ChatGPT plan');
  statusBar.show();
  let connection: Promise<void> | undefined;
  let connectionController: AbortController | undefined;
  let previousStatus: ConnectionState['status'] | undefined;
  let chat: ChatModelProvider;

  const refreshStatus = async () => {
    try {
      const state = await provider.getConnectionState();
      const account = state.status === 'connected' ? state.accountLabel.replace(/[\r\n]/g, ' ') : '';
      const quota = state.status === 'connected' && state.quota
        ? vscode.l10n.t(' · {0}/{1} {2}', state.quota.remaining ?? '?', state.quota.limit ?? '?',
          state.quota.unit === 'requests' ? vscode.l10n.t('requests')
          : state.quota.unit === 'tokens' ? vscode.l10n.t('tokens')
          : state.quota.unit === 'credits' ? vscode.l10n.t('credits') : vscode.l10n.t('unknown')) : '';
      const issue = state.status === 'connected' && state.error
        ? /usage_limit|429/.test(state.error.code) ? vscode.l10n.t(' · Usage limited')
        : /not_eligible|403/.test(state.error.code) ? vscode.l10n.t(' · Ineligible/access denied') : vscode.l10n.t(' · Request failed') : '';
      statusBar.text = state.status === 'connected' ? vscode.l10n.t('$(account) Using ChatGPT plan · {0}{1}{2}', account, quota, issue)
        : state.status === 'connecting' ? vscode.l10n.t('$(sync~spin) ChatGPT: Connecting')
        : state.status === 'reauthentication-required' ? vscode.l10n.t('$(warning) ChatGPT: Sign in again')
        : vscode.l10n.t('$(plug) ChatGPT: Disconnected');
      const tooltip = new vscode.MarkdownString(vscode.l10n.t('Unify Provider · Using ChatGPT plan\n\n[Manage usage](https://chatgpt.com/settings/usage)'));
      statusBar.tooltip = tooltip;
      if (state.status !== previousStatus) {
        previousStatus = state.status;
        chat?.notifyChanged();
      }
    } catch (error) {
      logError(channel, error);
      statusBar.text = vscode.l10n.t('$(warning) ChatGPT: Status unavailable');
    }
  };
  // Logs the failure and returns a localized, credential-free description.
  const describeError = (error: unknown): string => {
    logError(channel, error);
    // Notifications are localized; only trusted/redacted diagnostics go to Output.
    const event = typeof error === 'object' && error !== null && 'event' in error ? error.event : undefined;
    const code = error instanceof CompletionStreamError ? error.code
      : typeof event === 'object' && event !== null && 'code' in event && typeof event.code === 'string' ? event.code : '';
    const limit = /quota|usage.limit|rate.limit|429/i.test(code);
    return error instanceof ConversionError ? localizeConversionError(error.message)
      : limit ? vscode.l10n.t('ChatGPT usage limit reached. Check your plan or app limits; requests will not be retried automatically.')
      : /403|forbidden|ineligible|not_eligible/i.test(code) ? vscode.l10n.t('This ChatGPT account is ineligible or access was denied. Check your plan and authorization.')
      : /401|reauthentication|invalid_grant|invalid_user|refresh_token|token_expired/i.test(code) ? vscode.l10n.t('ChatGPT authorization expired or was revoked. Sign in with ChatGPT again.')
      : /network_error/i.test(code) ? vscode.l10n.t('Network request to ChatGPT failed. Check your connection or proxy and try again.')
      : vscode.l10n.t('Unify Provider operation failed. Check your browser, network, ChatGPT authorization, and plan usage before trying again.');
  };
  // Notification only for user-invoked commands; chat failures surface inline in the chat view.
  const showError = async (error: unknown) => {
    const message = describeError(error);
    const action = await vscode.window.showErrorMessage(message, vscode.l10n.t('Show logs'), vscode.l10n.t('Manage usage'));
    if (action === vscode.l10n.t('Show logs')) channel.show();
    if (action === vscode.l10n.t('Manage usage')) await vscode.env.openExternal(usageUrl);
  };
  const connect = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (connection) return connection;
    connectionController = new AbortController();
    const controller = connectionController;
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    connection = (async () => {
      if ((await provider.getConnectionState()).status === 'connected') return;
      if (!context.globalState.get<boolean>('chatgptRiskAccepted')) {
        const action = await vscode.window.showInformationMessage(vscode.l10n.t('Before connecting your ChatGPT plan'), {
          modal: true,
          detail: vscode.l10n.t('This extension uses your ChatGPT plan Codex allowance through OpenAI\'s official Sign in with ChatGPT. It is a local, MIT-licensed, open-source third-party tool, not an OpenAI product or endorsed by OpenAI.\n\nUsage is shared with other apps and counts toward your plan limits. Reaching a limit will not switch to another paid method. SIWC is in preview; APIs, models, eligibility, and policies may change at any time. We cannot guarantee that your account will not be restricted.\n\nCredentials are kept in VS Code secure storage. Disconnect promptly on shared computers. Manage usage, limits, and revoke this app\'s authorization in ChatGPT settings.'),
        }, vscode.l10n.t('Continue with ChatGPT'));
        if (!action) return;
        controller.signal.throwIfAborted();
        await context.globalState.update('chatgptRiskAccepted', true);
      }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Sign in with ChatGPT — sign in in your browser'), cancellable: true }, async (_progress, token) => {
        const cancel = token.onCancellationRequested(abort);
        try {
          const pending = provider.connect(host, controller.signal);
          void refreshStatus();
          await pending;
        } finally { cancel.dispose(); }
      });
      // A resolved connect is not itself proof of success.
      if ((await provider.getConnectionState()).status !== 'connected') throw new Error('Sign-in did not complete.');
      if (!context.globalState.get<boolean>('chatgptWelcomeShown')) {
        await vscode.window.showInformationMessage(vscode.l10n.t("You're using your ChatGPT plan"), {
          modal: true, detail: vscode.l10n.t('Eligible AI requests in this app will use your ChatGPT plan allowance. Manage usage in ChatGPT settings.'),
        }, vscode.l10n.t('Got it'));
        await context.globalState.update('chatgptWelcomeShown', true);
      }
    })();
    try { await connection; }
    catch (error) {
      if (controller.signal.aborted) throw new vscode.CancellationError();
      throw error;
    }
    finally {
      signal.removeEventListener('abort', abort);
      connection = undefined;
      connectionController = undefined;
      chat.notifyChanged();
      await refreshStatus();
    }
  };
  chat = new ChatModelProvider(registry, provider, connect, refreshStatus, showError, describeError, logger);
  const run = (action: () => PromiseLike<unknown>) => async () => {
    try { await action(); } catch (error) {
      if (!(error instanceof vscode.CancellationError) && !(error instanceof Error && error.name === 'AbortError')) await showError(error);
    } finally { await refreshStatus(); }
  };
  const signIn = () => vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t('ChatGPT') }, async (_p, token) => {
    const operation = cancellation(token);
    try { await connect(operation.signal); } finally { operation.dispose(); }
  });
  const disconnect = async () => {
    connectionController?.abort();
    await connection?.catch(() => {});
    await provider.disconnect(host);
    chat.notifyChanged();
  };
  const showStatus = async () => {
    await refreshStatus();
    const action = await vscode.window.showInformationMessage(statusBar.text.replace(/\$\([^)]+\)\s*/g, ''), vscode.l10n.t('Manage usage'));
    if (action) await vscode.env.openExternal(usageUrl);
  };
  const manage = async () => {
    const choice = await vscode.window.showQuickPick([
      { label: vscode.l10n.t('Continue with ChatGPT'), id: 'connect' },
      { label: vscode.l10n.t('Disconnect ChatGPT'), id: 'disconnect' },
      { label: vscode.l10n.t('Show status'), id: 'status' },
      { label: vscode.l10n.t('Show logs'), id: 'logs' },
      { label: vscode.l10n.t('Manage usage'), id: 'usage' },
    ], { title: vscode.l10n.t('Unify Provider · ChatGPT plan') });
    if (choice?.id === 'connect') await signIn();
    if (choice?.id === 'disconnect') await disconnect();
    if (choice?.id === 'status') await showStatus();
    if (choice?.id === 'logs') channel.show();
    if (choice?.id === 'usage') await vscode.env.openExternal(usageUrl);
  };
  context.subscriptions.push(statusBar, chat,
    vscode.lm.registerLanguageModelChatProvider('unify-provider', chat),
    vscode.commands.registerCommand('unifyProvider.connect', run(signIn)),
    vscode.commands.registerCommand('unifyProvider.disconnect', run(disconnect)),
    vscode.commands.registerCommand('unifyProvider.manage', run(manage)),
    vscode.commands.registerCommand('unifyProvider.showStatus', run(showStatus)),
    context.secrets.onDidChange(() => { void refreshStatus(); }),
  );
  shutdown = async () => {
    connectionController?.abort();
    await connection?.catch(() => {});
    await provider.dispose();
  };
  await refreshStatus();
}

export async function deactivate(): Promise<void> {
  await shutdown?.();
  shutdown = undefined;
}

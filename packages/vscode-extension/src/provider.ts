import * as vscode from 'vscode';
import type { ProviderRegistry, SubscriptionProvider } from '@unify-provider/core';
import { ConversionError, convertEvents, convertMessages, convertTools } from './convert.js';
import { logIdentifier } from './logging.js';

export function cancellation(token: vscode.CancellationToken): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const subscription = token.onCancellationRequested(() => controller.abort());
  if (token.isCancellationRequested) controller.abort();
  return { signal: controller.signal, dispose: () => subscription.dispose() };
}

export class ChatModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changed.event;
  private catalog: { key: string; expiresAt: number; promise: Promise<vscode.LanguageModelChatInformation[]> } | undefined;
  private connectionKey: string | undefined;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly provider: SubscriptionProvider,
    private readonly connect: (signal: AbortSignal) => Promise<void>,
    private readonly refreshStatus: () => Promise<void>,
    private readonly showError: (error: unknown) => Promise<void>,
    private readonly describeError: (error: unknown) => string,
    private readonly logger: { info(message: string): void; warn(message: string): void },
  ) {}

  notifyChanged(): void { this.catalog = undefined; this.changed.fire(); }
  dispose(): void { this.catalog = undefined; this.changed.dispose(); }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const operation = cancellation(token);
    try {
      operation.signal.throwIfAborted();
      let state = await this.provider.getConnectionState();
      const key = JSON.stringify(state);
      if (key !== this.connectionKey) { this.catalog = undefined; this.connectionKey = key; }
      if (state.status !== 'connected') {
        if (options.silent) return [];
        await this.connect(operation.signal);
        state = await this.provider.getConnectionState();
        this.catalog = undefined;
        this.connectionKey = JSON.stringify(state);
        if (state.status !== 'connected') return [];
      }
      if (!this.catalog || this.catalog.key !== this.connectionKey || this.catalog.expiresAt <= Date.now()) {
        // Share discovery even when VS Code invokes this method concurrently. Individual
        // cancellation does not abort the shared request; it is bounded by a timeout.
        const promise = this.provider.listModels(AbortSignal.timeout(30_000)).then(models => models.filter(model => model.capabilities.tools).map(model => ({
          id: model.modelId, name: model.name, family: model.modelId, version: model.modelId,
          maxInputTokens: Math.max(0, model.contextWindow - model.maxOutputTokens),
          maxOutputTokens: model.maxOutputTokens,
          detail: vscode.l10n.t('Using ChatGPT plan'),
          tooltip: vscode.l10n.t('Using ChatGPT plan · Manage usage: https://chatgpt.com/settings/usage'),
          capabilities: { toolCalling: true, imageInput: model.capabilities.images },
        })));
        const catalog = { key: this.connectionKey, expiresAt: Infinity, promise };
        this.catalog = catalog;
        void promise.then(() => { catalog.expiresAt = Date.now() + 10_000; }, () => {
          if (this.catalog === catalog) this.catalog = undefined;
        });
      }
      const catalog = this.catalog;
      const result = await new Promise<vscode.LanguageModelChatInformation[]>((resolve, reject) => {
        const abort = () => reject(new vscode.CancellationError());
        operation.signal.addEventListener('abort', abort, { once: true });
        if (operation.signal.aborted) abort();
        void catalog.promise.then(resolve, reject).finally(() => operation.signal.removeEventListener('abort', abort));
      });
      operation.signal.throwIfAborted();
      // Do not return a catalog invalidated by a disconnect/account switch while loading.
      return this.catalog === catalog ? structuredClone(result) : [];
    } catch (error) {
      if (!operation.signal.aborted && !options.silent) await this.showError(error);
      return [];
    } finally {
      operation.dispose();
      await this.refreshStatus();
    }
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const started = Date.now();
    let result = 'success';
    this.logger.info(`Chat response started model=${logIdentifier(model.id)} messages=${messages.length} tools=${options.tools?.length ?? 0} toolMode=${options.toolMode ?? 'default'}`);
    const operation = cancellation(token);
    try {
      operation.signal.throwIfAborted();
      // The common contract has no tool-choice field. Do not silently violate Required mode.
      if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
        throw new ConversionError('The core contract does not support required tool calling (toolMode Required).');
      }
      const converted = convertMessages(messages);
      if (!model.capabilities.imageInput && converted.some(m => m.content.some(p => p.type === 'image'))) {
        throw new ConversionError('This model does not support image input.');
      }
      const request = {
        model: { providerId: this.provider.id, modelId: model.id },
        messages: converted, tools: convertTools(options.tools), signal: operation.signal,
      };
      for await (const part of convertEvents(this.registry.complete(request))) {
        operation.signal.throwIfAborted();
        progress.report(part.type === 'text'
          ? new vscode.LanguageModelTextPart(part.value)
          : new vscode.LanguageModelToolCallPart(part.callId, part.name, part.input));
      }
    } catch (error) {
      result = operation.signal.aborted ? 'cancelled' : 'failed';
      if (operation.signal.aborted) throw new vscode.CancellationError();
      // No notification here: the chat view renders the thrown message inline, and
      // Output ("Unify Provider") keeps the redacted diagnostics. The description is
      // localized and never contains OAuth/network details.
      throw new Error(this.describeError(error));
    } finally {
      this.logger.info(`Chat response ended result=${result} elapsedMs=${Date.now() - started}`);
      operation.dispose();
      await this.refreshStatus();
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken,
  ): Promise<number> {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    // Approximate character/4 budget (rounded up), not a model tokenizer. JSON
    // includes tool arguments/results; CJK, images and special tokens may be underestimated.
    return Math.ceil((typeof text === 'string' ? text : JSON.stringify(text)).length / 4);
  }
}

import type { CompletionEvent, CompletionRequest, SubscriptionProvider } from './provider.js';

export class ProviderRegistry {
  readonly #providers = new Map<string, SubscriptionProvider>();

  register(provider: SubscriptionProvider): void {
    if (!provider.id.trim()) throw new Error('Provider ID must not be empty');
    if (this.#providers.has(provider.id)) {
      throw new Error(`Provider already registered: ${provider.id}`);
    }
    this.#providers.set(provider.id, provider);
  }

  get(id: string): SubscriptionProvider {
    const provider = this.#providers.get(id);
    if (!provider) throw new Error(`Unknown provider: ${id}`);
    return provider;
  }

  list(): readonly SubscriptionProvider[] {
    return [...this.#providers.values()];
  }

  async *complete(request: CompletionRequest): AsyncIterable<CompletionEvent> {
    request.signal.throwIfAborted();
    const provider = this.get(request.model.providerId);
    for await (const event of provider.complete(request)) {
      request.signal.throwIfAborted();
      yield event;
    }
  }
}

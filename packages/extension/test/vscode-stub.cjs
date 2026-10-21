// Minimal host API for provider unit tests only; never bundled into the extension.
class EventEmitter {
  event = () => ({ dispose() {} });
  fire() {}
  dispose() {}
}
class CancellationError extends Error {}
module.exports = { EventEmitter, CancellationError, l10n: { t: value => value } };

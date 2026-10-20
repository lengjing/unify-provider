import * as vscode from 'vscode';

// Keep thrown diagnostics English and conversion independent of the VS Code runtime.
// Only locally authored conversion diagnostics are translated at the UI boundary.
export function localizeConversionError(message: string): string {
  // Role diagnostics carry only the numeric enum value, never user content.
  const role = /^Unsupported VS Code message role: (\d+)\.$/.exec(message);
  if (role) return vscode.l10n.t('Unsupported VS Code message role: {0}.', role[1]!);
  switch (message) {
    case 'Tool-result parts are not allowed in System messages.': return vscode.l10n.t('Tool-result parts are not allowed in System messages.');
    case 'Tool-call parts are not allowed in System messages.': return vscode.l10n.t('Tool-call parts are not allowed in System messages.');
    case 'Image/data parts are not allowed in System messages; only text is supported.': return vscode.l10n.t('Image/data parts are not allowed in System messages; only text is supported.');
    case 'Unsupported VS Code message part.': return vscode.l10n.t('Unsupported VS Code message part.');
    case 'Tool arguments or schemas must be JSON.': return vscode.l10n.t('Tool arguments or schemas must be JSON.');
    case 'Tool results contain unsupported non-text parts (such as PromptTsx or images).': return vscode.l10n.t('Tool results contain unsupported non-text parts (such as PromptTsx or images).');
    case 'Tool results must be in User messages.': return vscode.l10n.t('Tool results must be in User messages.');
    case 'Tool calls must be in Assistant messages.': return vscode.l10n.t('Tool calls must be in Assistant messages.');
    case 'Only image/* data input is supported.': return vscode.l10n.t('Only image/* data input is supported.');
    case 'Unsupported VS Code message part; context was not discarded.': return vscode.l10n.t('Unsupported VS Code message part; context was not discarded.');
    case 'Unsupported VS Code message role.': return vscode.l10n.t('Unsupported VS Code message role.');
    case 'Tool inputSchema must be a JSON object.': return vscode.l10n.t('Tool inputSchema must be a JSON object.');
    case 'Duplicate tool call ID.': return vscode.l10n.t('Duplicate tool call ID.');
    case 'Tool argument delta is missing tool-call-start.': return vscode.l10n.t('Tool argument delta is missing tool-call-start.');
    case 'Tool call end is missing tool-call-start.': return vscode.l10n.t('Tool call end is missing tool-call-start.');
    case 'Tool call arguments are not valid JSON; the tool was not executed.': return vscode.l10n.t('Tool call arguments are not valid JSON; the tool was not executed.');
    case 'Tool call arguments must be a JSON object; the tool was not executed.': return vscode.l10n.t('Tool call arguments must be a JSON object; the tool was not executed.');
    case 'Response ended early: tool arguments are incomplete; the tool was not executed.': return vscode.l10n.t('Response ended early: tool arguments are incomplete; the tool was not executed.');
    case 'The core contract does not support required tool calling (toolMode Required).': return vscode.l10n.t('The core contract does not support required tool calling (toolMode Required).');
    case 'This model does not support image input.': return vscode.l10n.t('This model does not support image input.');
    default: return vscode.l10n.t('Unify Provider could not convert the request or response.');
  }
}

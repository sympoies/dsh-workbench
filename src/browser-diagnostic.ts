/** Bound browser errors before they reach public CI logs. */
export function publicBrowserFailure(error: unknown, secrets: readonly string[] = []): string {
  const name = error instanceof Error && /^[A-Za-z]+Error$/.test(error.name)
    ? error.name : 'BrowserError';
  let message = error instanceof Error ? error.message : String(error);
  message = message.replace(/([?&]token=)[^\s"']+/gi, '$1[redacted]');
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, '[redacted]');
  }
  return JSON.stringify({ result: 'fail', error: name, message: message.slice(0, 1_500) });
}

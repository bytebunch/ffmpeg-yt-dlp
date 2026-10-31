import type { CallbackResult } from './drive-connections.service';

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );

/** The page Google redirects the user to: plain HTML, no scripts, nothing loaded from elsewhere. */
export function callbackPage(result: CallbackResult): string {
  const [title, message] = result.ok
    ? [
        'Google Drive connected',
        `Connected${result.email ? ` as ${result.email}` : ''}. You can close this window.`,
      ]
    : ['Google Drive not connected', result.reason];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 4rem 1rem; background: #f6f7f9; color: #1d2330; }
main { max-width: 32rem; margin: 0 auto; background: #fff; border-radius: 12px; padding: 2rem; box-shadow: 0 1px 3px #0002; }
h1 { font-size: 1.25rem; margin: 0 0 .5rem; color: ${result.ok ? '#11683a' : '#a3261b'}; }
@media (prefers-color-scheme: dark) { body { background: #12151b; color: #e6e9ef; } main { background: #1c2028; } }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
</main>
</body>
</html>
`;
}

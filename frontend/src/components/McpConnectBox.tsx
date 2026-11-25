import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOAuthInfo, serverBaseFrom } from '../hooks/useOAuthInfo';
import { errorMessage } from '../lib/narrow';
import Button from './ui/Button';

/** A copyable one-liner (command or URL). */
function CopyLine({ value }: { value: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setError(null);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      // Clipboard access fails without HTTPS or permission; say so instead of
      // pretending it worked.
      setError(errorMessage(e, t('common.error')));
    }
  };
  return (
    <div>
      <div className="flex items-start gap-2">
        <code className="flex-1 break-all rounded-sm bg-gray-950 px-3 py-2 font-mono text-xs text-green-400">
          {value}
        </code>
        <Button variant="secondary" size="xs" onClick={() => void copy()}>
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
      </div>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}

/** The API-key variant (header for /mcp, query parameter for SSE). */
function ApiKeyVariant({ base }: { base: string }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-400">{t('mcpConnect.apiKeyIntro')}</p>
      <CopyLine value={`claude mcp add --transport http devgrimoire ${base}/mcp --header "Authorization: Bearer cv_..."`} />
      <p className="text-xs text-gray-500">{t('mcpConnect.apiKeySse')}</p>
      <CopyLine value={`claude mcp add --transport sse devgrimoire "${base}/sse?apiKey=cv_..."`} />
    </div>
  );
}

/**
 * "Connect" box shared by Settings → Connected apps and the docs page:
 * ready-to-copy command and connector URL with the real instance address.
 * Without OAuth only the API-key variant is shown.
 */
export default function McpConnectBox() {
  const { t } = useTranslation();
  const info = useOAuthInfo();
  const base = serverBaseFrom(info);
  const mcpUrl = info?.enabled ? info.mcpUrl : undefined;

  return (
    <div className="rounded-lg border border-cyan-800/50 bg-cyan-950/20 p-4">
      <h3 className="mb-3 text-sm font-semibold text-cyan-300">{t('mcpConnect.title')}</h3>
      {mcpUrl ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-xs font-medium text-gray-300">{t('mcpConnect.claudeCode')}</p>
            <CopyLine value={`claude mcp add --transport http devgrimoire ${mcpUrl}`} />
            <p className="text-xs text-gray-500">{t('mcpConnect.claudeCodeHint')}</p>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium text-gray-300">{t('mcpConnect.connector')}</p>
            <p className="text-xs text-gray-500">{t('mcpConnect.connectorHint')}</p>
            <CopyLine value={mcpUrl} />
          </div>
          <details className="group">
            <summary className="cursor-pointer select-none text-xs text-gray-500 hover:text-gray-300">
              {t('mcpConnect.apiKeyToggle')}
            </summary>
            <div className="mt-3">
              <ApiKeyVariant base={base} />
            </div>
          </details>
        </div>
      ) : (
        <ApiKeyVariant base={base} />
      )}
    </div>
  );
}

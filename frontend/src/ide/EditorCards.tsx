import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Button from '../components/ui/Button';
import { useToast } from '../components/Toast';
import { downloadBlob } from '../lib/download';
import { errorMessage } from '../lib/narrow';
import { ideApi, IdeApiError } from './ide-api';
import { formatLimit, limitAwareMessage } from './limit-message';
import { useIdeStore, type OpenTab } from './ide-store';

const DEFAULT_EDITOR_LIMIT = 5 * 1024 * 1024;

function formatSize(bytes: number): string | null {
  if (bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Tabs without a text editor: image preview, or a card for binary / too-large files. */
export function NonTextTabView({ tab }: { tab: OpenTab }) {
  const { t } = useTranslation();
  const { showError } = useToast();
  const workspaceId = useIdeStore((s) => s.workspaceId);
  const noteApiError = useIdeStore((s) => s.noteApiError);
  const [busy, setBusy] = useState(false);
  const name = tab.path.split('/').pop() ?? tab.path;
  const size = formatSize(tab.size) ?? t('ide.sizeUnknown');

  const download = (): void => {
    if (!workspaceId) return;
    setBusy(true);
    ideApi
      .rawBlob(workspaceId, tab.path)
      .then((blob) => downloadBlob(name, blob))
      .catch((error: unknown) => {
        noteApiError(error);
        showError(
          error instanceof IdeApiError && error.status === 413
            ? limitAwareMessage(error, 'download', t)
            : errorMessage(error, t('ide.downloadFailed')),
        );
      })
      .finally(() => setBusy(false));
  };

  const downloadButton = (
    <Button size="sm" variant="neutral" onClick={download} disabled={busy}>
      {t('ide.download')}
    </Button>
  );

  if (tab.kind === 'image' && tab.previewUrl) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 overflow-auto bg-gray-900 p-6">
        <img src={tab.previewUrl} alt={name} className="max-h-[70vh] max-w-full rounded-sm border border-gray-700 object-contain" />
        <div className="font-mono text-xs text-gray-400">
          {name} · {size}
        </div>
        {downloadButton}
      </div>
    );
  }

  const tooLarge = tab.kind === 'too-large';
  return (
    <div className="flex h-full items-center justify-center bg-gray-900 p-6">
      <div className="w-full max-w-sm rounded-lg border border-gray-700 bg-gray-800 p-5 text-center">
        <div className="mb-1 truncate font-mono text-sm text-gray-200" title={tab.path}>
          {name}
        </div>
        <div className="mb-3 text-xs text-gray-500">{size}</div>
        <p className="mb-4 text-sm text-gray-400">{tooLarge ? t('ide.tooLargeText', { limit: formatLimit(tab.limit ?? DEFAULT_EDITOR_LIMIT) }) : t('ide.binaryText')}</p>
        {downloadButton}
      </div>
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api, Attachment } from '../api/client';
import Button from './ui/Button';
import Badge from './ui/Badge';
import ConfirmButton from './ui/ConfirmButton';
import EmptyState from './ui/EmptyState';
import FileUploadZone from './FileUploadZone';

interface AttachmentListProps {
  projectId: string;
  entityType?: string;
  entityId?: string;
  showUpload?: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function fileIcon(mimeType: string): string {
  if (mimeType.startsWith('image/')) return '\u{1F5BC}';
  if (mimeType === 'application/pdf') return '\u{1F4C4}';
  if (mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('javascript') || mimeType.includes('typescript')) return '\u{1F4DD}';
  if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('gzip')) return '\u{1F4E6}';
  return '\u{1F4CE}';
}

export default function AttachmentList({
  projectId,
  entityType,
  entityId,
  showUpload = false,
}: AttachmentListProps) {
  const { t } = useTranslation();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api.attachments
      .list(projectId, entityType, entityId)
      .then(setAttachments)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId, entityType, entityId]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id: string) => {
    await api.attachments.delete(id);
    load();
  };

  const handleDownload = (att: Attachment) => {
    window.open(api.attachments.downloadUrl(att._id), '_blank');
  };

  if (loading) {
    return <p className="text-sm text-gray-500">{t('common.loading')}</p>;
  }

  return (
    <div className="space-y-3">
      {showUpload && (
        <FileUploadZone
          projectId={projectId}
          entityType={entityType}
          entityId={entityId}
          onUploadComplete={load}
        />
      )}

      {attachments.length === 0 && !showUpload && (
        <EmptyState message={t('attachments.empty')} />
      )}

      {attachments.length > 0 && (
        <div className="space-y-2">
          {attachments.map((att) => (
            <div
              key={att._id}
              className="flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2.5"
            >
              <span className="text-lg flex-shrink-0" title={att.mimeType}>
                {fileIcon(att.mimeType)}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm text-gray-200 truncate">{att.originalName}</p>
                  {!entityType && att.entityType && (
                    <Badge color="bg-violet-900/50 text-violet-300 border border-violet-700/50">
                      {t(`attachments.entity_${att.entityType}`, att.entityType)}
                    </Badge>
                  )}
                  {!entityType && !att.entityType && (
                    <Badge color="bg-gray-800 text-gray-400 border border-gray-700">
                      {t('attachments.projectFile')}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-gray-500">
                  {formatSize(att.size)}
                  {' \u00B7 '}
                  {new Date(att.createdAt).toLocaleDateString()}
                  {att.ragIndexed && (
                    <span className="ml-1.5 text-cyan-600" title={t('attachments.indexed')}>RAG</span>
                  )}
                </p>
              </div>
              <div className="flex gap-1.5 flex-shrink-0">
                <Button
                  variant="ghost-blue"
                  size="xs"
                  onClick={() => handleDownload(att)}
                  title={t('attachments.download')}
                >
                  {t('attachments.download')}
                </Button>
                <ConfirmButton
                  onConfirm={() => handleDelete(att._id)}
                  size="xs"
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

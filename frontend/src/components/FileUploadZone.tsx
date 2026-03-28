import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';

interface FileUploadZoneProps {
  projectId: string;
  entityType?: string;
  entityId?: string;
  onUploadComplete: () => void;
}

export default function FileUploadZone({
  projectId,
  entityType,
  entityId,
  onUploadComplete,
}: FileUploadZoneProps) {
  const { t } = useTranslation();
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      if (fileArray.length === 0) return;
      setUploading(true);
      try {
        for (let i = 0; i < fileArray.length; i++) {
          setProgress(`${i + 1}/${fileArray.length}: ${fileArray[i].name}`);
          await api.attachments.upload(projectId, fileArray[i], {
            entityType,
            entityId,
          });
        }
        onUploadComplete();
      } catch (err) {
        alert((err as Error).message);
      } finally {
        setUploading(false);
        setProgress('');
      }
    },
    [projectId, entityType, entityId, onUploadComplete],
  );

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    setDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragging(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    dragCounter.current = 0;
    if (e.dataTransfer.files.length > 0) {
      uploadFiles(e.dataTransfer.files);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      uploadFiles(e.target.files);
      e.target.value = '';
    }
  };

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onClick={() => !uploading && inputRef.current?.click()}
      className={`relative rounded-lg border-2 border-dashed transition-colors cursor-pointer
        ${dragging ? 'border-cyan-400 bg-cyan-400/5' : 'border-gray-700 hover:border-gray-600 bg-gray-900/50'}
        ${uploading ? 'pointer-events-none opacity-60' : ''}
        px-4 py-5 text-center`}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        onChange={handleFileSelect}
        className="hidden"
      />
      {uploading ? (
        <p className="text-sm text-cyan-400">{progress}</p>
      ) : (
        <p className="text-sm text-gray-500">
          {t('attachments.dropzone')}
        </p>
      )}
    </div>
  );
}

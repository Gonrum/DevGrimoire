import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, StackListItem } from '../api/client';
import { useToast } from '../components/Toast';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import { LoadingText } from '../components/ui/LoadingSpinner';
import CreateStackDialog from '../components/stacks/CreateStackDialog';
import { errorMessage } from '../lib/narrow';

export default function StacksOverview() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { showError, showSuccess } = useToast();
  const [stacks, setStacks] = useState<StackListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  /*
   * Der Ladevorgang liegt im Effekt, damit der Cleanup ihn als veraltet
   * markieren kann. `String(err)` ist raus: bei einem geworfenen Objekt stand da
   * "[object Object]" im Toast.
   */
  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoading(true);
      try {
        const list = await api.stacks.list();
        if (!cancelled) setStacks(list);
      } catch (err) {
        if (!cancelled) showError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => { cancelled = true; };
  }, [showError]);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!window.confirm(t('stacks.confirmDelete'))) return;
    try {
      await api.stacks.delete(id);
      setStacks((prev) => prev.filter((s) => s._id !== id));
      showSuccess(t('stacks.deleted'));
    } catch (err) {
      showError(errorMessage(err));
    }
  };

  if (loading) return <LoadingText />;

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl sm:text-2xl font-bold font-grimoire">{t('stacks.title')}</h1>
        <Button variant="primary" onClick={() => setShowCreate(true)}>{t('stacks.new')}</Button>
      </div>

      {stacks.length === 0 ? (
        <EmptyState message={t('stacks.empty')} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {stacks.map((s) => (
            <div
              key={s._id}
              onClick={() => { void navigate(`/stacks/${s._id}`); }}
              className="bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-cyan-700 transition cursor-pointer"
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-lg font-semibold text-gray-100">{s.name}</h2>
                <Button variant="ghost" onClick={(e) => { void handleDelete(e, s._id); }}>{t('common.delete')}</Button>
              </div>
              {s.description && <p className="text-sm text-gray-400 mt-1 line-clamp-2">{s.description}</p>}
              <p className="text-xs text-gray-500 mt-3">{t('stacks.sectionCount', { count: s.entryCount })}</p>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateStackDialog
          onCancel={() => setShowCreate(false)}
          onCreated={(id) => { setShowCreate(false); void navigate(`/stacks/${id}`); }}
        />
      )}
    </div>
  );
}

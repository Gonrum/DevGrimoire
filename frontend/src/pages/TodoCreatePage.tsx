import { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { api, Todo, Milestone } from '../api/client';
import MarkdownEditor from '../components/MarkdownEditor';

export default function TodoCreatePage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Todo['priority']>('medium');
  const [tags, setTags] = useState('');
  const [milestoneId, setMilestoneId] = useState(searchParams.get('milestoneId') || '');
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [saving, setSaving] = useState(false);
  const [newMilestoneName, setNewMilestoneName] = useState('');
  const [creatingMilestone, setCreatingMilestone] = useState(false);

  const loadMilestones = () => { if (id) api.milestones.list(id).then(setMilestones); };
  useEffect(() => { loadMilestones(); }, [id]);

  const handleCreateMilestone = async () => {
    if (!id || !newMilestoneName.trim()) return;
    const ms = await api.milestones.create({ projectId: id, name: newMilestoneName.trim() });
    setNewMilestoneName('');
    setCreatingMilestone(false);
    setMilestoneId(ms._id);
    loadMilestones();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !title.trim()) return;
    setSaving(true);
    try {
      await api.todos.create({
        projectId: id,
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        status: 'open',
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        milestoneId: milestoneId || undefined,
      } as Partial<Todo> & { milestoneId?: string });
      navigate(`/projects/${id}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Link to={`/projects/${id}`} className="text-sm text-gray-500 hover:text-gray-300 mb-6 inline-block">&larr; Zurück zum Projekt</Link>

      <h1 className="text-xl font-bold mb-6">Neuer Task</h1>

      <form onSubmit={handleSubmit} className="max-w-2xl space-y-4">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Titel *</label>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task-Titel"
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500" autoFocus />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Beschreibung</label>
          <MarkdownEditor value={description} onChange={setDescription} rows={5} placeholder="Detaillierte Beschreibung (optional, Markdown)" />
        </div>
        <div className="flex flex-col sm:flex-row gap-4 items-start">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Priorität</label>
            <select value={priority} onChange={(e) => setPriority(e.target.value as Todo['priority'])}
              className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500">
              <option value="low">Niedrig</option>
              <option value="medium">Mittel</option>
              <option value="high">Hoch</option>
              <option value="critical">Kritisch</option>
            </select>
          </div>
          <div className="flex-1 w-full sm:w-auto">
            <label className="block text-xs text-gray-500 mb-1">Tags</label>
            <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="kommagetrennt, z.B. frontend, bugfix"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500" />
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Milestone</label>
          <div className="flex flex-wrap items-center gap-2">
            <select value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500">
              <option value="">Kein Milestone</option>
              {milestones.map((ms) => (
                <option key={ms._id} value={ms._id}>{ms.name}</option>
              ))}
            </select>
            {creatingMilestone ? (
              <div className="flex items-center gap-2">
                <input type="text" value={newMilestoneName} onChange={(e) => setNewMilestoneName(e.target.value)}
                  placeholder="Milestone-Name" autoFocus onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleCreateMilestone())}
                  className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500" />
                <button type="button" onClick={handleCreateMilestone} disabled={!newMilestoneName.trim()}
                  className="text-xs px-2.5 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors">
                  Anlegen
                </button>
                <button type="button" onClick={() => { setCreatingMilestone(false); setNewMilestoneName(''); }}
                  className="text-xs px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded transition-colors">
                  Abbrechen
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setCreatingMilestone(true)}
                className="text-xs px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded transition-colors">
                + Neuer Milestone
              </button>
            )}
          </div>
        </div>
        <div className="flex gap-2 pt-2">
          <button type="submit" disabled={saving || !title.trim()}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors">
            {saving ? 'Erstellen...' : 'Task erstellen'}
          </button>
          <button type="button" onClick={() => navigate(`/projects/${id}`)}
            className="px-4 py-2 text-sm bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg transition-colors">
            Abbrechen
          </button>
        </div>
      </form>
    </div>
  );
}

import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';

export default function MilestoneCreatePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !name.trim()) return;
    setSaving(true);
    try {
      await api.milestones.create({
        projectId: id,
        name: name.trim(),
        description: description.trim() || undefined,
        dueDate: dueDate || undefined,
      });
      navigate(`/projects/${id}?tab=milestones`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Link to={`/projects/${id}`} className="text-sm text-gray-500 hover:text-gray-300 mb-6 inline-block">&larr; Zurück zum Projekt</Link>

      <h1 className="text-xl font-bold mb-6">Neuer Milestone</h1>

      <form onSubmit={handleSubmit} className="max-w-3xl mx-auto space-y-4">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Name *</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Milestone-Name"
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500" autoFocus />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Beschreibung</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder="Beschreibung (optional)"
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-none" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Fälligkeitsdatum (optional)</label>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500" />
        </div>
        <div className="flex gap-2 pt-2">
          <button type="submit" disabled={saving || !name.trim()}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors">
            {saving ? 'Erstellen...' : 'Milestone erstellen'}
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

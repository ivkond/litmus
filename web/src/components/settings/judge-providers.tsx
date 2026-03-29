'use client';

import { useState, useEffect, useCallback } from 'react';

interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  priority: number;
}

export function JudgeProviders() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', baseUrl: '', apiKey: '', model: '' });
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { success: boolean; latencyMs: number; error?: string }>>({});
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const loadProviders = useCallback(async () => {
    const res = await fetch('/api/settings/judge-providers');
    if (res.ok) setProviders(await res.json());
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/judge-providers')
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((data: Provider[]) => { if (!cancelled) setProviders(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  async function addProvider() {
    const res = await fetch('/api/settings/judge-providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      setAdding(false);
      setForm({ name: '', baseUrl: '', apiKey: '', model: '' });
      loadProviders();
    }
  }

  async function toggleEnabled(id: string, enabled: boolean) {
    await fetch(`/api/settings/judge-providers/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    loadProviders();
  }

  async function deleteProvider(id: string) {
    await fetch(`/api/settings/judge-providers/${id}`, { method: 'DELETE' });
    loadProviders();
  }

  async function testProvider(id: string) {
    setTesting(id);
    const res = await fetch(`/api/settings/judge-providers/${id}/test`, { method: 'POST' });
    if (res.ok) {
      const result = await res.json();
      setTestResult((prev) => ({ ...prev, [id]: result }));
    }
    setTesting(null);
  }

  function handleDragStart(index: number) {
    setDragIdx(index);
  }

  function handleDragOver(e: React.DragEvent, targetIdx: number) {
    e.preventDefault();
    if (dragIdx === null || dragIdx === targetIdx) return;
    const reordered = [...providers];
    const [moved] = reordered.splice(dragIdx, 1);
    reordered.splice(targetIdx, 0, moved);
    setProviders(reordered);
    setDragIdx(targetIdx);
  }

  async function handleDragEnd() {
    setDragIdx(null);
    // Persist new priority order
    const priorities = providers.map((p, i) => ({ id: p.id, priority: i + 1 }));
    await fetch('/api/settings/judge-providers/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priorities }),
    });
  }

  return (
    <section>
      <h2 className="text-lg font-semibold mb-4">Judge Providers</h2>
      <div className="space-y-2">
        {providers.map((p, idx) => (
          <div
            key={p.id}
            draggable
            onDragStart={() => handleDragStart(idx)}
            onDragOver={(e) => handleDragOver(e, idx)}
            onDragEnd={handleDragEnd}
            className={`flex items-center gap-3 p-3 border rounded ${
              dragIdx === idx ? 'opacity-60 bg-gray-100' : ''
            } cursor-grab`}
          >
            <span className="text-gray-400 select-none">⠿</span>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={p.enabled}
                onChange={(e) => toggleEnabled(p.id, e.target.checked)}
              />
              <span className="font-medium">{p.name}</span>
            </label>
            <span className="text-sm text-gray-500">{p.model}</span>
            <span className="text-sm text-gray-400">{p.apiKey}</span>
            <div className="ml-auto flex gap-2">
              <button
                className="text-sm px-2 py-1 border rounded"
                onClick={() => testProvider(p.id)}
                disabled={testing === p.id}
              >
                {testing === p.id ? '...' : 'Test'}
              </button>
              {testResult[p.id] && (
                <span className={`text-sm ${testResult[p.id].success ? 'text-green-600' : 'text-red-600'}`}>
                  {testResult[p.id].success ? `OK ${testResult[p.id].latencyMs}ms` : testResult[p.id].error}
                </span>
              )}
              <button
                className="text-sm px-2 py-1 text-red-600 border rounded"
                onClick={() => deleteProvider(p.id)}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {adding ? (
        <div className="mt-4 p-4 border rounded space-y-2">
          <input className="w-full p-2 border rounded" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="w-full p-2 border rounded" placeholder="Base URL" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
          <input className="w-full p-2 border rounded" placeholder="API Key" type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          <input className="w-full p-2 border rounded" placeholder="Model ID" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          <div className="flex gap-2">
            <button className="px-4 py-2 bg-blue-600 text-white rounded" onClick={addProvider}>Save</button>
            <button className="px-4 py-2 border rounded" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="mt-4 px-4 py-2 border rounded" onClick={() => setAdding(true)}>
          + Add Provider
        </button>
      )}
    </section>
  );
}

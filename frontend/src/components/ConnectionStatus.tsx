import { useState, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';

export default function ConnectionStatus() {
  const [connected, setConnected] = useState(false);
  const { getAccessToken } = useAuth();

  useEffect(() => {
    const token = getAccessToken();
    const params = new URLSearchParams();
    if (token) params.set('token', token);
    const url = `/api/events?${params}`;

    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout>;

    function connect() {
      es = new EventSource(url);
      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        es?.close();
        retryTimer = setTimeout(connect, 5000);
      };
    }

    connect();

    return () => {
      es?.close();
      clearTimeout(retryTimer);
    };
  }, [getAccessToken]);

  return (
    <span
      className={`w-2 h-2 rounded-full shrink-0 ${connected ? 'bg-green-500' : 'bg-red-500'}`}
      title={connected ? 'Live-Verbindung aktiv' : 'Keine Verbindung'}
    />
  );
}

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { wsEventBus, type WsConnectionState } from '../api/wsEventBus';

const STATE_COLORS: Record<WsConnectionState, string> = {
  open: 'bg-green-500',
  connecting: 'bg-yellow-500 animate-pulse',
  reconnecting: 'bg-yellow-500 animate-pulse',
  closed: 'bg-red-500',
};

export default function ConnectionStatus() {
  const { t } = useTranslation();
  const [state, setState] = useState<WsConnectionState>(wsEventBus.getState());

  useEffect(() => wsEventBus.onStateChange(setState), []);

  const title =
    state === 'open'
      ? t('connection.connected')
      : state === 'connecting' || state === 'reconnecting'
        ? t('connection.connecting')
        : t('connection.disconnected');

  return (
    <span
      className={`w-2 h-2 rounded-full shrink-0 ${STATE_COLORS[state]}`}
      title={title}
    />
  );
}

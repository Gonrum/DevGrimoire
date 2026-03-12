import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { api, Notification } from '../api/client';

function timeAgo(date: string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return i18n.t('notifications.justNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return i18n.t('activity.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return i18n.t('activity.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  return i18n.t('activity.daysAgo', { count: days });
}

export default function NotificationBell() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const fetchUnreadCount = useCallback(async () => {
    try {
      const { count } = await api.notifications.unreadCount();
      setUnreadCount(count);
    } catch { /* ignore */ }
  }, []);

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const items = await api.notifications.list(30);
      setNotifications(items);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  // Initial load + poll every 15s
  useEffect(() => {
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 15000);
    return () => clearInterval(interval);
  }, [fetchUnreadCount]);

  // Listen for SSE notification events with auto-reconnect
  useEffect(() => {
    const token = localStorage.getItem('devgrimoire_access_token');
    const params = new URLSearchParams();
    if (token) params.set('token', token);
    const url = `/api/events?${params}`;

    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout>;
    let retryDelay = 1000;
    const MAX_RETRY_DELAY = 30000;

    function connect() {
      es = new EventSource(url);
      es.onopen = () => { retryDelay = 1000; };
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.entity === 'notification' && data.action === 'created') {
            fetchUnreadCount();
            if (open) fetchNotifications();
          }
        } catch { /* ignore */ }
      };
      es.onerror = () => {
        es?.close();
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
      };
    }

    connect();

    return () => {
      es?.close();
      clearTimeout(retryTimer);
    };
  }, [fetchUnreadCount, fetchNotifications, open]);

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const toggle = () => {
    if (!open) fetchNotifications();
    setOpen(!open);
  };

  const handleClick = async (n: Notification) => {
    if (!n.read) {
      await api.notifications.markAsRead(n._id);
      setNotifications((prev) =>
        prev.map((x) => (x._id === n._id ? { ...x, read: true } : x)),
      );
      setUnreadCount((c) => Math.max(0, c - 1));
    }
    if (n.url) {
      navigate(n.url);
      setOpen(false);
    }
  };

  const markAllRead = async () => {
    await api.notifications.markAllAsRead();
    setNotifications((prev) => prev.map((x) => ({ ...x, read: true })));
    setUnreadCount(0);
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={toggle}
        className="relative text-gray-400 hover:text-gray-200 transition-colors p-1"
        title={t('notifications.title')}
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 sm:w-96 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 max-h-[70vh] flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
            <span className="text-sm font-medium text-white">{t('notifications.title')}</span>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="text-xs text-cyan-400 hover:text-cyan-300"
              >
                {t('notifications.markAllRead')}
              </button>
            )}
          </div>

          <div className="overflow-y-auto flex-1">
            {loading && notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-gray-500 text-sm">{t('common.loading')}</div>
            ) : notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-gray-500 text-sm">
                {t('notifications.noNotifications')}
              </div>
            ) : (
              notifications.map((n) => (
                <button
                  key={n._id}
                  onClick={() => handleClick(n)}
                  className={`w-full text-left px-4 py-3 border-b border-gray-800 hover:bg-gray-800/50 transition-colors flex gap-3 ${
                    n.read ? 'opacity-60' : ''
                  }`}
                >
                  {!n.read && (
                    <span className="mt-1.5 w-2 h-2 bg-violet-500 rounded-full shrink-0" />
                  )}
                  <div className={!n.read ? '' : 'pl-5'}>
                    <div className="text-sm font-medium text-gray-200">{n.title}</div>
                    <div className="text-xs text-gray-400 mt-0.5 line-clamp-2">{n.body}</div>
                    <div className="text-[11px] text-gray-500 mt-1">{timeAgo(n.createdAt)}</div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

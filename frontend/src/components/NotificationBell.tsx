import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { api, Notification } from '../api/client';
import { wsEventBus, isProjectChangeEvent } from '../api/wsEventBus';

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

  useEffect(() => {
    fetchUnreadCount();
  }, [fetchUnreadCount]);

  // Live updates via the WS bus. The bus handles reconnect/heartbeat for us;
  // the 15s belt-and-suspenders fetch loop the old SSE path needed is gone.
  useEffect(() => {
    const unsub = wsEventBus.subscribe({ kind: 'global' }, (event) => {
      if (!isProjectChangeEvent(event)) return;
      if (event.entity === 'notification' && event.action === 'created') {
        fetchUnreadCount();
        if (open) fetchNotifications();
      }
    });
    return unsub;
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

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const n = notifications.find((x) => x._id === id);
    await api.notifications.delete(id);
    setNotifications((prev) => prev.filter((x) => x._id !== id));
    if (n && !n.read) setUnreadCount((c) => Math.max(0, c - 1));
  };

  const deleteAll = async () => {
    await api.notifications.deleteAll();
    setNotifications([]);
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
        <div className="absolute right-0 top-full mt-2 w-[calc(100vw-2rem)] sm:w-96 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 max-h-[70vh] flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
            <span className="text-sm font-medium text-white">{t('notifications.title')}</span>
            <div className="flex items-center gap-3">
              {unreadCount > 0 && (
                <button
                  onClick={markAllRead}
                  className="text-xs text-cyan-400 hover:text-cyan-300"
                >
                  {t('notifications.markAllRead')}
                </button>
              )}
              {notifications.length > 0 && (
                <button
                  onClick={deleteAll}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  {t('notifications.deleteAll')}
                </button>
              )}
            </div>
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
                <div
                  key={n._id}
                  onClick={() => handleClick(n)}
                  className={`w-full text-left px-4 py-3 border-b border-gray-800 hover:bg-gray-800/50 transition-colors flex gap-3 group ${n.url ? 'cursor-pointer' : 'cursor-default'} ${
                    n.read ? 'opacity-60' : ''
                  }`}
                >
                  {!n.read && (
                    <span className="mt-1.5 w-2 h-2 bg-violet-500 rounded-full shrink-0" />
                  )}
                  <div className={`flex-1 min-w-0 ${!n.read ? '' : 'pl-5'}`}>
                    <div className="text-sm font-medium text-gray-200">{n.title}</div>
                    <div className="text-xs text-gray-400 mt-0.5 line-clamp-2">{n.body}</div>
                    <div className="text-[11px] text-gray-500 mt-1">{timeAgo(n.createdAt)}</div>
                  </div>
                  <button
                    onClick={(e) => handleDelete(e, n._id)}
                    className="shrink-0 opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 transition-all p-1 self-center"
                    title={t('notifications.delete')}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                      <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
                    </svg>
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

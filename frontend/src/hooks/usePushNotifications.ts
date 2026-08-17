import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';

/**
 * VAPID-Key (base64url) → Bytes für `pushManager.subscribe`.
 *
 * Rückgabetyp ist `Uint8Array<ArrayBuffer>`, nicht `Uint8Array`: `BufferSource`
 * verlangt einen echten `ArrayBuffer` als Speicher, `Uint8Array.from` liefert
 * aber `Uint8Array<ArrayBufferLike>`. Vorher überbrückte ein `as BufferSource`
 * genau diese Lücke — der Puffer wird jetzt gleich passend angelegt.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(rawData.length));
  for (let i = 0; i < rawData.length; i++) bytes[i] = rawData.charCodeAt(i);
  return bytes;
}

export function usePushNotifications() {
  // Beides steht schon beim ersten Render fest — der Lazy-Initializer läuft
  // genau einmal, statt den Wert per Effect nachzureichen (was einen zweiten
  // Render und ein sichtbares Flackern von "nicht unterstützt" bedeutete).
  const [supported] = useState(
    () => 'serviceWorker' in navigator && 'PushManager' in window,
  );
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    'Notification' in window ? Notification.permission : 'default',
  );
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    const run = async () => {
      try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (!cancelled) setSubscribed(subscription !== null);
      } catch {
        // Kein erreichbarer Service Worker → als "nicht abonniert" behandeln.
        // Vorher blieb dieselbe Rejection unbehandelt stehen.
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [supported]);

  const subscribe = useCallback(async () => {
    if (!supported) return;
    setLoading(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await api.push.getVapidKey();
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await api.push.subscribe(sub.toJSON());
      setSubscribed(true);
      setPermission(Notification.permission);
    } catch (err) {
      console.error('Push subscription failed:', err);
    } finally {
      setLoading(false);
    }
  }, [supported]);

  const unsubscribe = useCallback(async () => {
    if (!supported) return;
    setLoading(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api.push.unsubscribe(sub.endpoint);
        await sub.unsubscribe();
      }
      setSubscribed(false);
    } finally {
      setLoading(false);
    }
  }, [supported]);

  return { supported, permission, subscribed, loading, subscribe, unsubscribe };
}

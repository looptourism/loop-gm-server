// Minimal service worker: receives a push payload from the server and shows
// a device notification, even when the app isn't open.
self.addEventListener('push', (event) => {
  let data = { title: 'Loop', body: '' };
  try { data = event.data.json(); } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'Loop', {
      body: data.body || '',
      icon: undefined,
      badge: undefined,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});

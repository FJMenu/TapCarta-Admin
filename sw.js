const TAPCARTA_ADMIN_SW_VERSION = 'tapcarta-admin-v1-3-1-1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

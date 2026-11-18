/// <reference lib="webworker" />
// Service worker of the phone PWA (vite-plugin-pwa `injectManifest`).
//
// Part 1 reproduces what `generateSW` produced before, so installs behave the same:
// precache the build output (js, css, html, woff2), clean old caches, take over at once
// (registerType: autoUpdate), serve index.html for navigations except /bridge and the dev-info
// file, and never cache /bridge.
//
// Part 2 is push: show a notification for every push (iOS revokes subscriptions that stay
// silent), with Allow / Deny buttons when the payload carries a one-shot token, and open or
// focus the pane on tap.
//
// Part 3 takes a share from the phone's Share menu (a POST to /share-target) and opens "New chat with this".
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { NetworkOnly } from 'workbox-strategies';
import {
  OPEN_ITEM_MESSAGE,
  OPEN_PANE_MESSAGE,
  OPEN_VIEW_MESSAGE,
  isDesktopAppOrigin,
  openUrl,
  parsePushPayload,
  planNotification,
  type OpenTarget,
} from './pwa/push-core';
import { handleNotificationClick, type ClickedNotification } from './pwa/notification-click';
import { writeIntent } from './pwa/push-intent';
import { handleShareRequest, isShareRequest } from './pwa/share-target';
import { actUrl } from './pwa/where';

declare const self: ServiceWorkerGlobalScope;

void self.skipWaiting();

if (isDesktopAppOrigin(self.location)) {
  // Inside the desktop app: precache nothing and serve nothing. On activate, drop the old
  // precache, unregister, and reload open windows so they load the installed version's UI.
  self.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        // Claim first: a window can only be navigated by the worker that controls it.
        await self.clients.claim();
        const names = await caches.keys();
        await Promise.all(names.filter((name) => name.startsWith('workbox-precache')).map((name) => caches.delete(name)));
        await self.registration.unregister();
        const windows = await self.clients.matchAll({ type: 'window' });
        await Promise.all(windows.map((client) => client.navigate(client.url).catch(() => null)));
      })(),
    );
  });
} else {
  clientsClaim();
  cleanupOutdatedCaches();
  precacheAndRoute(self.__WB_MANIFEST);
  registerRoute(
    new NavigationRoute(createHandlerBoundToURL('index.html'), {
      denylist: [/^\/bridge/, /^\/__puppet_master_dev__/],
    }),
  );
  registerRoute(({ url }) => url.pathname.startsWith('/bridge/'), new NetworkOnly());
}

// --- share to Potato ---------------------------------------------------------------------
// The phone's Share menu posts text, a link or pictures to /share-target (manifest `share_target`). The worker keeps
// them in Cache Storage and sends the window to /?share=1; the app opens "New chat with this". Nothing is sent to the PC.

self.addEventListener('fetch', (event) => {
  if (!isShareRequest(event.request, self.registration.scope)) return;
  event.respondWith(handleShareRequest(event.request, self.caches, Date.now(), self.registration.scope));
});

// --- push ---------------------------------------------------------------------------------

self.addEventListener('push', (event) => {
  const plan = planNotification(parsePushPayload(event.data?.text()), self.registration.scope);
  event.waitUntil(self.registration.showNotification(plan.title, plan.options as NotificationOptions));
});

async function answer(url: string, token: string, choice: 'allow' | 'deny'): Promise<boolean> {
  try {
    // From a permanent address (a Worker) the tap goes to the tunnel it names; the Worker no longer carries /bridge calls.
    const target = await actUrl(url, self.registration.scope);
    if (!target) return false;
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, choice }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Open what the tapped notification is about. The intent goes to Cache Storage FIRST: on iOS a PWA that
 * went to the background can be frozen, and a message posted before it thaws is lost, but the app reads
 * the cache when it comes back. Then the open window is focused and told, or a new one is opened on the
 * card (`/?item=`), the pane (`/?pane=`) or the question list.
 */
async function openTarget(target: OpenTarget): Promise<void> {
  try {
    await writeIntent(self.caches, { itemId: target.itemId, paneId: target.paneId, view: target.view, at: Date.now() });
  } catch {
    /* Cache Storage unavailable: the message and the launch URL still work */
  }
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const existing = windows.find((client) => 'focus' in client) as WindowClient | undefined;
  if (existing) {
    await existing.focus();
    if (target.itemId) existing.postMessage({ type: OPEN_ITEM_MESSAGE, item_id: target.itemId, pane_id: target.paneId ?? undefined });
    else if (target.view) existing.postMessage({ type: OPEN_VIEW_MESSAGE, view: target.view });
    else if (target.paneId) existing.postMessage({ type: OPEN_PANE_MESSAGE, pane_id: target.paneId });
    return;
  }
  await self.clients.openWindow(new URL(openUrl(target), self.registration.scope).href);
}

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  const data = notification.data as ClickedNotification['data'];
  notification.close();
  event.waitUntil(
    handleNotificationClick(event.action, { tag: notification.tag, data }, {
      fetch: async (url, init) => {
        // The Allow / Deny tap goes to the tunnel the Worker names (the Worker no longer carries /bridge calls).
        const at = new URL(url);
        const own = at.origin === new URL(self.registration.scope).origin;
        const target = own ? await actUrl(`${at.pathname}${at.search}`, self.registration.scope) : url;
        // The Worker cannot name the PC right now: the tap is not sent (the notification says it did not work).
        return target ? fetch(target, init) : { ok: false };
      },
      scope: self.registration.scope,
      open: openTarget,
      notify: (title, options) => self.registration.showNotification(title, options),
    }),
  );
});

# Stable link moved

The stable phone link is now part of the one Potato Worker in [`relay/worker`](../worker/README.md): the same
deploy (`cd relay/worker && npm install`, `npx wrangler login`, `npm run deploy`) gives you the team relay, the
stable phone link and invite links. See "Potato Worker" there.

A Worker you deployed from this folder earlier keeps working. To get invite links too, deploy `relay/worker`
(keep the name `pm-relay` to upgrade an earlier relay in place).

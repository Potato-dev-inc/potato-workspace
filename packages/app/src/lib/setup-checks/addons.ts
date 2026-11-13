// Chat add-ons: from `acp_addon_status`. Shown only while the Chat Labs switch is on.
import { t } from '../../i18n';
import type { AddonList } from '../acpAddon';
import type { CheckRow } from './types';

export function checkAddons(list: AddonList): CheckRow[] {
  return list.addons.map((a): CheckRow => {
    const id = `addon-${a.agent}`;
    if (a.state === 'installed') {
      const old = a.pinned_version !== null && a.version !== a.pinned_version;
      return old
        ? { id, status: 'warn', sentence: t('overview.check.addon.old', { label: a.label }), fix: { kind: 'installAddon', label: t('overview.fix.update'), agentId: a.agent } }
        : { id, status: 'ok', sentence: t('overview.check.addon.upToDate', { label: a.label }), fix: null };
    }
    if (a.state === 'installing') return { id, status: 'warn', sentence: t('overview.check.addon.installing', { label: a.label }), fix: null };
    if (a.state === 'failed') {
      return { id, status: 'fail', sentence: a.detail || t('overview.check.addon.failed', { label: a.label }), fix: { kind: 'installAddon', label: t('overview.fix.install'), agentId: a.agent } };
    }
    return { id, status: 'warn', sentence: t('overview.check.addon.notInstalled', { label: a.label }), fix: { kind: 'installAddon', label: t('overview.fix.install'), agentId: a.agent } };
  });
}

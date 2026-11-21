// "My domain" + Address book: the guided panel. Three plain steps (free the name, put the Address book on it, check), each with
// the do-it-by-hand help (copy buttons for the two files and links into the Cloudflare dashboard), and one live status line that
// says what the last Check found. A step spins only while something is really running. "Set it up for me" is a visible, disabled
// slot: a later change turns it on. No commands are shown; the only code a person ever sees is the file content they copy.
import { useState } from 'react';
import { useT, type MessageKey } from '../../i18n';
import type { IconKind } from '../../lib/linkChecklist';
import { tauri } from '../../lib/tauri';
import type { ThisPcHandle } from './ThisPc';
import { StatusIcon } from './ThisPc';

export const CLOUDFLARE_DNS_URL = 'https://dash.cloudflare.com/?to=/:account/:zone/dns/records';
export const CLOUDFLARE_WORKERS_URL = 'https://dash.cloudflare.com/?to=/:account/workers-and-pages';

const hostOf = (url: string) => url.replace(/^https?:\/\//, '');
/** Reasons that mean "this PC is being told" (or the Worker is busy): not a failure of the name. */
const TELLING = ['not_linked', 'stale', 'busy'];

export function BookSetup({ pc, openExternal = (url: string) => tauri.openExternalUrl(url) }: { pc: ThisPcHandle; openExternal?: (url: string) => Promise<unknown> | void }) {
  const t = useT();
  const [replace, setReplace] = useState(false);
  if (!pc.domain) return null;
  const domain = hostOf(pc.domain);
  const reason = pc.domainReason;
  const failed = pc.domainStatus === 'bad';
  const works = pc.domainStatus === 'ok' || (pc.domainVerified && !failed);
  const isDirect = failed && reason === 'is_direct';
  const telling = failed && TELLING.includes(reason ?? '');
  // The steps help with the name; they stay out of the way when the name already works, and while "already Direct" is being decided.
  const showSteps = (!works || pc.bookOpen) && !(isDirect && !replace) && !telling && reason !== 'tunnel_down';

  let icon: IconKind = 'idle';
  let line = t('connect.book.notChecked');
  if (pc.domainAsking) {
    icon = 'busy';
    line = t('connect.book.checking');
  } else if (failed) {
    line = pc.domainLine;
    if (telling) {
      // A spinner only while this PC really is telling the Worker. A final registration failure is shown, never hidden under one.
      const regFailed = pc.book?.link === 'failed' && reason !== 'busy';
      if (regFailed) {
        line = t(`check.book.reg.failed.${pc.book?.reason ?? 'other'}` as MessageKey, { domain });
        icon = pc.book?.reason === 'worker_too_old' ? 'warn' : 'bad';
      } else {
        icon = pc.book?.link === 'linking' && reason !== 'busy' ? 'busy' : 'idle';
      }
    } else {
      icon = reason === 'tunnel_down' ? 'warn' : 'bad';
    }
  } else if (works) {
    icon = 'ok';
    line = t('check.book.works', { domain });
  }

  const open = (url: string) => void Promise.resolve(openExternal(url)).catch(() => undefined);

  return (
    <div className="cx-book" data-testid="connect-book-setup" data-reason={reason ?? ''}>
      <div className="cx-book-head">{t('connect.book.setupTitle', { domain })}</div>
      <div className="cx-book-status" role="status" data-testid="connect-book-status" data-state={pc.domainAsking ? 'checking' : failed ? 'problem' : works ? 'works' : 'idle'}>
        <StatusIcon kind={icon} testid="connect-book-status-icon" />
        <span data-testid="connect-book-status-text">{line}</span>
      </div>
      {isDirect && (
        <div className="cx-act cx-book-actions" data-testid="connect-book-direct-choice">
          <button type="button" className="cx-btn cx-primary" data-testid="connect-book-use-direct" disabled={pc.switching} onClick={pc.useDirect}>
            {t('connect.book.useDirect')}
          </button>
          <button type="button" className="cx-btn" data-testid="connect-book-replace" aria-pressed={replace} onClick={() => setReplace(true)}>
            {t('connect.book.replace')}
          </button>
        </div>
      )}
      {failed && reason === 'dns_taken' && (
        <div className="cx-act cx-book-actions">
          {/* Replacing the record for the person is the one-click setup's job (a later change); until then this stays visible but off. */}
          <button type="button" className="cx-btn" data-testid="connect-book-replace" disabled title={t('connect.book.forMeSoon')}>
            {t('connect.book.replace')}
          </button>
        </div>
      )}
      {failed && reason === 'tunnel_down' && (
        <div className="cx-act cx-book-actions">
          <button type="button" className="cx-btn cx-primary" data-testid="connect-book-restart" disabled={pc.busy} onClick={pc.restartTunnel}>
            {t('connect.book.restart')}
          </button>
        </div>
      )}
      {showSteps && (
        <ol className="cx-book-steps" data-testid="connect-book-steps">
          <li data-step="free" data-testid="connect-book-step-free">
            <div className="cx-book-step-title">{t('connect.book.step1')}</div>
            <div className="cx-sub">{t('connect.book.step1Body', { domain })}</div>
            <div className="cx-act cx-book-actions">
              <button type="button" className="cx-btn" data-testid="connect-book-open-dns" data-href={CLOUDFLARE_DNS_URL} onClick={() => open(CLOUDFLARE_DNS_URL)}>
                {t('connect.book.openDns')}
              </button>
            </div>
          </li>
          <li data-step="put" data-testid="connect-book-step-put">
            <div className="cx-book-step-title">{t('connect.book.step2')}</div>
            <div className="cx-sub">{t('connect.book.step2Body', { domain })}</div>
            <div className="cx-act cx-book-actions">
              <button type="button" className="cx-btn cx-primary" data-testid="connect-book-for-me" disabled aria-disabled="true" title={t('connect.book.forMeSoon')}>
                {t('connect.book.forMe')}
              </button>
              <span className="cx-faint" data-testid="connect-book-for-me-note">
                {t('connect.book.forMeSoon')}
              </span>
            </div>
            <div className="cx-book-hand">{t('connect.book.byHand')}</div>
            <div className="cx-act cx-book-actions">
              <button type="button" className="cx-btn" data-testid="connect-book-copy-worker" onClick={() => pc.copyBookFile('worker')}>
                {t('connect.book.copyWorker')}
              </button>
              <button type="button" className="cx-btn" data-testid="connect-book-copy-settings" onClick={() => pc.copyBookFile('settings')}>
                {t('connect.book.copySettings')}
              </button>
              <button type="button" className="cx-btn" data-testid="connect-book-open-workers" data-href={CLOUDFLARE_WORKERS_URL} onClick={() => open(CLOUDFLARE_WORKERS_URL)}>
                {t('connect.book.openWorkers')}
              </button>
            </div>
            <div className="cx-sub" role="status" data-testid="connect-book-copied">
              {pc.bookCopy === 'failed' ? t('connect.book.copyFailed') : pc.bookCopy ? t('connect.book.copied') : t('connect.book.hint')}
            </div>
          </li>
          <li data-step="check" data-testid="connect-book-step-check">
            <div className="cx-book-step-title">{t('connect.book.step3')}</div>
            <div className="cx-sub">{t('connect.book.step3Body', { domain })}</div>
          </li>
        </ol>
      )}
      <div className="cx-act cx-book-actions">
        <button type="button" className="cx-btn" data-testid="connect-book-check" disabled={pc.domainAsking} onClick={pc.checkNow}>
          {pc.domainAsking ? t('connect.book.checking') : t('connect.book.check')}
        </button>
        <button type="button" className="cx-link" data-testid="connect-book-change" onClick={pc.editDomain}>
          {t('connect.book.change')}
        </button>
        {pc.bookOpen && works && (
          <button type="button" className="cx-link" data-testid="connect-book-close" onClick={pc.closeBook}>
            {t('connect.book.close')}
          </button>
        )}
      </div>
    </div>
  );
}

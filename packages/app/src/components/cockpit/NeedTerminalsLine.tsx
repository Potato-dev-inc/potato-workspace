// One quiet line under an agent list while terminals are hidden: "2 agents need terminals · Show terminals". The link opens
// the setting. Nothing is drawn when no agent was left out.
import { useT } from '../../i18n';
import { openSettingsAt } from '../../lib/openSettingsAt';

export function NeedTerminalsLine({ count, onOpen, className = 'ck-menu-note' }: { count: number; onOpen?: () => void; className?: string }) {
  const t = useT();
  if (count <= 0) return null;
  return (
    <div className={`${className} ck-na-need-terminals`} data-testid="need-terminals" role="note">
      <span>{t('chatFirst.need', { count })}</span>
      {' · '}
      <button
        type="button"
        className="ck-menu-setup"
        onClick={() => {
          onOpen?.();
          openSettingsAt('agents', 'show-terminals');
        }}
      >
        {t('chatFirst.show')}
      </button>
    </div>
  );
}

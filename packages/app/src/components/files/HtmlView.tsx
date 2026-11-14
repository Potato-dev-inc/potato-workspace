// An .html file as a page, in the sandbox: its scripts do not run and it cannot reach the app or the network.
import { SandboxFrame } from './SandboxFrame';
import { useT } from '../../i18n';

export function HtmlView({ html, name }: { html: string; name: string }) {
  const t = useT();
  return (
    <div className="ck-html" data-testid="file-html">
      <SandboxFrame html={html} title={t('files.htmlLabel', { name })} className="ck-sandbox ck-sandbox--fill" />
    </div>
  );
}

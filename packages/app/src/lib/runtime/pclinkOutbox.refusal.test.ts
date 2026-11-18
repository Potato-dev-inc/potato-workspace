import { describe, expect, it } from 'vitest';
import { t } from '../../i18n';
import { PcLinkError } from './pclink';
import { pcRefusalText } from './pclinkOutbox';

describe('pcRefusalText', () => {
  it('shows the far PC\'s own sentence when messaging needs Full', () => {
    const body = { error: 'This agent is set to act without asking. Messaging it needs Full on this PC.', code: 'MESSAGE_NEEDS_FULL', needs: 'full' };
    expect(pcRefusalText(new PcLinkError(403, body, 'POST', '/pclink/sessions/p1/messages'), 'x')).toBe(body.error);
  });
  it('any other refusal keeps the general sentence', () => {
    expect(pcRefusalText(new PcLinkError(403, { error: 'no' }, 'POST', '/p'), 'x')).toBe(t('pclink.notAllowed'));
  });
});

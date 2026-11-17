// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { LS_WORKFLOW_STARTS, readWorkflowStart, recordWorkflowStart, splitWorkflowMessage, workflowFirstMessage } from './workflowCard';

const BRIEF = 'You are the front of the workflow "Research + Write".\nYour rules:\n- be brief\n';
beforeEach(() => localStorage.clear());

describe('workflow card marker', () => {
  it('splits the recorded brief from the request; the text the agent got is the same string', () => {
    recordWorkflowStart('p1', { name: 'Research + Write', brief: BRIEF });
    const sent = workflowFirstMessage(BRIEF, ' hi ');
    expect(sent).toBe(`${BRIEF.trimEnd()}\nThe person's request:\nhi`);
    expect(splitWorkflowMessage(sent, readWorkflowStart('p1'))).toEqual({ name: 'Research + Write', brief: BRIEF.trimEnd(), request: 'hi' });
  });

  it('a request that holds the separator itself keeps the rest of it', () => {
    const sent = workflowFirstMessage(BRIEF, "a\nThe person's request:\nb");
    expect(splitWorkflowMessage(sent, { name: 'W', brief: BRIEF })?.request).toBe("a\nThe person's request:\nb");
  });

  it('an empty request leaves an empty request', () => {
    expect(splitWorkflowMessage(workflowFirstMessage(BRIEF, ''), { name: 'W', brief: BRIEF })?.request).toBe('');
  });

  it('shows plain text without a record (old chats) or when the text does not begin with the brief (spoof)', () => {
    const sent = workflowFirstMessage(BRIEF, 'hi');
    expect(splitWorkflowMessage(sent, readWorkflowStart('other'))).toBeNull();
    expect(splitWorkflowMessage(`x ${sent}`, { name: 'W', brief: BRIEF })).toBeNull();
    expect(splitWorkflowMessage(`You are the front of the workflow "Evil".\nThe person's request:\nhi`, { name: 'W', brief: BRIEF })).toBeNull();
  });

  it('survives broken storage and keeps only the newest 200', () => {
    localStorage.setItem(LS_WORKFLOW_STARTS, '{nope');
    expect(readWorkflowStart('p1')).toBeNull();
    for (let i = 0; i < 205; i++) recordWorkflowStart(`p${i}`, { name: 'W', brief: BRIEF });
    expect(readWorkflowStart('p0')).toBeNull();
    expect(readWorkflowStart('p204')).not.toBeNull();
  });
});

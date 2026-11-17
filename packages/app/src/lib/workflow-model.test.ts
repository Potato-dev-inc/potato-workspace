// @vitest-environment jsdom
// The words of the workflow row and card, the pane's place in the dock, and "opens once".
import { beforeEach, describe, expect, it } from 'vitest';
import { workflowLine, workflowTone } from './workflow-model';
import { closeDockPane, openMinionView, openWorkflowPane, openWorkflowPaneOnce, resetTaskViews, slotOf } from './task-view';

const h = (state: string) => ({ state });
beforeEach(() => resetTaskViews());

describe('workflowLine', () => {
  it('names the workflow, then the counts that matter', () => {
    expect(workflowLine('Research + Write', [h('working'), h('working'), h('needs-you')])).toBe('Workflow: Research + Write · 1 needs you · 2 working');
    expect(workflowLine('X', [h('needs-you'), h('needs-you')])).toBe('Workflow: X · 2 need you');
    expect(workflowLine('X', [h('failed'), h('done')])).toBe('Workflow: X · 1 failed');
    expect(workflowLine(null, [h('working')])).toBe('Workflow · 1 working');
  });
  it('says done once everything finished, and nothing extra before anything started', () => {
    expect(workflowLine('X', [h('done'), h('done')])).toBe('Workflow: X · done');
    expect(workflowLine('X', [])).toBe('Workflow: X');
  });
  it('the tone is the most pressing state', () => {
    expect(workflowTone([h('working'), h('needs-you')])).toBe('needs-you');
    expect(workflowTone([h('done'), h('failed')])).toBe('failed');
    expect(workflowTone([h('done'), h('working')])).toBe('working');
    expect(workflowTone([h('done')])).toBe('done');
  });
});

describe('the workflow pane in the dock', () => {
  it('stacks above the minion view', () => {
    openMinionView('p', 'm1');
    openWorkflowPane('p');
    expect(slotOf({ kind: 'workflow' })).toBe('workflow');
  });
  it('opens by itself once; closing it keeps it closed', () => {
    expect(openWorkflowPaneOnce('p')).toBe(true);
    closeDockPane('p', 'workflow');
    expect(openWorkflowPaneOnce('p')).toBe(false);
  });
});

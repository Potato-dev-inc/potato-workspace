// @vitest-environment node
// Simple mode reaches the Today page from the Go back tab (Labs switch on). SimpleProject is too heavy to render in a unit
// test (a live pane, a terminal), so this pins the wiring in its source; the page's own Simple wording is tested in
// components/timeline/TodayPage.screen.test.tsx.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./SimpleProject.tsx', import.meta.url), 'utf8');

describe('Simple mode and the Today page', () => {
  it('shows "See your whole day" in the Go back tab only with the Labs switch on', () => {
    expect(source).toContain("useTimelineEnabled()");
    expect(source).toMatch(/\{todayOn && \(\s*<div className="sx-pad">[\s\S]*?timeline\.simple\.seeDay/);
  });

  it('opens the page in Simple wording and closes it again', () => {
    expect(source).toMatch(/\{dayOpen && todayOn && \(\s*<div className="ck-tl-overlay">\s*<TodayPage simple onClose=\{\(\) => setDayOpen\(false\)\}/);
  });
});

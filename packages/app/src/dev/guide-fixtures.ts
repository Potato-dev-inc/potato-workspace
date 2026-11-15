// Example Project guide data for the harness (dev only): a finished guide and the video tour card in each of its faces.
import type { GuideVideoRun, GuideVideoState } from '../lib/guide';

export interface GuideScenario {
  /** `ask` (the question), `running`, `done` (video made), `slideshow` (only the slideshow), or `failed`. */
  video: 'ask' | 'running' | 'done' | 'slideshow' | 'failed';
  /** This PC has Node, a browser and ffmpeg. Default true. */
  canVideo?: boolean;
}

const FILES = ['.potato/guide/video/tour.mp4', '.potato/guide/video/tour-vertical.mp4', '.potato/guide/video/tour.html'];

function run(over: Partial<GuideVideoRun>): GuideVideoRun {
  return { phase: 'done', framesDone: 0, framesTotal: 0, beats: 22, seconds: 88, error: null, outcome: null, files: [], notes: [], startedMs: Date.now() - 60_000, finishedMs: Date.now(), ...over };
}

function video(s: GuideScenario): GuideVideoState {
  const canVideo = s.canVideo ?? true;
  const base = { enabled: true, running: false, state: null, files: [] as string[], canVideo };
  switch (s.video) {
    case 'ask':
      return base;
    case 'running':
      return { ...base, running: true, state: run({ phase: 'frames', framesDone: 1180, framesTotal: 2112, finishedMs: null }) };
    case 'done':
      return { ...base, files: FILES, state: run({ outcome: 'video', files: FILES }) };
    case 'slideshow':
      return {
        ...base,
        canVideo: false,
        files: [FILES[2]],
        state: run({ outcome: 'slideshow', files: [FILES[2]], notes: ['No video was made because this PC has no ffmpeg. A captioned slideshow is ready instead.'] }),
      };
    case 'failed':
      return { ...base, state: run({ phase: 'failed', error: 'VIDEO_SPAWN: Could not start Node.' }) };
  }
}

export function guideMock(s: GuideScenario | undefined, cmd: string): { handled: boolean; value?: unknown } {
  if (!s) return { handled: false };
  switch (cmd) {
    case 'guide_state':
      return {
        handled: true,
        value: {
          enabled: true,
          hasGuide: true,
          run: null,
          last: null,
          dryRun: false,
          structure: {
            commit: 'a1b2c3d',
            writtenAtMs: Date.now() - 2 * 86_400_000,
            agent: 'Claude',
            model: null,
            complete: true,
            diagram: true,
            diagramStale: false,
            pages: [
              { id: 'overview', title: 'Overview', purpose: 'What it is', stale: false, needsReview: false },
              { id: 'sync', title: 'Sync', purpose: 'How sync works', stale: false, needsReview: false },
            ],
          },
        },
      };
    case 'guide_read_page':
      return { handled: true, value: { id: 'overview', title: 'Overview', markdown: '# Overview\n\nTide Notes is a small notes app. It keeps every note on your own PC.', stale: false, changed: [], needsReview: false } };
    case 'guide_video_state':
      return { handled: true, value: video(s) };
    case 'guide_video_start':
    case 'guide_video_stop':
    case 'guide_video_show':
      return { handled: true, value: null };
    default:
      return { handled: false };
  }
}

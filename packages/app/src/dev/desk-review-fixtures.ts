// Fixtures for the file-by-file review, Put back and Open in my editor (harness and mock shell only).
import type { TurnReviewData } from '../lib/turn-review';

export const EXAMPLE_TURN_REVIEW: TurnReviewData = {
  turn: 3,
  beforeId: '5',
  afterId: '6',
  truncated: false,
  files: [
    { path: 'src/pages/Settings.tsx', status: 'M', added: 42, deleted: 6, binary: false, blob: 'b1' },
    { path: 'src/App.tsx', status: 'M', added: 3, deleted: 1, binary: false, blob: 'b2' },
    { path: 'src/routes.ts', status: 'M', added: 5, deleted: 0, binary: false, blob: 'b3' },
    { path: 'src/components/NotifyBell.tsx', status: 'A', added: 31, deleted: 0, binary: false, blob: 'b4' },
    { path: 'public/bell.png', status: 'A', added: 0, deleted: 0, binary: true, blob: 'b5' },
    { path: 'src/old/Bell.tsx', status: 'D', added: 0, deleted: 22, binary: false, blob: '' },
  ],
};

export const EXAMPLE_FILE_PATCH = [
  'diff --git a/src/App.tsx b/src/App.tsx',
  '--- a/src/App.tsx',
  '+++ b/src/App.tsx',
  '@@ -10,6 +10,8 @@ export function App() {',
  '   const { user } = useAuth();',
  '-  const title = "Home";',
  '+  const title = t("app.home");',
  '+  const bell = useNotifyBell();',
  '   return (',
  '     <Layout title={title}>',
  '       <Routes />',
  '',
].join('\n');

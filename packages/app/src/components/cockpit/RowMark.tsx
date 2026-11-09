// The one-line status mark of a slim sidebar row: a thin spinner (working), a filled dot with a halo (needs you),
// a grey dot (idle), a ring with a bar (error), a hollow dot (ended). The state is also spoken (role img).
const LABEL: Record<string, string> = { running: 'Working', waiting_input: 'Needs you', idle: 'Idle', error: 'Error' };

export function RowMark({ status, asking = false }: { status: string; asking?: boolean }) {
  const kind = asking ? 'needs' : status === 'running' ? 'working' : status === 'waiting_input' ? 'needs' : status === 'idle' ? 'idle' : status === 'error' ? 'error' : 'ended';
  const label = asking ? 'Needs you' : (LABEL[status] ?? 'Ended');
  return (
    <span className={`ck-mark ck-mark--${kind}`} role="img" aria-label={label}>
      <span className="ck-mark-shape" aria-hidden="true" />
    </span>
  );
}

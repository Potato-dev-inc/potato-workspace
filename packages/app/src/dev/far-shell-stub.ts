// A STUB far shell for the dev harness and the screen tests: a script that answers a few commands, NOT a real pty. It stands in for the far
// PC's `terminal.rs` so the real `TerminalViewport` can be looked at (output, typing, a full-screen program) with no second PC.
const PROMPT = '\x1b[1;32mstub@far-pc\x1b[0m:\x1b[1;34m~/app\x1b[0m$ ';
const UNAME = 'Linux far-pc (STUB: scripted text, not a real shell)';

const bar = (pct: number, color: string): string => `[${color}${'|'.repeat(Math.round(pct / 5))}\x1b[0m${' '.repeat(20 - Math.round(pct / 5))} ${String(pct).padStart(3)}%]`;
const HTOP =
  '\x1b[?1049h\x1b[2J\x1b[H' +
  [
    `  1 ${bar(12, '\x1b[32m')}   Tasks: \x1b[1m41\x1b[0m, \x1b[1m96\x1b[0m thr; 2 running`,
    `  2 ${bar(63, '\x1b[31m')}   Load average: 0.52 0.40 0.31`,
    `  Mem ${bar(34, '\x1b[32m')} 10.2G/30.0G   Uptime: 03:12:44`,
    '',
    '\x1b[30;46m  PID USER      PRI  NI  VIRT   RES   SHR S CPU% MEM%   TIME+  Command            \x1b[0m',
    ' 4121 pm         20   0 2891M  412M  96M S 63.0  1.3  4:12.91 puppet_master_app',
    ' 4188 pm         20   0  812M  120M  44M S 12.0  0.4  0:41.02 node',
    '    1 root       20   0  166M   12M   8M S  0.0  0.0  0:02.11 /sbin/init',
    '\x1b[30;46mF1\x1b[0mHelp \x1b[30;46mF10\x1b[0mQuit   (q quits)',
  ].join('\r\n');

export class StubShell {
  /** Everything the far screen has been sent, for a replay. */
  screen = PROMPT;
  private line = '';
  private full = false;
  constructor(private readonly out: (data: string) => void) {}

  private send(data: string): void {
    this.screen += data;
    this.out(data);
  }

  /** What the person typed (a key at a time or a whole line). */
  type(text: string): void {
    for (const ch of text) {
      if (this.full) {
        if (ch === 'q') {
          this.full = false;
          this.send('\x1b[?1049l' + PROMPT);
        }
      } else if (ch === '\r' || ch === '\n') {
        const cmd = this.line.trim();
        this.line = '';
        if (cmd === 'htop') {
          this.full = true;
          this.send('\r\n' + HTOP);
        } else {
          this.send('\r\n' + (cmd === 'uname -a' ? UNAME + '\r\n' : cmd ? `bash: ${cmd}: command not found\r\n` : '') + PROMPT);
        }
      } else if (ch === '\x7f') {
        if (this.line) {
          this.line = this.line.slice(0, -1);
          this.send('\b \b');
        }
      } else {
        this.line += ch;
        this.send(ch);
      }
    }
  }
}

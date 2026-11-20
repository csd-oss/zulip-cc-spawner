Live panes from Claude Code 2.1.323 in an 80x24 tmux pane (capture-pane -p), 2026-11-14; lines outside the model menu blanked.

permission-countdown-*.txt: live 100x36 tmux panes (capture-pane -p), 2026-11-19.
Claude Code 2.1.323 ran against a loopback-only stub Messages API that supplied
a Bash tool call targeting a nonexistent path in a scratch directory. tick0–2
show 1:59, 1:58 and 1:57 of the same prompt. "different" is a second call with a
different target at 1:57. Scratch directory names and trailing whitespace were
normalized; the wrapped countdown text was left as rendered.

permission-ax-{open,typed}.txt: live 100x36 screen-reader tmux panes, same
loopback Bash scenario. "typed" shows a buffered 2 before manual Enter, after
the banner disappeared. Scratch paths and trailing blank rows were normalized.

permission-untimed-create.txt: reviewer's live 80-column Create-file prompt
from a loopback Write call for a scratch note. No countdown. Scratch path and
trailing blank rows were normalized.

permission-ax-clipped.txt: reviewer's live 42x16 screen-reader pane from the
same loopback Bash scenario. The heading scrolled out of view and the input
instruction spans two rows. The scratch path was normalized.

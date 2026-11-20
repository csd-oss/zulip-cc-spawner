Live tmux panes (capture-pane -p; trailing whitespace and trailing blank rows
trimmed) paired with the
user/assistant lines of the session's transcript JSONL at the same moment,
2026-11-20. Real Claude Code 2.1.306 / 2.1.323 binaries under
--dangerously-skip-permissions against a loopback-only stub Messages API that
supplied the tool call; every command targets a nonexistent path in a scratch
directory. Apart from that trimming the files are as captured, with one
substitution made by the capture script itself: in most cases the scratch
directory's path was replaced by /tmp/scratch, in pane and transcript alike.
The narrow captures (barewrap38, narrow26, wrapped40) and heredoc400-2.1.306
keep the real temporary path, which wraps across rows there.

<case>-<version>.pane-<tag>.txt + <case>-<version>.transcript[-<tag>].jsonl

heredoc6      80x24. cat heredoc of 6 lines + rm. The outer rule above the
              title has scrolled off; tick0-2 are 1:58, 1:57, 1:56 of one prompt.
heredoc400    80x24. 400-line heredoc: the pane starts inside the command box.
narrow26      26x36. Same heredoc; reason, countdown and footer all wrap.
wrapped40     40x30. One 500-character line, word- and hard-wrapped.
barewrap38    38x24. A one-line command wrapped over two rows: no gutter.
tabs          80x24. Tabs, blank line, indentation, double spaces.
lookalike     80x30. The command prints "Do you want to proceed?", " 1. Yes"
              and a dashed row.
parallel      80x24. Two Bash tool_uses in one assistant message. "open": the
              first is asked; "after1": it was approved, its tool_result is in
              the transcript, the second is asked.
subagent      80x30. The prompt comes from a background subagent: other title
              and footer, no countdown, and its tool_use is not in the hand's
              own transcript.
ax            CLAUDE_AX_SCREEN_READER=1 (100x36 on 2.1.323, 80x24 on 2.1.306).
ask-wrapped38 / untimed-wrapped26
              Reviewer's round-3 panes (38x24 AskUserQuestion; 26x36 untimed
              Bash prompt in default permission mode): the footer wraps onto
              the last row. No transcript captured.

Added for round 5 (same binaries and stub, 2026-11-20; default permission mode
with a Bash ask rule unless a countdown is mentioned). Scratch path replaced by
/tmp/scratch except in the narrow captures (longdesc38, subagent38, pair26).

pair          80x24. Two `sleep 3` calls in one assistant message, descriptions
              "First sample" / "Second sample". "first": "1 of 2" is asked.
              "overlap": it was approved at the terminal 0.3 s earlier and is
              still running — no tool_result — while "2 of 2" is asked.
              "second": 4 s later, the first has its result.
pair26        26x36. "first" of the same: the queue position on a narrow title row.
twin          80x24. As pair, but both calls have the description "Same sample":
              only the queue position differs between the two prompts.
amend         80x24. `printf reviewer`. "open": the cursor list. "yes": after
              Tab. "no": after Down, Tab. Footer "Esc to cancel" in both.
amend26       26x36. "yes" of the same: a blank row follows the text field, and
              the label is cut short ("Yes,and tell Claude…").
amend-heredoc6  80x24. The heredoc6 prompt (bypass mode, countdown) after Tab:
              the countdown notice is gone while amending.
subagent13    80x13. A background subagent's prompt: the rule has scrolled off
              and the pane's first row is its title.
subagent38    38x30. The same title set in two columns.
queue4        80x30, bypass mode, countdown. The hand's own Bash call and three
              background subagents' calls with the same command and description
              wait in one queue; "1 of 4" is the hand's own. The footer has no
              hint of the background agents.
nodesc        80x24. A Bash call without a description: "Run shell command".
longdesc      80x24. A 600-character description: wrapped into a gutter.
longdesc38    38x30. The same; the pane starts inside the description (title
              off screen), the command box is whole.

Added for round 6 (same binaries and stub, 2026-11-20). Two kinds of capture:
<case>-<version>.pane-<tag>.txt is capture-pane -p as above;
<case>-<version>.styled-<tag>.txt is capture-pane -e -p — the same screen with
its text attributes as escape sequences — exactly as captured but for the
scratch path. Scratch path replaced by /tmp/scratch except in boxless.

heredoc6      styled-tick0..2: the heredoc6 screen again (same request, so the
              same transcript file), with attributes: its first row, the title,
              is bold.
subagent13    styled-open: likewise for the subagent's title in the first row;
              only the words "Bash command" are bold, not "· from the …".
titlelike     80x30, a background subagent's Bash call whose DESCRIPTION is
              "Bash command". "full": as launched. "title-first": resized to
              13 rows, the first row is its title (bold). "description-first":
              12 rows, the title is off screen and the first row is the
              description (dim, not bold) — the same words.
boxless       26x36, default permission mode, two calls in one turn: "First
              sample / printf first", "Second sample / printf second". "full":
              the first prompt as launched. "first": resized to 26x12 — nothing
              of the command box is on screen. "second": the first was approved
              at the terminal, the second is asked: the same screen to the
              character. "second-full": back at 26x36.
short10       80x24 countdown prompt ("full"), resized to 80x10: tick0, tick1
              (1:57, 1:56) show the end of the reason, the expiry notice and
              the question — no rule, no box.
descfrom      80x24. The description is "Clean up the temporary directory ·
              from the test run"; tick0, tick1 of one countdown prompt.

Added for round 7, from the round-6 review's local MCP replay (default
permission mode, no countdown):

indent        80x24. Two consecutive preview requests, both with the title
              off screen. In "first", record() is outside the if block; in
              "second", it is indented inside it. The 2.1.306 captures were
              byte-identical to these 2.1.323 captures.

Added for round 8, from the round-7 review's steady/26x12-{new,old}
replays. Each pair is the first two plain captures (20 seconds apart):

clipped-notice26  26x12. The pane starts inside the warning: "automatically
                  block this" (2.1.323) or "automatically deny this"
                  (2.1.306). The only visible difference is the clock.

Added for TASK-BYSTH (same binaries and stub, 2026-11-20; bypass mode with a
countdown unless said otherwise). Scratch path replaced by /tmp/scratch.

tall30        A 30-line heredoc + rm, launched at 80x24 and resized while the
              prompt was open; styled captures (capture-pane -e -p) of one
              prompt: "24" — the pane starts inside the command box; "48" —
              its first row is the title (bold), no rule; "60" — the rule that
              opens the dialog is on screen. The TUI redrew the whole prompt
              after each resize.
subtall30     The same heredoc asked by a background subagent ("Bash command ·
              from the general-purpose agent", no countdown), at 80x24 ("24")
              and resized to 80x80 ("80": the frame is drawn from the top
              there; the blank rows under it are trimmed).
reader        CLAUDE_AX_SCREEN_READER=1, 80x24, one prompt: "open" as asked
              (expiry notice "in about 2 minutes"); "typed" after the key 2
              (the notice is gone, the digit stands after the instruction);
              "cleared" after Backspace; "typed12" after the keys 1 2.
amend         "typed": the amend-2.1.x prompt after Tab and the key x — the
              cursor row reads "Yes, x".

Added for TASK-BYSTH round 3 (the reviewer's captures of run-01M7WR6S…, same
binaries and stub, CLAUDE_AX_SCREEN_READER=1; scratch path replaced by
/tmp/scratch, trailing blank rows trimmed). No transcript was captured with
them: the tests give the pending calls as the scenario defined them.

reader-rule   100x40, default permission mode with a Bash ask rule. `printf
              reviewer`, description "Print a word". Between the quoted block
              and the question the TUI prints a row of its own, unquoted:
              "/permissions to update rules".
reader-queue  80x50, bypass mode. The hand's own Bash call (toolu_main1:
              `sleep 20 && rm -rf "$(printf %s /tmp/scratch/sub)"`, "sub rm")
              and a background subagent's with the same command and
              description. "own": the heading carries the place in the queue,
              "Bash command 1 of 4". "subagent": the next one, "Bash command ·
              from the general-purpose agent 2 of 4", no countdown.

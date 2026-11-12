# claude-page-comments

Review comments on a web page, worked off by Claude.

You select an area of a page, write what to change, and Claude takes the comment, does the work and reports
progress back to the same page. Comments live on a kanban board.

> Status: design. This README is the agreed behaviour; the code comes next.

## The comment

- An **add** icon on every page: drag an area, write the comment.
- A **show all** icon: opens the board with every comment.

## Statuses

`draft` → `sent` → `processing` → `done` → `archive`

| Status | Meaning |
| --- | --- |
| draft | written, not sent yet |
| sent | sent to Claude, waiting to be taken |
| processing | Claude took it; it shows a percentage of completion, updated in real time |
| done | finished; moves here by itself |
| archive | filed away by the user |

## The board

All comments are cards on a kanban board, one column per status.

Two controls:

1. **Send**: every draft goes to `sent`. The user names the **batch** first. When Claude takes a comment it
   moves to `processing`.
2. **Archive**: every `done` comment goes to `archive`.

Comments in `processing`, `done` and `archive` are grouped by batch name. A group can be collapsed and expanded.

# TEST: Project-scoped chat behavior (Command Center)

Manual test plan for how the Chat view's Command Center "Projects" panel interacts with agent
chat sessions. Dedup is per **(agent, project)** pair, not per project alone.

## Expected behavior

- No project selected + click an agent → plain chat. No tool access. History only in browser
  `sessionStorage` (lost on tab close), nothing persisted server-side.
- A project selected + click an agent → opens/resumes **that project's own thread with that
  agent**. Tool-enabled (the agent can request to run recon commands, subject to human
  confirmation). Persisted server-side (backed by a real OrchestratorTask), so it survives a page
  reload or browser restart, not just sessionStorage.
- Switching projects and clicking the **same agent** again opens a **different** thread, scoped to
  (agent, new project):
  - If that agent has never been used under the new project before, the thread starts empty.
  - The previous project's thread with that agent is not lost - it's just not what's showing.
- Switching back to a previously-used (agent, project) pair resumes the exact original thread,
  right where it left off.
- This scoping is independent per agent: Project A could have an active thread with Recon Agent
  but no thread yet with Report Writer, etc.

## Steps to verify

1. Open Command Center, select Project A, click Recon Agent. Send a message (e.g. "hello from
   Project A"). Confirm the reply comes back tool-enabled (agent can request commands).
2. Switch the Projects panel selection to Project B. Click Recon Agent again.
   - Expect: a new/empty thread, not Project A's conversation.
3. Send a different message under Project B (e.g. "hello from Project B").
4. Switch back to Project A. Click Recon Agent again.
   - Expect: resumes the original Project A thread, showing "hello from Project A" and its reply -
     not the Project B message.
5. Switch back to Project B, click Recon Agent again.
   - Expect: resumes the Project B thread with "hello from Project B".
6. Reload the browser page entirely.
   - Expect: both project-scoped threads (A and B) are still resumable exactly as before - project
     scoping persists server-side, unlike a no-project plain chat which would be lost.
7. Deselect the project entirely (click the active project card again to toggle it off) and click
   an agent that already has project-scoped threads.
   - Expect: a plain, separate, non-project chat opens (not one of the project threads) - no tool
     access, sessionStorage only.
8. With Project A selected, click a *different* agent (e.g. Report Writer) that has never been
   used under Project A.
   - Expect: empty thread, independent from Recon Agent's Project A thread.

## Known gap (as of this writing)

The Command Center UI gives no on-screen explanation of any of the above - there's no caption
near the Projects panel telling the user that selecting a project changes what happens when they
click an agent. Worth adding a short inline hint (e.g. "Select a project to give agents tool
access and persist this chat") if this continues to cause confusion.
      
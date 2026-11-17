export interface ChangelogEntry {
  version: string
  date: string
  notes: string[]
}

export const DEVELOPER = 'Digital Scape MY'

/** Newest first. Add an entry on every release (see release procedure). */
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.6.2',
    date: '2026-11-17',
    notes: [
      'Ctrl+click on a link in a pane (⌘+click on macOS) now opens it in your browser. It used to open a second Light Code window showing the page, because the links Claude Code prints asked for a new window and nothing sent them to the browser. Plain web addresses in terminal output are clickable now too. Only web and email links are opened; anything else, a file, another app’s link, is ignored, since a terminal shows whatever a program prints. A plain click still just selects text.',
      'Tabs show their full names again, without “…”. When there are more than fit, the strip scrolls and a button at its end says how many are out of sight, open it to jump to any of them. The tab you are on always stays in view.',
      'Saving project shortcuts no longer reports a failure that did not happen. On a new Windows machine, Windows Security’s Controlled folder access often blocks unknown apps from writing to Documents, where $PROFILE lives, and the save showed a raw “operation not permitted”, which looked like missing admin rights and as if nothing had been saved. The shortcuts were saved, and Light Code panes use them regardless. Now the save says it worked, and a separate note explains that other terminals will not see them yet and exactly where to allow Light Code (no admin rights needed). If the shortcuts file itself cannot be written, that is now said plainly instead of the save silently doing nothing.',
      'Import from $PROFILE says what it found. A fresh install has no PowerShell profile at all, and import used to answer “No new entries found”, as if it had looked and failed; it now says there is nothing to import yet. A profile that exists but cannot be read is named, with the reason.',
      'One more guard on `lc send` into Codex and shell panes: a message from an agent that starts with y, n or a is refused unless forced, because Codex answers its permission menu on that key alone, “yeah, go on” was a yes. Starting with any other word works.'
    ]
  },
  {
    version: '0.6.1',
    date: '2026-11-17',
    notes: [
      'A security fix, and the reason for this release. A prompt containing a curly apostrophe, the ’ in “don’t”, which AI-written text is full of, could end the quoting around a fan-out, squad or `lc spawn` prompt early on Windows, because PowerShell treats ‘ and ’ exactly like a straight quote. At best the command broke; at worst the rest of the prompt ran as PowerShell. Every kind of single quote PowerShell recognises is now escaped. Shortcut paths are quoted the same way.',
      'A second, related fix. Windows PowerShell 5.1 hands an argument containing a straight double quote to a program without escaping it, so the program splits it: a prompt reading `a b" --dangerously-skip-permissions "c d` reached Claude as three arguments, the middle one a real flag that turns off every permission prompt. And where the agent was installed through npm it is started by cmd.exe, which ran any & or | in a prompt with no spaces in it, `a&whoami` ran whoami. Prompts, and squad role prompts, which a repository’s roles.json can supply, now reach the agent as exactly one argument that cmd.exe cannot break out of, on every PowerShell version. The only visible difference is that a " inside a prompt arrives as “ or ”, which reads the same to an agent.',
      'An agent can no longer answer a permission prompt it cannot see. In a pane whose state is only estimated (Codex, a plain shell), Light Code cannot tell when a permission menu is up, and a menu acts on the first key it receives. So `lc send` from an agent now refuses, unless given `--force`, anything whose first keystrokes could pick a menu row: a reply like y, n or yes, a message whose first line is one, one that starts with a digit (“1. Run the tests” chooses option 1), a leading or bare Enter, and arrow keys or Esc. Ordinary instructions go through as before, and nothing you type yourself is affected.'
    ]
  },
  {
    version: '0.6.0',
    date: '2026-11-17',
    notes: [
      'The squad grows into an orchestra. One pane is the lead, the panes it directs are its workers, and the app now knows which is which, so it can show you what every worker is doing without you visiting each one. The lead wears a ♪ chip and an outline in its crew’s colour, each worker a matching stripe and an @handle, and focusing any of them draws faint lines from the lead to its workers. Inside the lead pane sits a strip of cards, one per worker: its state, the last line it printed that actually means something, who last sent it what, and whether it has written a report. When a worker is blocked on a permission question the lead’s header says so, and the card has Approve and Deny right there.',
      'There are three ways to start one, and they all end in the same place: the squad button, which now builds an orchestra with the orchestrator as its lead; Conduct from Here, in any pane’s menu; or an agent running `lc spawn` from a pane that belongs to no orchestra, which makes that pane the lead and says so in its reply. Squads saved by an older version are adopted the first time they load. A layout preset no longer strips the roles off panes it rearranges, which it had been quietly doing.',
      'The lead gets the verbs it was missing. Workers have names, so it addresses `@developer` rather than a pane id. `lc ask` sends, waits for the turn to end, and prints the answer, read from the agent’s own transcript, not scraped off a screen that shows an interface rather than a reply. `lc events` is a stream of what happened in the crew, so an orchestrator can wait for news instead of polling every pane in turn. `lc spawn` opens a worker beside the lead without taking your keyboard, with an agent, a role and a worktree if asked, and stops at twelve workers and three in ten seconds, because a loop that spawns is a loop that can spawn forever.',
      'Every one of those is warn, never block. A lead reaching outside its crew, a worker driving its own lead, a message sent to a pane mid-turn: all allowed, all answered with a warning, and the driven pane’s LC badge turns amber so the fact is visible afterwards. A crew can opt into Strict, which turns the warnings into refusals. Two things are refused by default, because they protect you from an agent rather than limiting you. Typing into a pane that is showing a permission prompt would answer the prompt, so `lc send` refuses it unless told `--force`. And `lc approve` does nothing at all until you tick Lead may approve for that crew, a permission question is yours unless you hand it over. Along the way, `lc` learned who is calling: each pane gets a token, so a request cannot simply claim to come from the lead.',
      'An Orchestra panel, on Ctrl/Cmd+Shift+O, lists every orchestra in the window: its workers as the same cards, its three switches, the reports its roles have written, marked the moment a new one lands, and a timeline of the last things that happened. Ctrl/Cmd+Shift+Y approves whichever worker in the focused orchestra is asking, after checking with you the first time.',
      'Workers no longer have to be Claude. Codex is supported, and so is a plain shell. Codex reports nothing about what it is doing, so its state is estimated from the terminal going quiet, and an estimate is always marked as one, ≈ in the app, ~ in `lc ls`, and nothing automatic ever acts on it: the babysitter leaves it alone and there is no Approve button for a guess. A Gemini adapter is included as well, written from its documentation; it has not been run against the real thing, and the picker says so rather than pretending otherwise. An agent the app cannot find on your PATH is dimmed in every picker but can still be chosen, because the shell in your pane often knows better than the app does.',
      'None of it shows up until you use it. A plain pane running `claude` gets no new chips, no strip and no new `lc ls` columns, and a state file from a window with no orchestra is byte for byte what it was.',
      'Background tabs stop slowing everything down. A terminal in a tab you are not looking at was still repainting itself on every line it printed, a quirk in the terminal library, which skipped its own “nobody can see this” check on that one path, and worse, re-measured every character from scratch because a hidden tab has no width to measure. A dozen busy tabs could stall typing and clicking for a sixth of a second at a time. Hidden terminals now keep their output and draw it once, when you come back to them. Measured on twelve tabs streaming logs: the longest stall went from 157ms to 4ms, and the window uses about a third less memory.',
      'Lots of tabs no longer pile on top of each other. Tabs shrink to a sensible minimum and then the strip scrolls: the mouse wheel scrolls it, the active tab always scrolls into view, and when the strip overflows a ▾ button lists every tab so you can jump to one directly. Dragging a tab to either edge scrolls the strip under it, so a tab can travel from one end to the other in one drag.',
      'Project shortcuts now work on a freshly installed Windows. Windows ships with PowerShell scripts disabled, which stops $PROFILE, where the shortcuts are written, from loading at all, so saving one appeared to do nothing. Light Code panes now define your shortcuts themselves, whatever that setting says, and saving tells you when other terminals will not see them and the one command that fixes it. Light Code does not change the setting for you. Shortcuts can also be grouped into categories under one main projects folder, and folders that do not exist yet are created when you save.'
    ]
  },
  {
    version: '0.5.0',
    date: '2026-09-06',
    notes: [
      'Four panes on one folder, all running unattended, will quietly overwrite each other. Worktrees have always been the answer to that, but nothing connected the two, and auto mode is precisely when nobody is watching. A pane now says so: when it shares a working tree with another pane and at least one of them is on auto, an amber chip appears in both headers naming the fix. It warns and nothing more, no dialog, no refusal. Working several panes in one folder by hand is a perfectly good way to work, often the right one, and a tool that argues with you about it has decided it knows your job better than you do. Click the chip and it is gone for the life of that pane.',
      'A git tree panel, on Ctrl/Cmd+Shift+G, docked beside the panes rather than over them. Every branch in the repository, how far each has moved from main, which ones have uncommitted work, and, the column that makes it worth having, which terminal is sitting in each one. That is what turns "four branches" into "these four panes". It is a read view: still no diff viewer, because that is an editor’s job and this is a terminal.',
      'It does add one button. A branch that is ahead of main offers Integrate, which types `git merge --no-ff` into the pane that is on main and then leaves it alone. The app does not run the merge itself, and that is deliberate rather than a limitation: the command, the output, the conflict and the resolution were always git’s, and what was actually missing was remembering which branch, in which pane, in which order. So the app supplies that part and your terminal supplies the rest, which also means you can watch it, interrupt it, and find it in your shell history afterwards. It refuses rather than guesses when the pane has uncommitted work, is not on main, or already has a half-finished merge sitting in it.',
      'And the larger thing: a squad. One orchestrator terminal directing a developer, a UI/UX reviewer, a devops engineer and a security reviewer, each in its own pane, each told what its job is. The orchestrator edits nothing, it delegates through `lc`, waits for each agent to finish its turn, and reads what came back.',
      'The design decision worth knowing is which roles get a branch. Fan-out is several agents competing on one task, so a branch each is exactly right. A squad is roles collaborating on one task, and giving all five their own branch would produce five diverging branches nobody asked for. So only the roles that write code, the developer and the devops engineer, get a worktree of their own. The reviewers read the code and write their findings as files, which means they cannot conflict with anything.',
      'Results come back as files rather than as terminal output, and that is not a detail. Reading a pane’s screen gives you a Claude session’s interface, not its answer, so an orchestrator that scrapes screens is unreliable by construction. Every role writes its result into a shared squad folder beside the repository, and the orchestrator reads that. A role’s brief also travels in its pane’s environment rather than on the command line, so it survives the agent restarting `claude`, clearing its context, or resuming a session, a pane that still wore its role badge while having forgotten the job would be the worst of both.',
      'The five roles are built in, and a repository can replace them with a `.lightcode/roles.json` of its own. A Rails app and an embedded firmware tree do not want the same five terminals, and putting the definition in the repository means it is versioned, reviewed, and shared with everyone who clones it. A file that cannot be used is reported rather than ignored, because a squad silently missing the role you wrote is worse than one that tells you your file was skipped.',
      'Running two Light Code windows at once has been quietly breaking both of them, and this is the fix. Every running copy shared one folder for the events Claude Code reports, with no way to tell whose was whose: a second window starting would delete the first one’s pending events, and whichever window checked first would consume events belonging to the other. Both losses were completely silent, and both mattered, the red "needs approval" dot exists only because of those events, so it went dark, and a lost end-of-turn event stalls an autonomous run for good. Each window now has its own folder, and clears up only after copies that are genuinely gone.',
      'Two smaller things in the same family. Only one window now saves the layout, and Mission Control says plainly when this is not the one, previously the last window you closed silently overwrote every other window’s tabs. And the generated files the app shares between windows are written in a way that cannot be caught half-finished, which is what used to risk handing a pane a truncated `lc` command or a truncated settings file at exactly the wrong moment.'
    ]
  },
  {
    version: '0.4.4',
    date: '2026-08-09',
    notes: [
      'A pane now tells you when Claude is stuck waiting for your permission. Until now it could not, and the reason is worth explaining: a permission prompt and a ten-minute build look identical in Claude Code\'s own transcript, a tool starts, and then nothing. Guessing from that silence got it wrong about a fifth of the time, so the app never guessed, and the one state where nothing at all happens until you look was the one state it could not show you. It now comes from Claude Code itself, which is asked to report the moment a prompt appears. The pane turns red, the tab turns red so you can see it without opening the pane, and your desktop says so if you are working somewhere else. Nothing is written to your Claude Code settings to make this work, Light Code passes its own settings file alongside yours, only inside its own panes, so a plain terminal is untouched and there is nothing to uninstall.',
      'Ctrl/Cmd+Shift+J takes you to the pane that needs you. The panes blocked on a permission question come first, then the ones that finished and are waiting for your next instruction, and pressing it again moves to the next, switching tabs on the way if it has to. In a grid of sixteen that is the difference between working through a queue and hunting for a coloured dot.',
      'Each pane can now open a worktree: a second checkout of the same repository, on its own branch, in its own folder, opened in a pane beside the first. They gather in one `<project>-worktrees` folder next to the repository rather than inside it, inside, a test runner would find every suite twice over and an agent told to work on the project would find every file twice over, which is the exact thing worktrees exist to prevent. This matters more than it sounds. Six panes on one project have always shared one set of files, so two Claudes working at once would quietly overwrite each other, a footgun that was never signposted. Now each can have its own copy. Every pane header shows the branch it is on and a dot when there are uncommitted changes, refreshed the instant a command finishes rather than on a timer. There is no diff viewer and no merge button: you have git, it is better at both, and it is already what you know.',
      'And a new button in the tab bar fans one task out to several agents at once. Give it a name, a number, and a prompt, and Light Code makes that many worktrees, opens them as a grid, and starts an agent in each with the prompt already sent. Come back to three independent attempts at the same problem, on three branches that cannot have overwritten one another, and keep whichever you like. There is a Plan first option, which is often the better way to use it: agents that propose an approach instead of rewriting the code are cheaper, faster, touch no files at all, and are far easier to read side by side.',
      'Closing a pane or a tab that is using a worktree now asks whether the worktree should go too, with keeping it as a plain choice rather than something you have to know about. Branches holding commits are always kept and named back to you; empty ones are cleaned up, because a branch with nothing in it is not work being protected, it is a name you can never reuse. This was learned the hard way: an evening of testing left twenty-two folders and twenty-seven branches behind, every one created by a button that said nothing about what it would leave.',
      'Everything above is a button you press. `lc` is the same set of actions handed to the agents themselves, so you can ask Claude to *"fan this out three ways, wait for all of them, and tell me when they are done"* and it simply does it, opening panes, sending work to them, waiting for each to finish its turn, and reading back what came out, without your hands. It is one command available inside every pane, and an agent is told it exists in a single sentence pointing at `lc --help`, so you never have to explain it. Nothing needs installing: it runs under the app\'s own runtime.',
      'That is a real amount of power to hand to a program, so: **`lc` is off until you switch it on**, in Mission Control, and while it is off nothing is listening at all, there is no socket to refuse a connection, because there is no socket. Any pane something drove through `lc` then wears an `LC` badge for the rest of its life, so you can always see that it happened. It is worth being straight about why the safety story is that and not more. Owner-only permissions on the socket keep other people on the machine out; they cannot keep out other programs running as you, and they never could, because letting a program running as you type into a pane is precisely the feature being asked for. So the protection is not prevention. It is that nothing listens until you say so, and that nothing it does is invisible afterwards.',
      'Two older faults surfaced while building the above, both of which had been quietly wrong for a while. A pane\'s token badge could be hijacked by a Claude session running in a completely different terminal, if that session happened to be in the same folder, so a pane holding a small conversation would suddenly display someone else\'s enormous one. And a turn where you rejected every action Claude proposed left the pane reading "working" for ever, because a rejection looks exactly like a turn starting. Both are fixed, and both were only findable once there was something honest to compare against.'
    ]
  },
  {
    version: '0.4.3',
    date: '2026-08-04',
    notes: [
      'Switching to a layout with fewer panes no longer takes the cursor with it. The app would stall for a moment and then leave the terminal with no cursor at all, you could still type and the characters still arrived, but the blinking bar showing where you were had gone, and it stayed gone until you clicked into a pane. The culprit was the question asking whether to close the extra panes. It was a window belonging to the operating system rather than to Light Code, and one of those stops the whole app dead for as long as it is on screen: nothing draws, no cursor blinks, and every pane sits there looking hung. Handing the window back afterwards then left the terminal convinced it was still in the background, which is precisely what hides a cursor. That question is now asked inside the app, so nothing stops and nothing has to be handed back.',
      'And after any layout change the cursor returns to the pane you were working in, instead of jumping to whichever one happens to be first. Rearranging your panes should not also move you somewhere else.'
    ]
  },
  {
    version: '0.4.2',
    date: '2026-08-03',
    notes: [
      'Copying out of a terminal works. Select some text, press Ctrl+C, paste it anywhere else and nothing arrived, what came back was whatever had been on the clipboard beforehand. A terminal draws its own selection rather than handing it to the system, so the copy had nowhere to go, and neither platform said a word about it. On Windows it was worse than useless: the same key still interrupted whatever Claude was doing. Ctrl+C now copies when text is selected and interrupts when none is, and the selection clears the moment it is copied, so the next press interrupts exactly as it always did. Ctrl+Shift+C copies either way, for anyone who would rather not think about which one they are about to get.',
      'Light Code keeps looking for updates while it runs, every few hours, rather than once at startup and never again. A window left open for days would otherwise never hear about a release published after it opened, and the only way to find out was to quit the app, which nobody does in the hope of being told there is an update.',
      'And when one arrives while you are working somewhere else, your desktop now says so, once per version rather than at every check. Clicking the notification brings Light Code forward with the details already waiting; if the window is in front of you the notification stays quiet, because the message is already on screen. Windows gets more than that back: notifications from this app were being dropped by Windows without a word, so the alert for Claude finishing a turn or waiting on a permission has been going nowhere either. Both arrive now.'
    ]
  },
  {
    version: '0.4.1',
    date: '2026-08-01',
    notes: [
      'The update notification now tells you what the update actually contains, instead of a version number and nothing else. Until now it could not: an app only carries the release notes of its own version, written before the newer one existed, so the notes travel with the update itself from here on.',
      'It also stops being so easy to ignore. "Later" now means half an hour rather than forever, the old button hid the notification until the next launch, which on a window left open for days meant never. The app itself is untouched while it waits; nothing is blocked and nothing installs behind your back.',
      'Updating while Claude is mid-turn now asks first, and says how many panes it is about to end. On Windows the installer closes the app the moment the download finishes, so a click meant to be harmless could take a long autonomous run down with it.'
    ]
  },
  {
    version: '0.4.0',
    date: '2026-08-01',
    notes: [
      'Drag a file or folder out of Finder or Explorer and drop it on a pane, its full path is typed at the prompt, the way every native terminal has always worked. Type `cd `, drop the folder, press Enter; or drop a file into a Claude Code prompt and Claude can read it straight away. Drop several at once and they arrive as separate arguments, the pane under the pointer lights up so there is never any doubt about where the path is going, and a path is only quoted when the shell actually needs it, a plain path stays plain, exactly as you would have typed it. Dropping a file anywhere else in the window now does nothing at all, instead of the browser default of navigating the app away and taking every running session with it.',
      'Updating on macOS goes straight to the installer your Mac can actually run, instead of a release page listing two near-identical downloads to choose between. Apple Silicon and Intel are told apart automatically, and a Mac running the Intel build under Rosetta is offered the native Apple Silicon one.'
    ]
  },
  {
    version: '0.3.1',
    date: '2026-08-01',
    notes: [
      'Nothing has changed inside the app. This release exists to rename the installer files: the Mac downloads are now LightCode-arm64.dmg and LightCode-x64.dmg, and the Windows one is LightCode-Setup.exe, none of them carrying a version number any more. A download link can therefore keep pointing at the newest build instead of breaking every time a version ships. Updating is unaffected, the app still picks the right build for your Mac on its own.',
      'The installation instructions were rewritten for people who do not write software: how to tell an Apple Silicon Mac from an Intel one and why picking wrong matters, and how to get past the macOS and Windows warnings that appear because these builds carry no developer signature.'
    ]
  },
  {
    version: '0.3.0',
    date: '2026-08-01',
    notes: [
      'Layout picker: a new grid button in the tab bar opens a visual menu of pane arrangements, 2 columns, 2×2, 3×2, 4×4 and more, up to 16 panes. Pick a shape instead of splitting one pane at a time. Switching layouts rearranges the panes you already have rather than restarting them, so every running Claude session survives the change; picking a smaller layout closes the extra panes and asks first.',
      'Open several tabs at once: right-click the "+" button to add 3, 8 or 16 tabs in one go instead of clicking it repeatedly.',
      'Adjustable terminal text size with Ctrl/Cmd +, - and 0, useful once a layout gets dense enough that the default 14px stops fitting. It applies to every pane, new panes open at the size you picked, and the choice survives a restart.',
      'Keyboard navigation between panes, so a dense layout no longer needs the mouse. Ctrl+Tab and Ctrl+Shift+Tab cycle through the panes in the current tab, and Ctrl/Cmd+Alt with the arrow keys jumps to the pane lying that way on screen, in a 4×4 grid that is two keystrokes instead of ten. Ctrl+Tab is Ctrl on both Windows and macOS. Plain Tab and plain arrows are untouched, so shell completion and command history keep working exactly as before.',
      'App shortcuts no longer fire while you are typing in a tab or pane rename box, which used to trigger the shortcut and then silently commit the half-typed name.',
      'Fixed on macOS: several tooltips named Ctrl when the actual shortcut is Cmd. Fixed on Windows: Ctrl+Shift+minus is Ctrl+underscore, which is undo in zsh and bash, the font-size shortcut was swallowing it, and now leaves it to the shell.',
      'macOS installers are back, for both Apple Silicon and Intel Macs. Releases had been Windows-only since 0.1.2, and the last macOS build before that was Apple Silicon only. macOS 12 Monterey or newer is required.'
    ]
  },
  {
    version: '0.2.1',
    date: '2026-07-17',
    notes: [
      'Fixed tabs getting stuck or disappearing when dragged, most often when flicking a tab from the far right while the machine was under load. A drag that lost its pointer left the tab stranded off-screen for good; drags now always clean up after themselves, and reordering no longer thrashes the layout.',
      'The status indicator now follows the conversation instead of guessing from silence. It stays green for as long as Claude is actually working, including long builds and test runs, and turns amber the moment a turn ends, in a fraction of a second rather than several.',
      'Removed the red "needs approval" indicator: a permission prompt and a slow tool look identical in the session transcript, so it was frequently wrong. It will return when there is a signal worth trusting.',
      'The status dot and token badge now clear when a session ends, instead of staying lit forever.',
      'The token badge now shows context fill, the number that actually runs out. The old headline was mostly cache reads re-counted every turn, which climbed into the millions and measured nothing; the full breakdown moved to the tooltip.',
      'Token counts keep up in real time. A timestamp-precision bug was hiding most updates until something else happened to trigger a re-read.'
    ]
  },
  {
    version: '0.2.0',
    date: '2026-07-08',
    notes: [
      'Mission Control (Ctrl+Shift+M): one panel showing every running Claude session, live status (working / waiting for you / needs approval), model, context fill, tokens, last tool and idle time. Click a row to jump straight to that pane.',
      'Per-pane and per-tab status indicators, plus desktop notifications when Claude finishes a turn or gets blocked on a permission prompt.',
      'Broadcast input: tick target panes in Mission Control and send one command to all of them at once.',
      'Auto-continue babysitter: opt in per pane to keep long autonomous runs going, it nudges Claude when a turn ends, never auto-approves permission prompts, and stands down after a few nudges.'
    ]
  },
  {
    version: '0.1.2',
    date: '2026-07-07',
    notes: [
      'About dialog now shows only the current release notes, with a cleaner minimalist scrollbar.',
      'Faster releases: automated builds are Windows-only for now.',
      'Auto-update verification release.'
    ]
  },
  {
    version: '0.1.1',
    date: '2026-07-07',
    notes: [
      'Renamed the app to Light Code.',
      'Auto-update pipeline reliability fixes: releases are published via GitHub CLI and installer artifacts use space-free names so update downloads always resolve.',
      'First self-updating release, from here on the app updates itself.'
    ]
  },
  {
    version: '0.1.0',
    date: '2026-07-07',
    notes: [
      'Initial release.',
      'Multi-tab terminal manager with split panes (right/down), drag-reorder tabs, resizable gutters and pane maximize.',
      'Real-time Claude Code token usage badge per pane, session tokens plus context-window fill, attributed to the pane that launched the session.',
      'Multi-account Claude support: usage tracking follows every configured CLAUDE_CONFIG_DIR.',
      'Shortcuts Manager: project and account shortcuts managed in-app and written to your shell profile (PowerShell / zsh / bash), with auto-import of existing entries.',
      'Live working-directory tracking via shell integration; panes reopen in their last folder after restart.',
      'Paste screenshots directly into the terminal (Ctrl/Cmd+V), images are saved to a temp file and pasted as a path Claude Code can read.',
      'Rename tabs (double-click) and panes (⋮ menu); names persist across restarts.',
      'GPU-accelerated rendering (WebGL) and automatic update checks.'
    ]
  }
]

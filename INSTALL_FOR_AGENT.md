# Install opencode-keep-awake (instructions for a coding agent)

You are a coding agent installing this utility on a human's Mac. This file is self-contained; you do not need the rest of the repository except for the files it tells you to download.

Repository: https://github.com/loburets/opencode-keep-awake
Raw base URL used below: `https://raw.githubusercontent.com/loburets/opencode-keep-awake/main`

## What you are installing

- **Level 1 (always):** an opencode plugin that runs `caffeinate -i -m -w <opencode server pid>` while any opencode session is working. No privileges.
- **Menu bar script (recommended):** a SwiftBar script that shows the current state.
- **Level 2 (optional, needs the human's explicit consent):** a sudoers rule that lets the plugin run `pmset disablesleep 1/0` without a password, so the Mac stays awake with the lid closed and no external display.

## Rules you must follow

1. **Never restart, stop or signal the human's running opencode server.** It may be hosting the very session you are running in. To verify the plugin, use the test harness in step 6. Ask the human to restart opencode themselves at the end.
2. **Never install the Level 2 sudoers rule without asking.** It grants passwordless root for two commands. Show the human the exact rule, explain it, and wait for a clear yes. If they say no or do not answer, skip Level 2. Level 1 works on its own.
3. **Never kill a `caffeinate` process you did not start.** A running `/usr/bin/caffeinate -i -m -w <pid>` belongs to a live plugin.
4. **Every step is idempotent.** Run the check first; if it already passes, skip the step. Do not duplicate files or rules.
5. After every step, run its verification and compare against the expected result. If it does not match, stop and report to the human. Do not improvise.

Use a scratch directory for downloads:

```sh
KA_TMP="$(mktemp -d)"; echo "$KA_TMP"
```

Verify: `test -d "$KA_TMP" && echo ok` prints `ok`. If your shell does not keep variables between commands, write down the printed path and put `KA_TMP=<that path>` (and `SB_DIR`, `CUR` where used) at the start of each later command.

## Step 1. Preconditions

```sh
uname -s
opencode --version
node --version 2>/dev/null || echo "no node"
```

Expected:

- `uname -s` prints `Darwin`. Otherwise stop: this utility is macOS only.
- `opencode --version` prints a `1.x` version. The plugin targets the published 1.x plugin API and was tested on 1.19.0. If it prints `2.x` or later, stop and tell the human the plugin was written for 1.x and may not work.
- Node is only needed for step 6 (the test harness), and must be 22.18 or newer. If it is missing or older, look for a newer one (for example under `~/.nvm/versions/node/`). If there is none, step 6 is skipped and you must say so in your report.

## Step 2. Install the plugin (Level 1)

```sh
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://raw.githubusercontent.com/loburets/opencode-keep-awake/main/plugin/keep-awake.ts -o "$KA_TMP/keep-awake.ts"
DEST=~/.config/opencode/plugins/keep-awake.ts
if [ -f "$DEST" ] && cmp -s "$KA_TMP/keep-awake.ts" "$DEST"; then
  echo "already installed"
elif [ -f "$DEST" ]; then
  echo "DIFFERENT FILE EXISTS"; diff "$DEST" "$KA_TMP/keep-awake.ts"
else
  cp "$KA_TMP/keep-awake.ts" "$DEST" && echo "installed"
fi
```

If it prints `DIFFERENT FILE EXISTS`, show the diff to the human and ask before overwriting with `cp "$KA_TMP/keep-awake.ts" "$DEST"`.

Verify:

```sh
cmp "$KA_TMP/keep-awake.ts" ~/.config/opencode/plugins/keep-awake.ts && echo same
grep -c 'export const KeepAwake' ~/.config/opencode/plugins/keep-awake.ts
```

Expected: `same`, then `1`.

The plugin is loaded the next time opencode starts. Do not restart it (rule 1).

## Step 3. Install the menu bar script (recommended)

Check for SwiftBar:

```sh
test -d /Applications/SwiftBar.app && echo present || echo missing
defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null || echo "no plugin folder set"
```

- If SwiftBar is missing, ask the human whether to install it (`brew install --cask swiftbar`). If they decline, skip this step and say so.
- If no plugin folder is set, ask the human to open SwiftBar once and choose a plugin folder, then run the check again.

Then:

```sh
SB_DIR="$(defaults read com.ameba.SwiftBar PluginDirectory)"
curl -fsSL https://raw.githubusercontent.com/loburets/opencode-keep-awake/main/swiftbar/keepawake.10s.sh -o "$KA_TMP/keepawake.10s.sh"
DEST="$SB_DIR/keepawake.10s.sh"
if [ -f "$DEST" ] && cmp -s "$KA_TMP/keepawake.10s.sh" "$DEST"; then
  echo "already installed"
elif [ -f "$DEST" ]; then
  echo "DIFFERENT FILE EXISTS"; diff "$DEST" "$KA_TMP/keepawake.10s.sh"
else
  cp "$KA_TMP/keepawake.10s.sh" "$DEST" && echo "installed"
fi
chmod +x "$DEST"
```

If it prints `DIFFERENT FILE EXISTS`, show the diff to the human and ask before overwriting with `cp "$KA_TMP/keepawake.10s.sh" "$DEST"`, as in step 2.

Verify:

```sh
test -x "$SB_DIR/keepawake.10s.sh" && echo executable
"$SB_DIR/keepawake.10s.sh" | head -1
```

Expected: `executable`, then one of these first lines:

- `○ | color=#8e8e93`: nothing is keeping the Mac awake
- `● | color=#30b0c7`: idle sleep is blocked
- `● | color=#ff9500`: the closed lid is held too

The dot in the menu bar should appear within about 10 seconds. It can be blue while opencode is idle if some other program on the Mac runs `caffeinate`; the script reports every `caffeinate`, not only this plugin's.

## Step 4. Level 2: ask the human

First check whether the permission already exists. This writes the value that is already set, so nothing changes. `-k` ignores a cached sudo login and `-n` refuses to prompt, so only a NOPASSWD rule passes. Do not use `sudo -l` for this check: on an admin account it approves any command, rule or not.

```sh
CUR="$(pmset -g | awk '/SleepDisabled/ {print $2}')"
sudo -n -k /usr/bin/pmset disablesleep "${CUR:-0}" 2>/dev/null && echo "already allowed" || echo "not allowed"
```

If it prints `already allowed`, skip to step 6.

Otherwise ask the human, in these words or close to them, and show the rule exactly:

> Optional: should the Mac stay awake with the lid **closed** and **no external display** while opencode works? That needs this line in `/etc/sudoers.d/opencode-keepawake`:
>
> `<your username> ALL=(root) NOPASSWD: /usr/bin/pmset disablesleep 1, /usr/bin/pmset disablesleep 0`
>
> It lets your user run exactly those two commands as root without a password, and nothing else. sudoers matches arguments literally, so it cannot be widened by appending flags. `pmset disablesleep` is undocumented by Apple. The setting survives a reboot and does not clear itself if opencode crashes. The plugin clears it the next time it starts, or you can run `sudo pmset disablesleep 0`. Never run a closed laptop inside a bag. Without this, everything still works except a closed lid without an external display.

Continue only on an explicit yes.

## Step 5. Level 2: install the rule (only after a yes)

```sh
curl -fsSL https://raw.githubusercontent.com/loburets/opencode-keep-awake/main/sudoers/opencode-keepawake.template -o "$KA_TMP/opencode-keepawake.template"
sed "s/__USERNAME__/$(id -un)/" "$KA_TMP/opencode-keepawake.template" > "$KA_TMP/opencode-keepawake"
cat "$KA_TMP/opencode-keepawake"
/usr/sbin/visudo -cf "$KA_TMP/opencode-keepawake"
```

Expected: the rule with the real username in place of `__USERNAME__`, then `...: parsed OK`. If `visudo` reports an error, stop. A broken sudoers file can lock the human out of sudo.

Installing needs the human's password. You probably cannot type it, so ask the human to run this themselves. In Claude Code they can prefix it with `!`:

```sh
sudo install -m 0440 -o root -g wheel "$KA_TMP/opencode-keepawake" /etc/sudoers.d/opencode-keepawake
```

Give them the actual expanded path, not the variable.

Verify:

```sh
ls -l /etc/sudoers.d/opencode-keepawake
CUR="$(pmset -g | awk '/SleepDisabled/ {print $2}')"
sudo -n -k /usr/bin/pmset disablesleep "${CUR:-0}" 2>/dev/null && echo "already allowed" || echo "not allowed"
sudo -n -k /usr/bin/pmset -a disablesleep "${CUR:-0}" 2>/dev/null && echo "WIDER THAN EXPECTED" || echo "literal only"
```

Expected: `-r--r-----  1 root  wheel  ...  /etc/sudoers.d/opencode-keepawake`, then `already allowed`, then `literal only`. The last line shows that the same command with an extra flag still needs a password.

## Step 6. Verify the plugin with the test harness

The harness loads the plugin with a fake opencode client and checks real `pmset` output. It needs Node 22.18 or newer and the Level 2 rule. If either is missing, skip this step and say so in your report. Do not install Level 2 just to run tests.

It changes the real `SleepDisabled` setting while it runs and restores the original value when it ends.

```sh
git clone --depth 1 https://github.com/loburets/opencode-keep-awake "$KA_TMP/repo"
cmp "$KA_TMP/repo/plugin/keep-awake.ts" ~/.config/opencode/plugins/keep-awake.ts && echo "testing the installed file"
pmset -g | grep SleepDisabled
node "$KA_TMP/repo/test/drive.mts"; echo "exit=$?"
pmset -g | grep SleepDisabled
```

Expected:

- `testing the installed file`
- every result line starts with `ok`, the run ends with `all checks passed` and `exit=0`
- the `SleepDisabled` value after the run is the same as before it

If it exits with `exit=2` and the message `Another keep-awake guard is running`, a live opencode server with this plugin is busy right now. Do not kill that guard (rule 3). Wait until the human's sessions finish and run it again, or report it as not run.

Any `FAIL` line: stop and report the full output.

## Step 7. Hand over to the human

Tell the human:

- what you installed and which steps you skipped, with the reason for each
- that they should restart opencode themselves when no session is running, since the plugin loads on the next start
- how to check the state (below) and how to undo everything (rollback)

## Final state check

The human, or you after they restart opencode, can run:

```sh
pmset -g | grep SleepDisabled
pmset -g assertions | grep caffeinate
```

**While a session is working:**

```
 SleepDisabled		1
   pid 12345(caffeinate): [0x...] 00:00:30 PreventUserIdleSystemSleep named: "caffeinate command-line tool"
	Details: caffeinate asserting on behalf of Process ID 6789
   pid 12345(caffeinate): [0x...] 00:00:30 PreventDiskIdle named: "caffeinate command-line tool"
	Details: caffeinate asserting on behalf of Process ID 6789
```

`Process ID 6789` is the opencode server. `SleepDisabled` reads `1` only with Level 2 installed and the Mac on power or above the battery floor (20% by default). Otherwise it reads `0` and only the `caffeinate` lines appear.

**When no session is working:**

```
 SleepDisabled		0
```

The second command prints nothing from this plugin. Lines from other `caffeinate` uses, for example `caffeinate asserting for 300 secs`, are not ours.

If `SleepDisabled` is `1` while nothing is working, it is a leftover. Clear it with `sudo pmset disablesleep 0`.

## Rollback

Undo any of the steps above:

```sh
# Step 2: plugin (takes effect on the next opencode start)
rm -f ~/.config/opencode/plugins/keep-awake.ts

# Step 3: menu bar script
rm -f "$(defaults read com.ameba.SwiftBar PluginDirectory)/keepawake.10s.sh"

# Step 5: sudoers rule. Clear the flag first while the rule still allows it.
sudo -n /usr/bin/pmset disablesleep 0
sudo rm -f /etc/sudoers.d/opencode-keepawake

# Scratch files
rm -rf "$KA_TMP"
```

Verify:

```sh
test -e ~/.config/opencode/plugins/keep-awake.ts && echo "plugin still there" || echo "plugin removed"
test -e /etc/sudoers.d/opencode-keepawake && echo "rule still there" || echo "rule removed"
pmset -g | grep SleepDisabled
```

Expected: `plugin removed`, `rule removed`, `SleepDisabled 0`. A guard that is already running keeps running until that opencode server exits, and then releases itself.

Note: the step 4 check can still print `already allowed` after the rollback if another sudoers file on the machine grants the same commands. That is not from this installer, so leave it alone.

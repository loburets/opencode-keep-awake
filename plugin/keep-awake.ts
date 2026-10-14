// Keeps the Mac awake while any opencode session works, then lets it sleep.
// The menu bar icon for this state is swiftbar/keepawake.10s.sh in this repository.
// The closed-lid part needs the rule in /etc/sudoers.d/opencode-keepawake.
import type { PluginInput } from "@opencode-ai/plugin"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

// A closed laptop on its own battery must not run itself flat.
const BATTERY_FLOOR = Number(process.env.OPENCODE_KEEPAWAKE_BATTERY_FLOOR ?? 20)

// Events already react at once. This is only the net for a lost event.
const POLL_MS = Number(process.env.OPENCODE_KEEPAWAKE_POLL_MS ?? 15_000)

// Event payloads are read structurally: the installed @opencode-ai/sdk types lag
// the running binary.
type OcEvent = { type: string }

type Log = (message: string, extra: Record<string, unknown>) => Promise<void>

// ---------------------------------------------------------------------------
// Activity source: answers "is anyone working right now?" and nothing else.
// A second tool would add a second source here; the holds below stay as they are.
//
// Safety rule: a source that cannot be read answers "nobody is working". The
// worst outcome of a format change must be that the feature quietly stops
// working, never a laptop that refuses to sleep in a bag.
// ---------------------------------------------------------------------------

type ActivitySource = { isWorking: () => Promise<boolean> }

const opencodeSource = (client: PluginInput["client"], log: Log): ActivitySource => ({
  // The server drops a session from this map once it goes idle. So a non-empty
  // map means someone is still working, background subagents included.
  isWorking: async () => {
    try {
      const sessions = (await client.session.status()).data
      return sessions !== undefined && Object.keys(sessions).length > 0
    } catch (error) {
      await log("session status unreadable, releasing", { error: String(error) })
      return false
    }
  },
})

// ---------------------------------------------------------------------------
// Holds: the two power controls. They know nothing about where activity comes from.
// ---------------------------------------------------------------------------

const createHolds = (log: Log) => {
  let idleGuard: ChildProcess | undefined

  let lidControlLost = false

  // On the charger there is nothing to drain. An unreadable report counts as
  // unsafe, because sleeping early is better than a dead battery in a bag.
  const powerAllowsClosedLid = async () => {
    const { stdout } = await run("/usr/bin/pmset", ["-g", "batt"])
    if (stdout.includes("AC Power")) return true
    const percent = Number(/(\d+)%/.exec(stdout)?.[1])
    return Number.isFinite(percent) && percent > BATTERY_FLOOR
  }

  // Blocks idle sleep, which is what ends a task when the screen goes dark.
  // The lid is a separate path and needs the pmset flag below.
  const holdIdleSleep = (wanted: boolean) => {
    if (wanted === (idleGuard !== undefined)) return
    if (wanted) {
      // -w drops the assertion by itself if this server dies before dispose.
      idleGuard = spawn("/usr/bin/caffeinate", ["-i", "-m", "-w", String(process.pid)], {
        stdio: "ignore",
        detached: true,
      })
      idleGuard.unref()
      return
    }
    idleGuard?.kill()
    idleGuard = undefined
  }

  const closedLidIsHeld = async () => {
    const { stdout } = await run("/usr/bin/pmset", ["-g"])
    return /SleepDisabled\s+1/.test(stdout)
  }

  // A stored system setting with no owning process, so it survives a reboot.
  // It has no counter, so two opencode servers would fight over it.
  const holdClosedLid = async (wanted: boolean) => {
    if (lidControlLost) return
    // Anything on the machine can change this flag, so never trust a cache.
    if ((await closedLidIsHeld()) === wanted) return
    try {
      await run("/usr/bin/sudo", ["-n", "/usr/bin/pmset", "disablesleep", wanted ? "1" : "0"])
    } catch (error) {
      // Without the sudoers rule only the closed lid is lost. Idle sleep is
      // still blocked, so the common case keeps working.
      lidControlLost = true
      await log("pmset disablesleep failed, a closed lid will still sleep", { error: String(error) })
    }
  }

  return {
    apply: async (working: boolean) => {
      holdIdleSleep(working)
      await holdClosedLid(working && (await powerAllowsClosedLid()))
    },
    release: async () => {
      holdIdleSleep(false)
      await holdClosedLid(false)
    },
  }
}

// ---------------------------------------------------------------------------
// opencode plugin entry point
// ---------------------------------------------------------------------------

export const KeepAwake = async ({ client }: PluginInput) => {
  if (process.platform !== "darwin") return {}

  const log: Log = (message, extra) =>
    client.app
      .log({ body: { service: "keep-awake", level: "warn", message, extra } })
      .then(
        () => undefined,
        () => undefined,
      )

  const source = opencodeSource(client, log)
  const holds = createHolds(log)

  // No hook awaits a run, so two can overlap and spawn two guards. Skipping is
  // safe here because the timer checks again soon.
  let syncing = false

  const sync = async () => {
    if (syncing) return
    syncing = true
    try {
      await holds.apply(await source.isWorking())
    } catch (error) {
      await log("sync failed", { error: String(error) })
    } finally {
      syncing = false
    }
  }

  const timer = setInterval(() => void sync(), POLL_MS)

  // Also clears a flag left behind by an earlier server that crashed. Not
  // awaited: sync() calls back into the server, which waits on plugin init.
  void sync()

  return {
    event: async ({ event }: { event: OcEvent }) => {
      // Never awaited: a hook must not wait on a call back into the server.
      // Waiting here on startup froze opencode once.
      if (event.type === "session.status" || event.type === "session.idle") void sync()
    },

    dispose: async () => {
      clearInterval(timer)
      await holds.release()
    },
  }
}

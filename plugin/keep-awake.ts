// Keeps the Mac awake while any opencode session works, then lets it sleep.
// The menu bar icon for this state is swiftbar/keepawake.10s.sh in this repository.
// The closed-lid part needs the rule in /etc/sudoers.d/opencode-keepawake.
import type { PluginInput } from "@opencode-ai/plugin"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

// Every system call gets a deadline. A call that hangs must not freeze the
// plugin while it holds sleep.
const run = (file: string, args: string[]) => execFileAsync(file, args, { timeout: 10_000 })

// A bad value falls back to the default instead of polling every millisecond.
const setting = (name: string, fallback: number, valid: (value: number) => boolean) => {
  const value = Number(process.env[name])
  return process.env[name] !== undefined && Number.isFinite(value) && valid(value) ? value : fallback
}

// Settings are read when they are used, not when this file loads. One process
// can hold several copies of the plugin, and the first copy must not pin them.

// A closed laptop on its own battery must not run itself flat.
const batteryFloor = () => setting("OPENCODE_KEEPAWAKE_BATTERY_FLOOR", 20, (v) => v >= 0 && v <= 100)

// Events already react at once. This is only the net for a lost event.
const pollMs = () => setting("OPENCODE_KEEPAWAKE_POLL_MS", 15_000, (v) => v >= 1_000 && v <= 2 ** 31 - 1)

// A server that does not answer in this time counts as nobody working.
const STATUS_TIMEOUT_MS = 5_000

// Event payloads are read structurally: the installed @opencode-ai/sdk types lag
// the running binary.
type OcEvent = { type: string }

// Logging is fire and forget, so a server that stops answering cannot stall a sync.
type Log = (message: string, extra: Record<string, unknown>) => void

const withTimeout = <T,>(promise: Promise<T>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

// ---------------------------------------------------------------------------
// Activity source: answers "is anyone working right now?" and nothing else.
// A second tool would add a second source here; the holds below stay as they are.
//
// Safety rule: a source that cannot be read, or does not answer in time,
// answers "nobody is working". The worst outcome of a format change must be
// that the feature quietly stops working, never a laptop that refuses to sleep
// in a bag.
// ---------------------------------------------------------------------------

type ActivitySource = { isWorking: () => Promise<boolean> }

const opencodeSource = (client: PluginInput["client"], log: Log): ActivitySource => ({
  // The server drops a session from this map once it goes idle. So a non-empty
  // map means someone is still working, background subagents included.
  //
  // The map covers one project directory, the one this copy of the plugin was
  // loaded for. Work in another directory belongs to another copy, so this
  // answer is only ever part of the picture. The registry below joins them.
  isWorking: async () => {
    try {
      const sessions = (await withTimeout(client.session.status(), STATUS_TIMEOUT_MS)).data
      return sessions !== undefined && Object.keys(sessions).length > 0
    } catch (error) {
      log("session status unreadable, releasing", { error: String(error) })
      return false
    }
  },
})

// ---------------------------------------------------------------------------
// Holds: the two power controls. They know nothing about where activity comes from.
// ---------------------------------------------------------------------------

const createHolds = (log: Log) => {
  let idleGuard: ChildProcess | undefined

  // Set once sudo fails. Stops further attempts to take the lid, never a release.
  let lidControlLost = false

  // After the final release nothing may take a hold again.
  let stopped = false

  // A command that breaks stays broken, and every poll would log it again.
  // Only a change is worth a line.
  let powerWasUnreadable = false
  let lidWasUnreadable = false

  // On the charger there is nothing to drain. An unreadable report counts as
  // unsafe, because sleeping early is better than a dead battery in a bag.
  const powerAllowsClosedLid = async () => {
    try {
      const { stdout } = await run("/usr/bin/pmset", ["-g", "batt"])
      powerWasUnreadable = false
      if (stdout.includes("AC Power")) return true
      const percent = Number(/(\d+)%/.exec(stdout)?.[1])
      return Number.isFinite(percent) && percent > batteryFloor()
    } catch (error) {
      if (!powerWasUnreadable) log("power source unreadable, letting the lid sleep", { error: String(error) })
      powerWasUnreadable = true
      return false
    }
  }

  // Unreadable counts as closed, for the same reason.
  const lidIsOpen = async () => {
    try {
      const { stdout } = await run("/usr/sbin/ioreg", ["-r", "-k", "AppleClamshellState", "-d", "1"])
      lidWasUnreadable = false
      return !/"AppleClamshellState"\s*=\s*Yes/.test(stdout)
    } catch (error) {
      if (!lidWasUnreadable) log("lid state unreadable, counting it as closed", { error: String(error) })
      lidWasUnreadable = true
      return false
    }
  }

  // Blocks idle sleep, which is what ends a task when the screen goes dark.
  // The lid is a separate path and needs the pmset flag below.
  const holdIdleSleep = (wanted: boolean) => {
    if (wanted === (idleGuard !== undefined)) return
    if (wanted) {
      // -w drops the assertion by itself if this server dies before dispose.
      const guard = spawn("/usr/bin/caffeinate", ["-i", "-m", "-w", String(process.pid)], {
        stdio: "ignore",
        detached: true,
      })
      // A guard that dies, or is killed from outside, is noticed and replaced on
      // the next sync. An unhandled "error" would take the whole server down.
      const forget = () => {
        if (idleGuard === guard) idleGuard = undefined
      }
      guard.on("exit", forget)
      guard.on("error", (error) => {
        forget()
        log("caffeinate failed", { error: String(error) })
      })
      guard.unref()
      idleGuard = guard
      return
    }
    const guard = idleGuard
    idleGuard = undefined
    guard?.kill()
  }

  const closedLidIsHeld = async () => {
    const { stdout } = await run("/usr/bin/pmset", ["-g"])
    return /SleepDisabled\s+1/.test(stdout)
  }

  // A stored system setting with no owning process, so it survives a reboot.
  // It has no counter, so two opencode servers would fight over it.
  const holdClosedLid = async (wanted: boolean) => {
    if (wanted && lidControlLost) return
    // Anything on the machine can change this flag, so never trust a cache.
    if ((await closedLidIsHeld()) === wanted) return
    try {
      await run("/usr/bin/sudo", ["-n", "/usr/bin/pmset", "disablesleep", wanted ? "1" : "0"])
    } catch (error) {
      // Without the sudoers rule only the closed lid is lost. Idle sleep is
      // still blocked, so the common case keeps working.
      lidControlLost = true
      log(`pmset disablesleep ${wanted ? 1 : 0} failed`, { error: String(error) })
    }
  }

  // One change at a time, in order. Otherwise a slow apply could land after
  // the final release and leave the flag set with nobody left to clear it.
  let queue: Promise<void> = Promise.resolve()
  const inOrder = (task: () => Promise<void>) => {
    const next = queue.then(task)
    queue = next.catch(() => undefined)
    return next
  }

  return {
    apply: (working: boolean) =>
      inOrder(async () => {
        if (stopped) return
        const lidAllowed = working && (await powerAllowsClosedLid())
        // Below the battery floor with the lid shut, let go of everything, so
        // the Mac is not left running in a bag on its last charge.
        holdIdleSleep(working && (lidAllowed || (await lidIsOpen())))
        await holdClosedLid(lidAllowed)
      }),
    release: () =>
      inOrder(async () => {
        stopped = true
        holdIdleSleep(false)
        await holdClosedLid(false)
      }),
  }
}

// ---------------------------------------------------------------------------
// Registry: one set of holds for the whole process.
//
// opencode loads this plugin once per project directory, so a single server can
// run several copies of it at the same time. They all drive the same two power
// controls, and those controls have no counter. Worse, each copy only sees the
// sessions of its own directory. A copy whose directory was idle used to clear
// the flag while another copy was still working, which let the Mac sleep in the
// middle of a task.
//
// So every copy joins here instead of holding anything itself. The registry
// owns one set of holds and one timer, and the machine counts as working while
// any joined copy says it is working.
// ---------------------------------------------------------------------------

type Member = ActivitySource & { log: Log }

type Registry = {
  join: (member: Member) => void
  leave: (member: Member) => Promise<void>
  sync: () => Promise<void>
}

const createRegistry = (): Registry => {
  const members = new Set<Member>()

  // One line per event is enough, so the oldest member carries the log.
  const log: Log = (message, extra) => {
    const [first] = members
    first?.log(message, extra)
  }

  // Holds exist only while at least one copy is joined. The last one to leave
  // latches its set shut, so the next copy to join needs a fresh one.
  let holds: ReturnType<typeof createHolds> | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  // Each copy answers for its own directory, so one yes is enough. No members
  // and no answers both mean nobody is working.
  const anyoneWorking = async () => {
    const answers = await Promise.all([...members].map((member) => member.isWorking()))
    return answers.includes(true)
  }

  // Runs never overlap. An event that arrives during a run asks for one more
  // run after it, so no change waits for the timer.
  let syncing = false
  let again = false

  const sync = async () => {
    if (syncing) {
      again = true
      return
    }
    syncing = true
    try {
      do {
        again = false
        const current = holds
        if (current === undefined) break
        try {
          await current.apply(await anyoneWorking())
        } catch (error) {
          log("sync failed", { error: String(error) })
        }
      } while (again)
    } finally {
      syncing = false
    }
  }

  return {
    join: (member) => {
      members.add(member)
      holds ??= createHolds(log)
      timer ??= setInterval(() => void sync(), pollMs())
      // Not awaited: sync() calls back into the server, which waits on plugin
      // init. The first run also clears a flag left behind by a crashed server.
      void sync()
    },

    leave: async (member) => {
      members.delete(member)
      if (members.size > 0) {
        // This directory stopped counting, so ask the remaining copies now.
        void sync()
        return
      }
      clearInterval(timer)
      timer = undefined
      const last = holds
      holds = undefined
      // Does not wait for a pending status call. A sync that finishes later
      // finds no holds and changes nothing.
      await last?.release()
    },

    sync,
  }
}

// Symbol.for reaches the same registry from every copy of this file in the
// process, even when each copy is a separate module instance.
const REGISTRY = Symbol.for("opencode-keep-awake.registry.v1")

type Host = { [REGISTRY]?: Registry }

const registryForProcess = (): Registry => {
  const host = globalThis as unknown as Host
  const existing = host[REGISTRY]
  if (existing !== undefined) return existing
  const created = createRegistry()
  host[REGISTRY] = created
  return created
}

// ---------------------------------------------------------------------------
// opencode plugin entry point
// ---------------------------------------------------------------------------

export const KeepAwake = async ({ client }: PluginInput) => {
  if (process.platform !== "darwin") return {}

  const log: Log = (message, extra) => {
    try {
      client.app.log({ body: { service: "keep-awake", level: "warn", message, extra } }).then(
        () => undefined,
        () => undefined,
      )
    } catch {}
  }

  const registry = registryForProcess()
  const member: Member = { ...opencodeSource(client, log), log }
  registry.join(member)

  return {
    event: async ({ event }: { event: OcEvent }) => {
      // Never awaited: a hook must not wait on a call back into the server.
      // Waiting here on startup froze opencode once.
      if (event.type === "session.status" || event.type === "session.idle") void registry.sync()
    },

    // The holds go away with the last copy in this process, not with the first.
    dispose: async () => {
      await registry.leave(member)
    },
  }
}

// Drives plugin/keep-awake.ts with a fake opencode client and checks the result
// against real pmset output. No opencode server is started or touched.
//
//   node test/drive.mts
//
// Needs macOS, Node 22.18 or newer (runs TypeScript directly), and the sudoers
// rule from sudoers/. It flips the real SleepDisabled flag while it runs and
// puts back the value it found when it ends, pass or fail.
import { execFileSync } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"

const PLUGIN = new URL("../plugin/keep-awake.ts", import.meta.url).href

// Only events and explicit calls drive the plugin here, never its own timer.
process.env.OPENCODE_KEEPAWAKE_POLL_MS = String(24 * 3600 * 1000)
// The closed-lid hold is skipped on a low battery. Most cases test the
// mechanism, so they allow any charge above zero. The battery case reloads the
// plugin with its own floor.
process.env.OPENCODE_KEEPAWAKE_BATTERY_FLOOR = "0"

const { KeepAwake } = await import(PLUGIN)

const GUARD = `/usr/bin/caffeinate -i -m -w ${process.pid}`

const sh = (file: string, args: string[]) => execFileSync(file, args, { encoding: "utf8" })

const flag = () => /SleepDisabled\s+1/.test(sh("/usr/bin/pmset", ["-g"]))
const setFlag = (on: boolean) => sh("/usr/bin/sudo", ["-n", "/usr/bin/pmset", "disablesleep", on ? "1" : "0"])

const commands = () =>
  sh("/bin/ps", ["-axo", "command="])
    .split("\n")
    .map((line) => line.trim())
const ourGuards = () => commands().filter((c) => c === GUARD).length
const foreignGuards = () =>
  commands().filter((c) => c.startsWith("/usr/bin/caffeinate -i -m -w ") && c !== GUARD)
// Only ever kills the guard this harness's plugin spawned, never anyone else's.
const killOurGuard = () => {
  if (ourGuards() > 0) sh("/usr/bin/pkill", ["-f", `^${GUARD}$`])
}

const onBattery = () => !sh("/usr/bin/pmset", ["-g", "batt"]).includes("AC Power")
const lidClosed = () =>
  /"AppleClamshellState"\s*=\s*Yes/.test(sh("/usr/sbin/ioreg", ["-r", "-k", "AppleClamshellState", "-d", "1"]))

// --- fake clients -----------------------------------------------------------

type Sessions = Record<string, unknown>
type State = { sessions: Sessions | Error | "silent"; delayMs?: number }

const never = <T,>() => new Promise<T>(() => {})

const fakeClient = (state: State) => ({
  session: {
    // Answers with the state at the moment of the request, like a real server.
    status: async () => {
      const answer = state.sessions
      if (answer === "silent") return never()
      if (state.delayMs) await sleep(state.delayMs)
      if (answer instanceof Error) throw answer
      return { data: answer }
    },
  },
  app: { log: () => (state.sessions === "silent" ? never() : Promise.resolve({ data: true })) },
})

const busy: Sessions = { ses_a: { type: "busy" } }
const retrying: Sessions = { ses_b: { type: "retry", attempt: 2, message: "rate limited", next: Date.now() + 5000 } }
const idle: Sessions = {}

const statusEvent = { event: { type: "session.status" } }

// --- tiny runner ------------------------------------------------------------

let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)
  if (!ok) failures++
}
const skip = (name: string, why: string) => console.log(`skip  ${name}  (${why})`)

const waitFor = async (predicate: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (predicate()) return true
    await sleep(50)
  }
  return predicate()
}

const within = async (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true), sleep(ms).then(() => false)])

const held = () => ourGuards() === 1 && flag()
const released = () => ourGuards() === 0 && !flag()
const state = () => `guards=${ourGuards()} flag=${flag()}`

// --- preconditions ----------------------------------------------------------

if (process.platform !== "darwin") {
  console.error("macOS only")
  process.exit(2)
}
try {
  // Writes the value already there, so nothing changes. -k ignores a cached
  // sudo login and -n refuses to prompt, so only the NOPASSWD rule can pass.
  // sudo -l is no proof: on an admin account it approves any command.
  const current = flag() ? "1" : "0"
  sh("/usr/bin/sudo", ["-n", "-k", "/usr/bin/pmset", "disablesleep", current])
} catch {
  console.error("The sudoers rule is missing: sudo -n /usr/bin/pmset disablesleep needs a password.")
  process.exit(2)
}
const others = foreignGuards()
if (others.length > 0) {
  // A live opencode server with this plugin owns the same global flag and would
  // rewrite it under the test. Wait until its sessions finish, then run again.
  console.error("Another keep-awake guard is running, so a live plugin owns the flag right now:")
  for (const c of others) console.error(`  ${c}`)
  process.exit(2)
}

const original = flag()
console.log(`SleepDisabled before the run: ${original ? 1 : 0}`)

// --- cases ------------------------------------------------------------------

try {
  {
    // A server that has not finished starting answers nothing. Awaiting it in
    // init or in a hook deadlocks opencode startup. A blocked call would hang
    // the harness too, so each of these stops the run.
    const started = KeepAwake({ client: fakeClient({ sessions: "silent" }) })
    const initReturned = await within(started, 500)
    check("init returns while the client never answers", initReturned)
    if (!initReturned) throw new Error("plugin init blocked on the client")
    const hooks = await started
    check("dispose returns while the client never answers", await within(hooks.dispose(), 5000))
  }

  {
    // This one answers at init, then stops, so the hook has a sync to wait on.
    const s: State = { sessions: idle }
    const hooks = await KeepAwake({ client: fakeClient(s) })
    await sleep(300)
    s.sessions = "silent"
    const hookReturned = await within(hooks.event(statusEvent), 500)
    check("event hook returns while the client never answers", hookReturned)
    if (!hookReturned) throw new Error("event hook blocked on the client")
    await hooks.dispose()
  }

  setFlag(false)

  {
    const s: State = { sessions: busy }
    const hooks = await KeepAwake({ client: fakeClient(s) })

    check("busy session: both holds taken", await waitFor(held), state())

    // The flag is global and anything may clear it. The plugin must read it
    // before each write instead of trusting what it set last time.
    setFlag(false)
    check("flag cleared externally", !flag())
    await hooks.event(statusEvent)
    check("one sync puts the cleared flag back", await waitFor(flag), state())
    check("still exactly one guard", ourGuards() === 1, state())

    // Same rule for the guard: a dead one must be noticed and replaced.
    killOurGuard()
    await waitFor(() => ourGuards() === 0)
    await hooks.event(statusEvent)
    check("guard killed from outside is replaced", await waitFor(held), state())

    s.sessions = idle
    await hooks.event(statusEvent)
    check("sessions finish: both holds released", await waitFor(released), state())

    s.sessions = retrying
    await hooks.event(statusEvent)
    check("retry state counts as working", await waitFor(held), state())

    // Safety rule: an unreadable source means nobody is working.
    s.sessions = new Error("status endpoint changed shape")
    await hooks.event(statusEvent)
    check("unreadable source releases both holds", await waitFor(released), state())

    s.sessions = busy
    await hooks.event(statusEvent)
    await waitFor(held)
    // ...and so does a server that stops answering while holds are taken.
    s.sessions = "silent"
    await hooks.event(statusEvent)
    check("source that stops answering releases both holds", await waitFor(released, 9000), state())

    await hooks.dispose()
  }

  {
    // An event that lands during a sync must not be lost until the next poll.
    // The timer is off here, so a lost event would leave the holds taken.
    const s: State = { sessions: busy, delayMs: 600 }
    const hooks = await KeepAwake({ client: fakeClient(s) })
    await sleep(100)
    s.sessions = idle
    await hooks.event(statusEvent)
    await waitFor(held, 2000)
    check("event during a sync is not dropped", await waitFor(released, 4000), state())
    await hooks.dispose()
  }

  {
    // dispose while a sync is still waiting on the server. The late answer
    // ("busy") must not take the holds again after the final release.
    const s: State = { sessions: busy, delayMs: 500 }
    const hooks = await KeepAwake({ client: fakeClient(s) })
    await sleep(100)
    await hooks.dispose()
    await sleep(1200)
    check("dispose during an in-flight sync leaves nothing held", released(), state())
  }

  {
    // A slow server and a flood of events: overlapping syncs must not stack guards.
    const s: State = { sessions: busy, delayMs: 200 }
    const hooks = await KeepAwake({ client: fakeClient(s) })
    await Promise.all(Array.from({ length: 50 }, () => hooks.event(statusEvent)))
    await waitFor(held)
    await sleep(500)
    check("burst of 50 events spawns exactly one guard", ourGuards() === 1, state())

    await hooks.dispose()
    check("dispose leaves no guard and no flag", await waitFor(released), state())
  }

  if (onBattery()) {
    // A fresh copy of the module with a floor no charge can pass.
    process.env.OPENCODE_KEEPAWAKE_BATTERY_FLOOR = "100"
    const { KeepAwake: LowBattery } = await import(`${PLUGIN}?floor=100`)
    const hooks = await LowBattery({ client: fakeClient({ sessions: busy }) })
    const closed = lidClosed()
    const expected = () => !flag() && ourGuards() === (closed ? 0 : 1)
    await sleep(1000)
    check(
      `below the battery floor, lid ${closed ? "closed: nothing held" : "open: idle hold only"}`,
      await waitFor(expected),
      state(),
    )
    await hooks.dispose()
    process.env.OPENCODE_KEEPAWAKE_BATTERY_FLOOR = "0"
  } else {
    skip("battery floor", "on AC power, unplug the charger to exercise it")
  }
} catch (error) {
  check("harness ran without throwing", false, String(error))
} finally {
  killOurGuard()
  setFlag(original)
  check(`SleepDisabled restored to ${original ? 1 : 0}`, flag() === original)
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)

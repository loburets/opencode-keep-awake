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

// Only events and explicit calls drive the plugin here, never its own timer.
process.env.OPENCODE_KEEPAWAKE_POLL_MS = String(24 * 3600 * 1000)
// The closed-lid hold is skipped on a low battery. The harness tests the
// mechanism, so it allows any charge above zero.
process.env.OPENCODE_KEEPAWAKE_BATTERY_FLOOR = "0"

const { KeepAwake } = await import(new URL("../plugin/keep-awake.ts", import.meta.url).href)

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

// --- fake clients -----------------------------------------------------------

type Sessions = Record<string, unknown>

const never = <T,>() => new Promise<T>(() => {})

const silentClient = () => ({
  session: { status: () => never() },
  app: { log: () => never() },
})

const scriptedClient = (state: { sessions: Sessions | Error; delayMs?: number }) => ({
  session: {
    status: async () => {
      if (state.delayMs) await sleep(state.delayMs)
      if (state.sessions instanceof Error) throw state.sessions
      return { data: state.sessions }
    },
  },
  app: { log: async () => ({ data: true }) },
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

const waitFor = async (predicate: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (predicate()) return true
    await sleep(50)
  }
  return predicate()
}

// A sync that is still finishing makes the plugin skip the next event on
// purpose (its timer would catch up). Let the last one end before sending more.
const settle = () => sleep(300)

const within = async (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true), sleep(ms).then(() => false)])

const held = () => ourGuards() === 1 && flag()
const released = () => ourGuards() === 0 && !flag()

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
    // init or in a hook deadlocks opencode startup.
    // A blocked call would hang the harness too, so each step stops the run.
    const started = KeepAwake({ client: silentClient() })
    const initReturned = await within(started, 500)
    check("init returns while the client never answers", initReturned)
    if (!initReturned) throw new Error("plugin init blocked on the client")
    const hooks = await started
    check("dispose returns while the client never answers", await within(hooks.dispose(), 5000))
  }

  {
    // The init sync above never ends, so that instance skips every later sync
    // and cannot show a hook that waits. This one answers at init, then stops.
    const client = scriptedClient({ sessions: idle })
    const hooks = await KeepAwake({ client })
    await settle()
    client.session.status = () => never()
    client.app.log = () => never()
    const hookReturned = await within(hooks.event(statusEvent), 500)
    check("event hook returns while the client never answers", hookReturned)
    if (!hookReturned) throw new Error("event hook blocked on the client")
    await hooks.dispose()
  }

  setFlag(false)

  {
    const state: { sessions: Sessions | Error; delayMs?: number } = { sessions: busy }
    const hooks = await KeepAwake({ client: scriptedClient(state) })

    check("busy session: both holds taken", await waitFor(held), `guards=${ourGuards()} flag=${flag()}`)

    // The flag is global and anything may clear it. The plugin must read it
    // before each write instead of trusting what it set last time.
    await settle()
    setFlag(false)
    check("flag cleared externally", !flag())
    await hooks.event(statusEvent)
    check("one sync puts the cleared flag back", await waitFor(flag), `flag=${flag()}`)
    check("still exactly one guard", ourGuards() === 1, `guards=${ourGuards()}`)

    await settle()
    state.sessions = idle
    await hooks.event(statusEvent)
    check("sessions finish: both holds released", await waitFor(released), `guards=${ourGuards()} flag=${flag()}`)

    await settle()
    state.sessions = retrying
    await hooks.event(statusEvent)
    check("retry state counts as working", await waitFor(held), `guards=${ourGuards()} flag=${flag()}`)

    // Safety rule: an unreadable source means nobody is working.
    await settle()
    state.sessions = new Error("status endpoint changed shape")
    await hooks.event(statusEvent)
    check("unreadable source releases both holds", await waitFor(released), `guards=${ourGuards()} flag=${flag()}`)

    await hooks.dispose()
  }

  {
    // A slow server and a flood of events: overlapping syncs must not stack guards.
    const state = { sessions: busy as Sessions | Error, delayMs: 200 }
    const hooks = await KeepAwake({ client: scriptedClient(state) })
    await Promise.all(Array.from({ length: 50 }, () => hooks.event(statusEvent)))
    await waitFor(held)
    await sleep(500)
    check("burst of 50 events spawns exactly one guard", ourGuards() === 1, `guards=${ourGuards()}`)

    await hooks.dispose()
    check("dispose leaves no guard and no flag", await waitFor(released), `guards=${ourGuards()} flag=${flag()}`)
  }
} catch (error) {
  check("harness ran without throwing", false, String(error))
} finally {
  if (ourGuards() > 0) sh("/usr/bin/pkill", ["-f", `^${GUARD}$`])
  setFlag(original)
  const restored = flag() === original
  check(`SleepDisabled restored to ${original ? 1 : 0}`, restored)
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)

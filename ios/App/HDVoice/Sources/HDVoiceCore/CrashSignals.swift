//
//  CrashSignals.swift — what actually killed the app: a fatal signal noted in a file as the process dies.
//
//  A voice's in-flight marker says the process died while its call ran; it doesn't say how. While Nephis reads, her
//  call is in flight almost all the time, so an app bug then (the Oct 9 crash: a Swift exclusivity fatalError on the
//  main thread, SIGABRT, 14 s after launch with her model loading) looked exactly like a crash of her model.
//
//  The handler, installed once at launch (RunJournal.start, from VoiceRun), writes one line to the run's signal file
//  for SIGSEGV, SIGBUS, SIGABRT, SIGTRAP and SIGILL: "<signal> <unix seconds> <1: on the main thread | 0>". Then the
//  previous action is put back and the process dies as it would have: a memory fault or a trap happens again as the
//  handler returns (so iOS's crash report keeps the faulting address), abort() is raised again. Nothing else changes.
//
//  Kills come without a signal the app can see (SIGKILL): swiped away while suspended, iOS closing the app for memory
//  or in the background, the watchdog (a hang), CPU limits, the phone switching off. No line means no crash.
//
//  Inside the handler only async-signal-safe work: write(2) of a line built in a buffer allocated at install, no
//  allocation, no locks, no Foundation.
//

import Foundation

/// The file descriptor the handler writes to (a dup of the journal's, so it stays open for the life of the process).
nonisolated(unsafe) private var crashSignalFD: Int32 = -1

/// The actions in place before the handler, by signal number (Darwin has 32), put back as the process dies.
nonisolated(unsafe) private let previousActions: UnsafeMutablePointer<sigaction> = {
    let p = UnsafeMutablePointer<sigaction>.allocate(capacity: 32)
    p.initialize(repeating: sigaction(), count: 32)
    return p
}()

/// The line the handler writes, allocated once (a signal handler must not allocate).
nonisolated(unsafe) private let lineBuffer: UnsafeMutablePointer<UInt8> = {
    let p = UnsafeMutablePointer<UInt8>.allocate(capacity: 64)
    p.initialize(repeating: 0, count: 64)
    return p
}()

/// The process is dying of `signo`: note it, put the previous action back and let it die as it would have.
private func crashSignalHandler(_ signo: Int32) {
    CrashSignals.note(signo, fd: crashSignalFD, time: time(nil), mainThread: pthread_main_np() != 0)
    if signo > 0, signo < 32 { _ = sigaction(signo, previousActions + Int(signo), nil) }
    // A fault or a trap comes back as soon as the handler returns, now with the previous action; abort() and a
    // SIGABRT sent by anyone else are raised again (delivered as the handler returns).
    if signo == SIGABRT { _ = raise(signo) }
}

public enum CrashSignals {
    /// Memory faults (SIGSEGV, SIGBUS: how a crash inside Core ML's BNNS runtime ends the app), Swift traps (SIGTRAP,
    /// SIGILL) and abort() (SIGABRT: a fatalError, an exclusivity violation, an uncaught exception).
    public static let watched: [Int32] = [SIGSEGV, SIGBUS, SIGABRT, SIGTRAP, SIGILL]

    private static let lock = NSLock()

    /// Installs the handler, writing to `fd` (the run's signal file, already stamped with the run). Once per process: a
    /// later call keeps the first file. True when every watched signal has the handler.
    public static func install(_ fd: Int32) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if crashSignalFD >= 0 { return true }
        let own = dup(fd)
        guard own >= 0 else { return false }
        // Both buffers exist before the handler can run (a global is set up on first use).
        _ = lineBuffer
        _ = previousActions
        crashSignalFD = own
        var action = sigaction()
        action.__sigaction_u.__sa_handler = crashSignalHandler
        var all = true
        for signo in watched where signo > 0 && signo < 32 {
            if sigaction(signo, &action, previousActions + Int(signo)) != 0 { all = false }
        }
        return all
    }

    /// The handler's line, "<signal> <unix seconds> <1|0>\n", in one write(2). Async-signal-safe: no allocation, no
    /// locks. (Two threads dying at once can garble it; an unreadable line reads as no signal, which never counts.)
    static func note(_ signo: Int32, fd: Int32, time: Int, mainThread: Bool) {
        guard fd >= 0 else { return }
        let line = lineBuffer
        var n = put(Int(signo), line, 0)
        line[n] = 0x20
        n += 1
        n = put(time, line, n)
        line[n] = 0x20
        line[n + 1] = mainThread ? 0x31 : 0x30
        line[n + 2] = 0x0A
        n += 3
        _ = write(fd, line, n)
    }

    /// The decimal digits of `value` (0 when negative) at `line[at...]`; the index after them.
    private static func put(_ value: Int, _ line: UnsafeMutablePointer<UInt8>, _ at: Int) -> Int {
        var v = value < 0 ? 0 : value
        var digits = 1
        var rest = v / 10
        while rest > 0 {
            digits += 1
            rest /= 10
        }
        var i = at + digits - 1
        repeat {
            line[i] = UInt8(truncatingIfNeeded: 0x30 + v % 10)
            v /= 10
            i -= 1
        } while v > 0
        return at + digits
    }
}

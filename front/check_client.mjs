/**
 * Node harness for the client state machine in `ts/ot_client.ts`.
 *
 * It drives the compiled client (`ts/ot_client.js`, the exact module the browser
 * loads) against a mock of the backend: `Server` mirrors `Ot.applyEdit` /
 * `Ot.GetHistory` and the per-connection history cursor of `Connection`, so the
 * scenarios below are the real protocol, not a simplified one.
 *
 * Run it from `front/`:
 *
 *     npx tsc -p tsconfig.json && node check_client.mjs
 *
 * Every scenario ends with the same assertion: each client's local text equals
 * the server document, and no operator is left pending.
 *
 * The `P*` scenarios at the end run the *original pseudocode* against the same
 * server. They are expected failures: each one demonstrates a defect the
 * corrected client fixes, so their output is evidence for the analysis rather
 * than a regression test.
 */

import { OtClient, calculateOperator, formatOperator } from "./ts/ot_client.js";
import { Operator } from "./ts/ot.js";

/* -------------------------------------------------------------------------- */
/* Assertions                                                                  */
/* -------------------------------------------------------------------------- */

let checks = 0;
let failures = 0;

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
    checks += 1;
    if (condition) {
        console.log("  ok   " + message);
    } else {
        failures += 1;
        console.error("  FAIL " + message);
    }
}

/** @param {unknown} value */
function show(value) {
    return JSON.stringify(value);
}

/* -------------------------------------------------------------------------- */
/* Server mock                                                                 */
/* -------------------------------------------------------------------------- */

/** `Ot`: the document, the operator history and the revision it defines. */
class Server {
    /** @param {string} content */
    constructor(content = "helloworld") {
        this.content = content;
        /** @type {Operator[]} */
        this.ops = [];
    }

    get reversion() {
        return this.ops.length;
    }

    /**
     * `Ot.applyEdit`: transform the operator against the history that landed
     * after its base, apply it and append it. Go stores the author's claimed
     * base revision on the stored operator (`Transform` copies `Reversion`), so
     * the mock keeps it too - the client's echo test depends on that field.
     *
     * @param {{reversion: number, operator: unknown}} edit
     */
    applyEdit(edit) {
        const claimed = edit.reversion;
        if (claimed > this.ops.length) {
            return null;
        }

        let prime = Operator.fromJSON(edit.operator);
        prime.reversion = claimed;

        for (let i = claimed; i < this.ops.length; i += 1) {
            [prime] = prime.transform(this.ops[i]);
        }

        this.content = prime.apply(this.content);
        this.ops.push(prime);
        return this.ops.length;
    }
}

/** `Connection`: one socket's own view of the history it has been sent. */
class Conn {
    /** @param {Server} server @param {string} name */
    constructor(server, name) {
        this.server = server;
        this.name = name;
        this.reversion = 0;
        /** @type {object[]} */
        this.queue = [];
    }

    /** One `init` frame, the way the connection sends it on join. */
    initFrame() {
        return { init: { reversion: this.server.reversion, content: this.server.content, user_id: this.name, users: [] } };
    }

    /**
     * `Connection.checkAndSendEditHistory`: hand this socket everything after the
     * revision it stopped at.
     *
     * @param {boolean} batch true to send one frame with all operations, false to
     *   send one frame per operation (what `getOneReceive` expects)
     */
    pushHistory(batch) {
        const from = this.reversion;
        const to = this.server.reversion;
        if (from >= to) {
            return;
        }

        const ops = this.server.ops.slice(from, to).map((op) => op.toJSON());
        if (batch) {
            this.queue.push({ edit: { reversion: to, operator: ops } });
        } else {
            for (const [index, op] of ops.entries()) {
                this.queue.push({ edit: { reversion: from + index + 1, operator: [op] } });
            }
        }

        this.reversion = to;
    }
}

/** One browser tab: the textarea plus the client state machine behind it. */
class Client {
    /** @param {string} name @param {Server} server */
    constructor(name, server) {
        this.name = name;
        this.server = server;
        this.state = new OtClient();
        this.conn = new Conn(server, name);
        /** @type {string} what the textarea shows */
        this.textarea = "";
        /** @type {string[]} */
        this.log = [];
    }

    /** `send init msg`: adopt the server document. */
    init() {
        this.state.enqueue(this.conn.initFrame());
        this.pressReceive();
        this.conn.reversion = this.server.reversion;
        this.textarea = this.state.renderText();
    }

    /** @param {string} text simulate typing, without pressing any button */
    type(text) {
        this.textarea = text;
    }

    /** `calculate operator`. */
    calc() {
        this.collect(this.state.calculate(this.textarea));
    }

    /** `send operator`. */
    send() {
        const payload = this.state.buildSendMessage();
        if (!payload) {
            return false;
        }
        this.server.applyEdit(payload.message.edit);
        this.state.markSent();
        return true;
    }

    /** `receive operator`, pressed once: consume every frame the state queued. */
    pressReceive() {
        const result = this.state.consumePending(this.textarea);
        this.collect(result);
        this.textarea = this.state.renderText();
        return result.ok;
    }

    /** Deliver the frames this socket was sent, pressing the button as they land. */
    consume() {
        while (this.conn.queue.length > 0) {
            const frame = this.conn.queue.shift();
            this.collect(this.state.enqueue(frame));
            if (!this.pressReceive()) {
                return false;
            }
        }
        return true;
    }

    /** @param {{lines: string[], ok: boolean}} result */
    collect(result) {
        this.log.push(...result.lines.map((l) => l.split("\u0001").join(" | ")));
    }

    /** @returns {string} a readable summary for a failing assertion */
    describe() {
        const s = this.state.getState();
        return `${this.name}{base=${show(s.baseText)} apply=${show(s.applyText)} send=${s.hasSend} wait=${s.hasWait} desync=${s.desynced}}`;
    }
}

/** Hand every client the history it has not seen, then let each one consume it. */
function settle(clients, batch = false) {
    for (const client of clients) {
        client.conn.pushHistory(batch);
    }
    for (const client of clients) {
        client.consume();
    }
}

/** The assertion every scenario ends with. */
function expectConverged(clients, server, label) {
    for (const client of clients) {
        const state = client.state.getState();
        assert(state.applyText === server.content, `${label}: ${client.name} local text == server document ${show(server.content)}`);
        assert(state.baseText === server.content, `${label}: ${client.name} base text == server document`);
        assert(!state.hasSend && !state.hasWait, `${label}: ${client.name} has nothing left pending`);
        assert(!state.desynced, `${label}: ${client.name} is not desynced`);
        assert(
            !client.log.some((entry) => entry.includes("warn")),
            `${label}: ${client.name} never had to repair a rebase (transforms were consistent)`,
        );
    }
}

/** Dump the collected log of a client, for a scenario that failed. */
function dump(client) {
    console.log(`--- ${client.name} log ---`);
    for (const entry of client.log) {
        console.log("    " + entry);
    }
}

/* -------------------------------------------------------------------------- */
/* Scenarios                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * S1: one client, three "calculate operator" presses before anything is sent.
 *
 * The first fills `send_operator`, the next two refill `wait_operator`. The
 * waiting operator has to be re-derived from the document it will be sent
 * against, or the second edit is lost when the third one replaces it.
 */
function scenario1() {
    console.log("\nS1 single client, stacked calculations");
    const server = new Server("helloworld");
    const a = new Client("A", server);
    a.init();

    a.type("Xhelloworld");
    a.calc();
    a.type("XYhelloworld");
    a.calc();
    a.type("XYZhelloworld");
    a.calc();

    const held = a.state.getState();
    assert(held.hasSend && held.hasWait, "S1: send_operator and wait_operator both hold an operator");
    assert(!held.dispatched, "S1: calculate does not mark the operator as sent");
    assert(held.sendReversion === 1, "S1: send_reversion is base + 1");

    assert(a.send(), "S1: send operator dispatches the first operator");
    settle([a]);
    assert(a.send(), "S1: the waiting operator is promoted and can be sent");

    settle([a]);
    expectConverged([a], server, "S1");
    assert(server.content === "XYZhelloworld", `S1: server document is ${show("XYZhelloworld")}, got ${show(server.content)}`);

    if (a.state.getState().desynced) {
        dump(a);
    }
}

/**
 * S2: two clients edit the same revision.
 *
 * A's own operation is the second one the server appends, and the revision A
 * predicted for it (1) is occupied by B's operation instead - the trace that
 * makes "the revision I expect" an unsound echo test.
 */
function scenario2(batch) {
    console.log(`\nS2 two clients, concurrent edits (${batch ? "batch" : "per operation"} frames)`);
    const server = new Server("helloworld");
    const a = new Client("A", server);
    const b = new Client("B", server);
    a.init();
    b.init();

    b.type("helloworld-B");
    b.calc();
    assert(b.send(), "S2: B sends first (revision 1)");

    a.type("Ahelloworld");
    a.calc();
    assert(a.send(), "S2: A sends against base 0, so its operation lands at revision 2");
    assert(a.state.getState().sendReversion === 1, "S2: A predicted revision 1, which B took");

    settle([a, b], batch);
    expectConverged([a, b], server, "S2");
    assert(server.content.includes("Ahelloworld") && server.content.includes("-B"), `S2: both edits survive: ${show(server.content)}`);

    const state = a.state.getState();
    assert(state.receiveReversion === 2, "S2: A consumed both operations");
    if (state.desynced) {
        dump(a);
    }
}

/**
 * S3: a foreign operation arrives while a local one is in flight, and the user
 * keeps typing before pressing receive.
 */
function scenario3() {
    console.log("\nS3 foreign operation in flight, plus typing after the send");
    const server = new Server("helloworld");
    const a = new Client("A", server);
    const b = new Client("B", server);
    a.init();
    b.init();

    b.type("helloworld-B");
    b.calc();
    b.send();

    a.type("Ahelloworld");
    a.calc();
    a.send();
    a.type("Ahelloworld-A"); // typed while the first operator is on its way
    a.calc(); // ... and calculated, so it goes into wait_operator

    const beforeReceive = a.state.getState();
    assert(beforeReceive.hasSend && beforeReceive.hasWait, "S3: A holds a sent and a waiting operator");

    a.conn.pushHistory(false);
    // Consume one frame at a time, so the intermediate rebase is visible.
    const first = a.conn.queue.shift();
    a.collect(a.state.enqueue(first));
    a.pressReceive();

    const mid = a.state.getState();
    assert(mid.receiveReversion === 1, "S3: the foreign operation advanced the revision");
    assert(mid.applyText.includes("-B"), `S3: the foreign edit landed in the local text: ${show(mid.applyText)}`);
    assert(mid.hasSend && mid.hasWait, "S3: both local operators are still held after the rebase");
    assert(mid.applyText.length > 0 && mid.applyText !== mid.baseText, "S3: the local typing survived");

    settle([a, b], false);
    assert(a.send(), "S3: the promoted operator can be sent");
    settle([a, b], false);

    expectConverged([a, b], server, "S3");
    assert(server.content.includes("-A") && server.content.includes("-B"), `S3: both edits survive: ${show(server.content)}`);
    if (a.state.getState().desynced) {
        dump(a);
    }
}

/**
 * S4: typing that was never calculated must not be thrown away by a receive.
 */
function scenario4() {
    console.log("\nS4 un-calculated typing survives a receive");
    const server = new Server("helloworld");
    const a = new Client("A", server);
    const b = new Client("B", server);
    a.init();
    b.init();

    b.type("Bhelloworld");
    b.calc();
    b.send();

    a.type("Zhello"); // typed, never calculated
    settle([a, b], false);

    assert(a.state.getState().applyText.includes("Zhello"), `S4: the un-calculated typing survived: ${show(a.state.getState().applyText)}`);

    assert(a.send(), "S4: the folded operator can be sent");
    settle([a, b], false);
    expectConverged([a, b], server, "S4");
    assert(
        server.content.startsWith("B") && server.content.includes("Zhello"),
        `S4: both edits survive: ${show(server.content)}`,
    );

    if (a.state.getState().desynced) {
        dump(a);
    }
}

/** S5: a frame that was already consumed is skipped, not applied twice. */
function scenario5() {
    console.log("\nS5 stale frame is skipped");
    const server = new Server("helloworld");
    const a = new Client("A", server);
    a.init();

    a.type("Xhelloworld");
    a.calc();
    a.send();
    settle([a]);
    const before = a.state.getState().applyText;

    // The same frame again, as a reconnect or a duplicate delivery would produce.
    a.state.enqueue({ edit: { reversion: 1, operator: [server.ops[0].toJSON()] } });
    const result = a.state.consumePending(a.textarea);

    assert(result.ok, "S5: a stale frame is not an error");
    assert(a.state.getState().applyText === before, "S5: the text is unchanged");
    assert(a.state.getState().receiveReversion === 1, "S5: the revision did not move");
}

/** S6: an operation that does not fit the document is rejected, not applied. */
function scenario6() {
    console.log("\nS6 operation that does not fit is rejected");
    const server = new Server("helloworld");
    const a = new Client("A", server);
    a.init();
    const before = a.state.getState().applyText;

    // 99 bytes of retain cannot describe an edit of a 10 byte document.
    a.state.enqueue({ edit: { reversion: 1, operator: [{ ops: [99], reversion: 0 }] } });
    const result = a.state.consumePending(a.textarea);
    const after = a.state.getState();

    assert(!result.ok, "S6: the frame is reported as failed");
    assert(after.applyText === before && after.baseText === before, "S6: nothing was applied");
    assert(after.desynced, "S6: the session is reported as desynced");
}

/** S7: sends are refused when nothing is held or when the operator is in flight. */
function scenario7() {
    console.log("\nS7 send guards");
    const server = new Server("helloworld");
    const a = new Client("A", server);
    a.init();

    assert(a.state.buildSendMessage() === null, "S7: nothing to send before a calculation");

    a.type("helloworld");
    a.calc();
    assert(a.state.getState().hasSend === false, "S7: an empty diff holds no operator");

    a.type("Xhelloworld");
    a.calc();
    a.send();
    const wire = a.state.getState();
    assert(wire.dispatched, "S7: the operator is marked as sent");
    assert(a.state.buildSendMessage() !== null, "S7: the operator is still held, but dispatching it again is the UI's guard");
}

/**
 * S8: both clients make the *same* edit concurrently.
 *
 * This is the one case the echo test cannot separate by identity: B's
 * operation claims the same base and carries the same atoms as the one A sent,
 * so A reads it as its own echo. Both clients still have to end up on the server
 * document, which holds both insertions.
 */
function scenario8() {
    console.log("\nS8 identical concurrent edits (echo is ambiguous)");
    const server = new Server("helloworld");
    const a = new Client("A", server);
    const b = new Client("B", server);
    a.init();
    b.init();

    b.type("Xhelloworld");
    b.calc();
    b.send();

    a.type("Xhelloworld");
    a.calc();
    a.send();

    settle([a, b], false);
    expectConverged([a, b], server, "S8");
    assert(server.content === "XXhelloworld", `S8: the server keeps both insertions: ${show(server.content)}`);

    if (a.state.getState().desynced || b.state.getState().desynced) {
        dump(a);
        dump(b);
    }
}

/**
 * S9: two foreign operations arrive while both local slots are occupied, one of
 * them from the client whose operation is already in flight.
 */
function scenario9() {
    console.log("\nS9 two foreign operations against two held operators");
    const server = new Server("helloworld");
    const a = new Client("A", server);
    const b = new Client("B", server);
    a.init();
    b.init();

    a.type("helloworld-A");
    a.calc();
    a.send();

    b.type("Bhelloworld");
    b.calc();
    b.send();
    settle([b], false);

    // B appends to what it is looking at, which by now contains A's edit.
    b.type(b.textarea + "-B");
    b.calc();
    b.send();

    // A keeps editing while its first operator is on its way.
    a.type(a.textarea + "-A");
    a.calc();

    settle([a, b], false);
    assert(a.state.getState().receiveReversion === 3, "S9: A consumed three operations");
    assert(a.state.getState().hasSend && !a.state.getState().dispatched, "S9: A's waiting operator was promoted");

    assert(a.send(), "S9: the promoted operator can be sent");
    settle([a, b], false);
    expectConverged([a, b], server, "S9");
    assert(
        server.content.length === "helloworld".length + 7 && server.content.startsWith("B") && server.content.includes("-B"),
        `S9: every edit survived: ${show(server.content)}`,
    );

    if (a.state.getState().desynced) {
        dump(a);
    }
}

/* -------------------------------------------------------------------------- */
/* The pseudocode, transcribed literally                                       */
/* -------------------------------------------------------------------------- */

/**
 * The task's pseudocode as a client, run against the same mock server.
 *
 * This exists to demonstrate the defects the corrected client fixes: the
 * scenarios below are the same traces as S1/S2, and each one is expected to end
 * with the client disagreeing with the server (or with no way to continue).
 *
 * Two readings were possible and the charitable one is used: `send_reversion` is
 * the revision the operator will *occupy* (base + 1), so the frame carries
 * `send_reversion - 1`, which is the base `Ot.applyEdit` consumes.
 */
class PseudoClient {
    /** @param {string} name @param {Server} server */
    constructor(name, server) {
        this.name = name;
        this.server = server;
        this.conn = new Conn(server, name);
        this.applyText = "";
        this.receiveReversion = 0;
        this.sendOperator = null;
        this.sendReversion = -1;
        this.waitOperator = null;
        this.problem = null;
        /** @type {string[]} */
        this.log = [];
    }

    init() {
        const frame = this.conn.initFrame();
        this.applyText = frame.init.content;
        this.receiveReversion = frame.init.reversion;
        this.conn.reversion = this.server.reversion;
    }

    /** 点击 calculate operator */
    calc(input) {
        const [operator] = calculateOperator(this.applyText, input, this.receiveReversion);
        this.applyText = input;
        if (this.receiveReversion >= this.sendReversion) {
            this.sendOperator = operator;
            this.sendReversion = this.receiveReversion + 1;
        } else {
            this.waitOperator = operator;
        }
        this.log.push(`calculate: send_reversion=${this.sendReversion} wait=${this.waitOperator ? "set" : "nil"}`);
    }

    /** 点击 send operator @returns whether something was actually sent */
    send() {
        if (!this.sendOperator) {
            this.log.push("send: send_operator is nil, nothing to send");
            return false;
        }
        this.server.applyEdit({ reversion: this.sendReversion - 1, operator: this.sendOperator.toOperatorField() });
        this.log.push(`send: base=${this.sendReversion - 1} ${formatOperator(this.sendOperator)}`);
        return true;
    }

    /** 点击 receive_reversion, one operation at a time */
    receive(frame) {
        const resultOperator = Operator.fromJSON(frame.edit.operator[0]);
        const resultReversion = frame.edit.reversion;

        if (resultReversion <= this.receiveReversion) {
            this.problem = `result_reversion ${resultReversion} <= receive_reversion ${this.receiveReversion}`;
            return false;
        }

        if (resultReversion === this.sendReversion) {
            this.log.push(`receive: revision ${resultReversion} == send_reversion, treating it as our own echo`);
            this.sendOperator = this.waitOperator;
            this.sendReversion = resultReversion + 1;
            this.sendOperator = null; // as written: the promoted operator is dropped
            return true;
        }

        let applied = resultOperator;
        if (this.receiveReversion < this.sendReversion) {
            if (!this.sendOperator) {
                this.problem = "transform(result_operator, nil): send_reversion says in flight, send_operator is nil";
                return false;
            }
            [applied] = applied.transform(this.sendOperator);
            if (this.waitOperator) {
                let nextWait;
                [applied, nextWait] = applied.transform(this.waitOperator);
                this.waitOperator = nextWait;
            }
        }

        this.applyText = applied.apply(this.applyText);
        this.receiveReversion = resultReversion;
        return true;
    }

    consume() {
        while (this.conn.queue.length > 0) {
            const frame = this.conn.queue.shift();
            if (!this.receive(frame)) {
                return false;
            }
        }
        return true;
    }

    dump() {
        for (const entry of this.log) {
            console.log("    " + entry);
        }
        console.log(`    state: apply_text=${show(this.applyText)} receive_reversion=${this.receiveReversion} problem=${show(this.problem)}`);
    }
}

/** P1: the trace of S2 - a foreign operation takes the revision A predicted. */
function pseudo1() {
    console.log("\nP1 pseudocode: foreign operation at the predicted revision");
    const server = new Server("helloworld");
    const a = new PseudoClient("PA", server);
    const b = new PseudoClient("PB", server);
    a.init();
    b.init();

    b.calc("helloworld-B");
    b.send();

    a.calc("Ahelloworld");
    assert(a.sendReversion === 1, "P1: the pseudocode predicts revision 1 for its own operation");
    a.send();

    for (const client of [a, b]) {
        client.conn.pushHistory(false);
        client.consume();
    }

    console.log(`    server=${show(server.content)}  PA=${show(a.applyText)}  PB=${show(b.applyText)}`);
    a.dump();
    assert(a.applyText !== server.content, "P1: the pseudocode diverges from the server (B's edit was read as an echo and dropped)");
    assert(a.receiveReversion === 0, "P1: the echo branch never advanced receive_reversion");
}

/** P2: the trace of S1 - three calculations, then send, then the echo. */
function pseudo2() {
    console.log("\nP2 pseudocode: three stacked calculations");
    const server = new Server("helloworld");
    const a = new PseudoClient("PA", server);
    a.init();

    a.calc("Xhelloworld");
    a.calc("XYhelloworld");
    a.calc("XYZhelloworld");
    a.send();

    a.conn.pushHistory(false);
    a.consume();

    const sent = a.send();
    console.log(`    server=${show(server.content)}  PA=${show(a.applyText)}`);
    a.dump();
    assert(a.applyText !== server.content, "P2: the local text and the server document differ");
    assert(sent === false, "P2: after the echo there is nothing left to send, the buffered edit is gone");
}

/** P3: pressing "send operator" twice puts the same operator on the wire twice. */
function pseudo3() {
    console.log("\nP3 pseudocode: the same operator sent twice");
    const server = new Server("helloworld");
    const a = new PseudoClient("PA", server);
    a.init();

    a.calc("Xhelloworld");
    a.send();
    a.send();

    console.log(`    server=${show(server.content)}`);
    assert(server.content === "XXhelloworld", "P3: the edit is applied twice, because send has no dispatched guard");
}

/* -------------------------------------------------------------------------- */

for (const scenario of [
    scenario1,
    () => scenario2(false),
    () => scenario2(true),
    scenario3,
    scenario4,
    scenario5,
    scenario6,
    scenario7,
    scenario8,
    scenario9,
    pseudo1,
    pseudo2,
    pseudo3,
]) {
    scenario();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exitCode = 1;
}

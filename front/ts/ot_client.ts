/**
 * Client side of the OT protocol: the wire messages the Go backend exchanges
 * with the browser, plus the state machine the three buttons of the edit area
 * drive.
 *
 * WIRE MESSAGES (see `../protocol/message.go` and `../protocol/operator.go`)
 *
 *  - the first frame the server reads from a fresh socket is a
 *    `ClientInitMessage` (`{"user_id":..., "user_name":...}`), consumed by
 *    `api.otHandler` before the connection is handed to a `Connection`;
 *  - later frames are `ClientMessage` = `{"edit": {"reversion": n, "operator": [...]}}`,
 *    where `operator` is the **bare atom array** `protocol.Operator.UnmarshalJSON`
 *    expects (an insert is a string, a retain a positive number, a delete a
 *    negative number). `reversion` is the revision the atoms are **based on** -
 *    the number of operations the client has already applied: `handlerMessage`
 *    copies it onto the operator and `Ot.applyEdit` then transforms the operator
 *    against `o.Ops[reversion:]`. Sending the *landing* revision (base + 1)
 *    instead makes the server skip exactly one history operation, so the base
 *    revision is what goes on the wire;
 *  - the server answers with `ServerMessage`, which carries exactly one of
 *    `init` or `edit`:
 *      * `init`: `{reversion, content, user_id, users}` - the whole document at
 *        the moment the socket joined;
 *      * `edit`: `{reversion, operator: [op, op, ...]}` - the operations this
 *        socket has not seen yet, oldest first, where `reversion` is the revision
 *        the last of them produced. Every element is a *whole* operator
 *        (`{ops, reversion, id}`) as `Ot.applyEdit` stored it, i.e. already
 *        rebased onto all older history. Its `id` is `protocol.Operator.UserID`,
 *        stamped by `handlerMessage` from the socket the edit arrived on: it is
 *        how a client recognizes its own operation in the broadcast. Its
 *        `reversion` field is the base the author claimed, which `Transform`
 *        copies along - an author hint, not the operator's position.
 *
 * LOCAL STATE - the task's pseudocode, name by name
 *
 *   apply_text        `applyText`      the local text: what the textarea shows and
 *                                      what a server operation is merged into
 *   receive_reversion `reversion`      the server revision `baseText` is valid at
 *   send_operator     `sendOperator`   what "send operator" puts on the wire, and
 *                                      afterwards the operator awaiting its echo
 *   send_reversion    `sendReversion`  the revision it will occupy, i.e. base + 1
 *   wait_operator     `waitOperator`   what was calculated while one was already
 *                                      on its way
 *
 * Everything rests on one invariant, re-checked by `checkInvariant()` after every
 * server operation:
 *
 *     applyText === apply(waitOperator, apply(sendOperator, baseText))
 *
 * so the local text is always "the server document plus the two unconfirmed
 * operators, in the order they will reach the server". `baseText` is the server
 * document at `receiveReversion`; `sendOperator` is always based on the *current*
 * `baseText` (`transform` returns both halves precisely so the sent one can be
 * rebased too) and `waitOperator` on the document `sendOperator` produces.
 *
 * WHERE THIS DIFFERS FROM THE PSEUDOCODE
 *
 * The structure is the pseudocode's; the following points are corrections, each
 * one of them a defect that would corrupt or lose text. They are numbered so the
 * analysis next to this file can be read side by side with the code.
 *
 *  1. "calculate operator" does not bump `send_reversion` and does not mark
 *     anything as in flight. The slot is chosen by asking whether a
 *     `sendOperator` is held, so a second press before "send operator" buffers
 *     into `waitOperator` instead of pretending the first operator is already on
 *     its way (and a `receive` between the two presses cannot make the operator
 *     stale, because nothing was sent yet).
 *  2. The echo branch promotes `waitOperator` into `sendOperator` and clears the
 *     wait slot; the pseudocode's trailing `send_operator <- nil` dropped the
 *     buffered edit on the floor - and it is exactly the case "the operator I was
 *     waiting for is confirmed and something else is buffered", i.e. the only
 *     case where the promotion matters.
 *  3. `receive_reversion` advances on **every** server operation, echo included.
 *     Not advancing it makes the queue guard reject every later frame and leaves
 *     the next "calculate" thinking the sent operator is still unconfirmed.
 *  4. An operation is ours when **the author says so**: `result_operator.id ==
 *     userId` is the test, exactly as in the pseudocode. The revision comparison
 *     the pseudocode uses instead (`result_reversion == send_reversion`) is only
 *     a cross-check, because a *foreign* operation can occupy the revision we
 *     predicted - and our own operation then lands one revision later, so
 *     equality would both swallow a foreign edit and miss our own echo.
 *     `ownOperation()` reports which rule matched, and falls back to
 *     reconstructing identity when the id is empty: the backend's `Transform`
 *     builds its results without copying `UserID`, so any operator that had to be
 *     rebased onto history comes back without an author. Clearing that up is a
 *     one-line change in `protocol/operator.go` (`aPrime := &Operator{...,
 *     UserID: aOp.UserID}`).
 *  5. Both halves of every `transform` are kept *and the arguments are passed in
 *     the server's order* (`heldOperator.transform(arrivingOperator)`, mirroring
 *     `Ot.applyEdit`'s `incoming.Transform(&historyOper)`): the first half is our
 *     operator rebased onto the arriving one - the version the server will store -
 *     and the second is the arriving operation rebased onto ours, which is what
 *     the local text absorbs. The order is not cosmetic: `Transform` gives its
 *     *second* operand the earlier slot when both insert at the same position, so
 *     swapping the arguments makes two concurrent insertions merge in the
 *     opposite order locally and in the history.
 *  6. `transform` is never called with a null operand and never called at all
 *     when nothing is held; when it throws (the backend branch that reports
 *     "unsupport operator") the frame goes back to the queue and the state is
 *     reported as desynced instead of being half-updated.
 *  7. Every incoming operation is checked against the document it claims to
 *     transform: `Operator.apply` silently truncates when an atom runs past the
 *     end, so an operation whose base length does not match is rejected rather
 *     than applied.
 *  8. A frame that is stale (`reversion <= receiveReversion`) is skipped with a
 *     note instead of being applied at the wrong position.
 *  9. A held operator is dispatched exactly once: `markSent()` sets `dispatched`,
 *     the send button refuses a second press while it is set, and an empty diff
 *     leaves the slot empty so there is nothing to dispatch at all. The
 *     pseudocode has neither guard, and pressing send twice puts the same
 *     operator on the wire twice, which the server applies twice.
 * 10. A `waitOperator` is recomputed as the difference between the document it is
 *     based on and the textarea, instead of the difference between the *local*
 *     text and the textarea. The pseudocode's version makes the second
 *     "calculate" press describe a document the operator will never be sent
 *     against.
 * 11. `applyText` only moves once the diff succeeded, and typing that was never
 *     calculated is folded in before a server operation is merged (otherwise the
 *     textarea is overwritten with the older `applyText` and the typing is lost).
 */

import {
    Operator,
    TypeOperator,
    retain,
    remove,
    insert,
    encodeText,
    utf8Length,
    type Insert,
    type Delete,
    type OperatorAtomic,
    type Retain,
    type OperatorOpJson,
} from "./ot.js";

/**
 * Control character used to separate the fields of a log line.
 *
 * Log lines are split on this character by `writeLog` in `index.ts`, which
 * renders the pieces as separate aligned cells. It stays invisible inside a
 * message, so lines that carry no separator keep working.
 */
export const SEP = "\u0001";

/** Build one log line out of its fields. */
function line(...fields: string[]): string {
    return fields.join(SEP);
}

/* -------------------------------------------------------------------------- */
/* Wire types                                                                  */
/* -------------------------------------------------------------------------- */

/** `protocol.ClientInitMessage`; must be the first frame on a new socket. */
export interface ClientInitMessage {
    user_id: string;
    user_name: string;
}

/** `protocol.ClientEditMsg`; one client operator based on `reversion`. */
export interface ClientEditMsg {
    reversion: number;
    operator: OperatorOpJson[];
}

/** `protocol.ClientMessage`; a client frame carries at most one edit. */
export interface ClientMessage {
    edit?: ClientEditMsg;
}

/** An operator as the server writes it: `ops`, `reversion` and the author `id`. */
export interface ServerOperatorJson {
    ops: OperatorOpJson[];
    reversion: number;
    /** `protocol.Operator.UserID`; empty when the backend rebased the operator. */
    id?: string;
}

/** `protocol.ServerEditMsg`; a batch of whole operators, oldest first. */
export interface ServerEditMsg {
    reversion: number;
    operator: ServerOperatorJson[] | null;
}

/** `protocol.ServerInitMsg`; the document as it looked when the socket joined. */
export interface ServerInitMsg {
    reversion: number;
    content: string;
    user_id: string;
    users: unknown[] | null;
}

/** `protocol.ServerMessage`; `edit` and `init` are mutually exclusive. */
export interface ServerMessage {
    edit?: ServerEditMsg | null;
    init?: ServerInitMsg | null;
}

/* -------------------------------------------------------------------------- */
/* Diff                                                                        */
/* -------------------------------------------------------------------------- */

/** One aligned chunk of a diff: what changed, in one or both texts. */
export interface DiffChunk {
    /** Byte count carried over from the old text. */
    retain: number;
    /** Bytes dropped from the old text. */
    remove: number;
    /** Text added in place of the dropped bytes. */
    insert: string;
}

/**
 * Longest common prefix of `a` and `b`, measured in code points so that a
 * surrogate pair always stays whole and can be sliced back out of either string.
 */
function commonPrefixLength(a: string, b: string): number {
    const limit = Math.min(a.length, b.length);
    let i = 0;

    while (i < limit) {
        const ca = a.codePointAt(i) as number;
        const cb = b.codePointAt(i) as number;
        if (ca !== cb) {
            break;
        }
        i += ca > 0xffff ? 2 : 1;
    }

    return i;
}

/**
 * Longest common suffix of `a` and `b`, counted in UTF-16 code units but always
 * landing on a code point boundary.
 *
 * @param prefix how much of each text the prefix already claimed: the two halves
 *   must not overlap, or an insertion would be counted as retained text.
 */
function commonSuffixLength(a: string, b: string, prefix: number): number {
    const limit = Math.min(a.length, b.length) - prefix;
    let i = 0;

    // Walk backwards over whole code points: 0xDC00-0xDFFF is a low surrogate,
    // so stepping back over one must step back over its pair as well.
    while (i < limit) {
        const ca = a.charCodeAt(a.length - i - 1);
        const cb = b.charCodeAt(b.length - i - 1);
        if (ca !== cb) {
            break;
        }
        i += ca >= 0xdc00 && ca <= 0xdfff ? 2 : 1;
    }

    return i;
}

/**
 * Diff two texts into the three atom kinds the protocol knows.
 *
 * The common prefix and suffix are retained and everything between them is
 * dropped and re-inserted; nothing that changes nothing is emitted, and the
 * leading retain is folded into the change chunk, so an edit reads as one
 * aligned `Retain / Insert / Delete` list.
 *
 * @param oldText confirmed text the operator is based on
 * @param newText text the user edited it into
 * @returns the aligned chunks; an empty array means the two texts are equal.
 *   Every chunk carries byte counts, never code-unit counts, because an
 *   operator's positions are UTF-8 byte offsets on the Go side. The chunks cover
 *   the whole of `oldText`, which `Operator.apply` relies on.
 * @throws when a text carries an unpaired surrogate, which has no UTF-8 form and
 *   so cannot be described to the backend.
 */
export function diffText(oldText: string, newText: string): DiffChunk[] {
    if (utf8Length(oldText) !== encodeText(oldText).length || utf8Length(newText) !== encodeText(newText).length) {
        throw new Error("text contains an unpaired surrogate, so its UTF-8 byte length is undefined");
    }

    const prefix = commonPrefixLength(oldText, newText);
    const suffix = commonSuffixLength(oldText, newText, prefix);

    const retainedHead = utf8Length(oldText.slice(0, prefix));
    const retainedTail = utf8Length(oldText.slice(oldText.length - suffix));
    const dropped = utf8Length(oldText.slice(prefix, oldText.length - suffix));
    const added = newText.slice(prefix, newText.length - suffix);

    if (dropped === 0 && added.length === 0) {
        return [];
    }

    const chunks: DiffChunk[] = [{ retain: retainedHead, remove: dropped, insert: added }];
    if (retainedTail > 0) {
        chunks.push({ retain: retainedTail, remove: 0, insert: "" });
    }

    return chunks;
}

/** Turn diff chunks into an operator based on `reversion`; skips empty atoms. */
export function chunksToOperator(chunks: DiffChunk[], reversion: number): Operator {
    const ops: OperatorAtomic[] = [];

    for (const chunk of chunks) {
        if (chunk.retain > 0) {
            ops.push(retain(chunk.retain));
        }
        if (chunk.remove > 0) {
            ops.push(remove(chunk.remove));
        }
        if (chunk.insert.length > 0) {
            ops.push(insert(chunk.insert));
        }
    }

    return new Operator(ops, reversion);
}

/**
 * Diff `oldText` into `newText` and describe the change as an operator based on
 * `reversion`.
 *
 * @returns `[operator, chunks]`; the chunks are what the human readable log
 *   shows, the operator is what goes on the wire.
 */
export function calculateOperator(oldText: string, newText: string, reversion: number): [Operator, DiffChunk[]] {
    const chunks = diffText(oldText, newText);
    return [chunksToOperator(chunks, reversion), chunks];
}

/* -------------------------------------------------------------------------- */
/* Operator helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Bytes a single atom contributes to its own operator's text. */
function atomSize(atom: OperatorAtomic): number {
    return atom.type === TypeOperator.Insert ? utf8Length(atom.str) : atom.n;
}

/** Bytes an operator consumes from its base: retains plus deletes. */
export function operatorInputBytes(operator: Operator): number {
    let total = 0;
    for (const atom of operator.ops) {
        if (atom.type !== TypeOperator.Insert) {
            total += atom.n;
        }
    }
    return total;
}

/** Bytes an operator contributes to its result: retains plus inserts. */
export function operatorOutputBytes(operator: Operator): number {
    let total = 0;
    for (const atom of operator.ops) {
        total += atomSize(atom);
    }
    return total;
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

/** Render an operator as `Retain(5) Delete(2) Insert("hi")`. */
export function formatOperator(operator: Operator): string {
    if (operator.ops.length === 0) {
        return "(empty)";
    }

    return operator.ops
        .map((atom) => {
            switch (atom.type) {
                case TypeOperator.Retain:
                    return `Retain(${(atom as Retain).n})`;
                case TypeOperator.Delete:
                    return `Delete(${(atom as Delete).n})`;
                default:
                    return `Insert(${JSON.stringify((atom as Insert).str)})`;
            }
        })
        .join(" ");
}

/** Render diff chunks the same way, for the log of "calculate operator". */
export function formatChunks(chunks: DiffChunk[]): string {
    return formatOperator(chunksToOperator(chunks, 0));
}

/** Render an operator's wire form, the way "send operator" puts it on the socket. */
export function formatOperatorJson(operator: Operator): string {
    return JSON.stringify(operator.toOperatorField());
}

/** Shorten a user id for the log; a full UUID drowns the rest of the line. */
function shortId(userId: string): string {
    return userId.length > 8 ? userId.slice(0, 8) : userId;
}

/* -------------------------------------------------------------------------- */
/* Client state                                                                */
/* -------------------------------------------------------------------------- */

/** A server frame that arrived but was not consumed yet. */
export interface PendingFrame {
    /** A short label for the log, e.g. `edit#3`. */
    label: string;
    /** The frame as it came off the socket. */
    message: ServerMessage;
}

/** Snapshot of the local state, handy for logs and for the demo UI. */
export interface ClientState {
    /** Server document, valid at `receiveReversion`. */
    baseText: string;
    /** Local text: `baseText` with `sendOperator` and `waitOperator` applied. */
    applyText: string;
    /** Revision `baseText` is valid at; the base the next send claims. */
    receiveReversion: number;
    /** Revision the held operator is expected to occupy, -1 when none is held. */
    sendReversion: number;
    /** Whether the held operator already went on the wire. */
    dispatched: boolean;
    /** Whether a `sendOperator` is held, i.e. whether "send operator" has work. */
    hasSend: boolean;
    /** Whether a `waitOperator` is held. */
    hasWait: boolean;
    /** The `user_id` this client identifies its own operations by. */
    userId: string;
    /** Server frames waiting for "receive operator". */
    queued: number;
    /** Set when an operation could not be merged; only a re-link clears it. */
    desynced: boolean;
}

/** Outcome of one action, so the UI can log it without guessing. */
export interface ActionResult {
    ok: boolean;
    /** Lines to append to the log. */
    lines: string[];
    /** Set when the action failed; the reason is also the last log line. */
    error?: string;
}

/** Shorthand for a successful action. */
function ok(...lines: string[]): ActionResult {
    return { ok: true, lines };
}

/** Shorthand for a failed action. */
function fail(...lines: string[]): ActionResult {
    return { ok: false, lines, error: lines[lines.length - 1] };
}

/** Outcome of consuming one server operation or one frame. */
interface Step {
    lines: string[];
    ok: boolean;
    /** Operations of the frame that were consumed; the rest goes back to the queue. */
    consumed: number;
}

/**
 * The local half of the OT session.
 *
 * It owns the texts, the revision counters and the queue of delayed server
 * frames; it performs no I/O and touches no DOM, so the buttons in `index.ts`
 * stay a thin layer over it.
 */
export class OtClient {
    /** Server document, valid at `reversion`; what a local diff is computed against. */
    private baseText = "";

    /** Local text: `baseText` with the held operators applied. */
    private applyText = "";

    /** Server revision `baseText` is valid at. */
    private reversion = 0;

    /** `send_operator`: what "send operator" dispatches, then what awaits its echo. */
    private sendOperator: Operator | null = null;

    /** Whether `sendOperator` went on the wire and its echo has not come back. */
    private dispatched = false;

    /** The base revision `sendOperator` was dispatched with, for the echo test. */
    private sentBaseRevision = -1;

    /** `wait_operator`: calculated while `sendOperator` was already on its way. */
    private waitOperator: Operator | null = null;

    /** Server frames received but not consumed; "receive operator" drains them. */
    private queue: PendingFrame[] = [];

    /** Label counter for queued frames. */
    private frameSeq = 0;

    /** Set when an operation could not be merged, so the UI can say "re-link". */
    private desynced = false;

    /**
     * The `user_id` this browser sent in its init message; every operation the
     * server broadcasts under this id is our own, because
     * `Connection.handlerMessage` stamps the socket's user id on the way in.
     */
    private userId = "";

    /**
     * Adopt the identity "send init msg" registered with the server.
     *
     * It survives `reset()`: a re-link keeps the same user id, and it is what
     * makes an operation recognizable as ours without guessing from revisions.
     */
    setUserId(userId: string): void {
        this.userId = userId;
    }

    /** @returns the user id own operations are recognized by. */
    getUserId(): string {
        return this.userId;
    }

    /** @returns the server document, i.e. the base of the next calculation. */
    getBaseText(): string {
        return this.baseText;
    }

    /** @returns the local text, i.e. what the textarea should show. */
    getApplyText(): string {
        return this.applyText;
    }

    /** @returns the revision of the server document. */
    getReceiveReversion(): number {
        return this.reversion;
    }

    /**
     * @returns the revision the held operator will occupy, or -1 when none is
     *   held. This is the pseudocode's `send_reversion`: the held operator is
     *   always based on the current document, so it lands at the first free
     *   revision unless a foreign operation overtakes it.
     */
    getSendReversion(): number {
        return this.sendOperator ? this.reversion + 1 : -1;
    }

    /** @returns the operator "send operator" would dispatch, or null. */
    getSendOperator(): Operator | null {
        return this.sendOperator;
    }

    /** @returns a snapshot of everything a log line may want to print. */
    getState(): ClientState {
        return {
            baseText: this.baseText,
            applyText: this.applyText,
            receiveReversion: this.reversion,
            sendReversion: this.getSendReversion(),
            dispatched: this.dispatched,
            hasSend: this.sendOperator !== null,
            hasWait: this.waitOperator !== null,
            userId: this.userId,
            queued: this.queue.length,
            desynced: this.desynced,
        };
    }

    /* ---------------------------------------------------------------------- */
    /* calculate operator                                                      */
    /* ---------------------------------------------------------------------- */

    /**
     * The document the held operators are based on: `baseText` with the sent
     * operator applied. A new operator belongs on top of exactly this text, which
     * is also the document `waitOperator` is based on.
     */
    private pendingBaseText(): string {
        return this.sendOperator ? this.sendOperator.apply(this.baseText) : this.baseText;
    }

    /** The revision `pendingBaseText()` will be at once the sent operator lands. */
    private pendingBaseReversion(): number {
        return this.sendOperator ? this.reversion + 1 : this.reversion;
    }

    /**
     * Diff `inputText` into the slot it belongs to.
     *
     * @returns the diff, the operator (null when the two texts are equal) and the
     *   slot: `send` while nothing is held, `wait` otherwise.
     */
    private diffInto(inputText: string): { chunks: DiffChunk[]; operator: Operator | null; slot: "send" | "wait" } {
        const slot = this.sendOperator === null ? "send" : "wait";
        const [operator, chunks] = calculateOperator(this.pendingBaseText(), inputText, this.pendingBaseReversion());
        return { chunks, operator: chunks.length > 0 ? operator : null, slot };
    }

    /** Store the diff in its slot and adopt `inputText` as the local text. */
    private commitDiff(slot: "send" | "wait", operator: Operator | null, inputText: string): void {
        // A locally built operator belongs to this client; `toOperatorField()`
        // does not carry the id, so the server stamps it again on the way in, but
        // keeping it here makes the state and the log honest.
        if (operator) {
            operator.userId = this.userId;
        }

        if (slot === "send") {
            this.sendOperator = operator;
            this.dispatched = false;
            this.sentBaseRevision = -1;
        } else {
            this.waitOperator = operator;
        }

        this.applyText = inputText;
    }

    /**
     * `calculate operator`: diff the text the operators are based on against
     * `inputText` and keep the result in the slot "send operator" reads.
     *
     * Nothing is marked as in flight here: the operator only leaves the client
     * when the send button is pressed, and until then the next calculation simply
     * replaces it (or fills the waiting slot).
     *
     * @param inputText the textarea content
     * @returns the log lines describing the diff, plus the operator
     */
    calculate(inputText: string): ActionResult {
        const base = this.pendingBaseText();
        const baseReversion = this.pendingBaseReversion();
        let diff: { chunks: DiffChunk[]; operator: Operator | null; slot: "send" | "wait" };

        try {
            diff = this.diffInto(inputText);
        } catch (err) {
            return fail(line("calculate", "failed: " + String(err)));
        }

        this.commitDiff(diff.slot, diff.operator, inputText);

        const lines = [
            line(
                "calculate",
                `slot=${diff.slot}`,
                `base-revision=${baseReversion}`,
                `base=${utf8Length(base)}B`,
                `input=${utf8Length(inputText)}B`,
            ),
            line("  base ", JSON.stringify(base)),
            line("  input", JSON.stringify(inputText)),
        ];

        if (diff.chunks.length === 0) {
            lines.push(line("  diff ", "none (the text did not change, the slot is cleared)"));
            lines.push(line("  ops  ", "()"));
            return ok(...lines);
        }

        lines.push(line("  diff ", formatChunks(diff.chunks)));
        lines.push(line("  ops  ", formatOperator(diff.operator as Operator)));
        lines.push(line("  wire ", formatOperatorJson(diff.operator as Operator)));
        lines.push(...this.checkInvariant("calculate"));

        return ok(...lines);
    }

    /**
     * Fold typing that was never calculated into the waiting operator, so that a
     * server operation cannot throw it away (deviation 11).
     *
     * This is `calculate` without the log, used by "receive operator" when the
     * textarea no longer matches `applyText`.
     */
    private foldInput(inputText: string): string[] {
        const diff = this.diffInto(inputText);
        this.commitDiff(diff.slot, diff.operator, inputText);

        return [
            line(
                "  fold  ",
                `slot=${diff.slot}`,
                diff.chunks.length === 0 ? "no change" : formatOperator(diff.operator as Operator),
            ),
        ];
    }

    /* ---------------------------------------------------------------------- */
    /* send operator                                                           */
    /* ---------------------------------------------------------------------- */

    /**
     * The frame "send operator" puts on the socket.
     *
     * The atoms carry the revision they are based on, which is the current
     * `receiveReversion`: `handlerMessage` copies `edit.reversion` onto the
     * operator and `Ot.applyEdit` transforms it against every operation that
     * happened after that revision. This is what the pseudocode calls
     * `send_reversion - 1`, and the base is the value the backend can consume.
     *
     * @returns null when nothing is held, or the payload to send.
     */
    buildSendMessage(): { message: ClientMessage; operator: Operator } | null {
        if (!this.sendOperator) {
            return null;
        }

        return {
            message: {
                edit: {
                    reversion: this.reversion,
                    operator: this.sendOperator.toOperatorField(),
                },
            },
            operator: this.sendOperator,
        };
    }

    /**
     * Record that the held operator has been written to the socket.
     *
     * From here on it is "in flight": the echo test may match it, "calculate
     * operator" buffers behind it instead of replacing it, and "send operator"
     * refuses to dispatch it a second time.
     */
    markSent(): void {
        this.dispatched = true;
        this.sentBaseRevision = this.reversion;
    }

    /* ---------------------------------------------------------------------- */
    /* receive operator                                                        */
    /* ---------------------------------------------------------------------- */

    /**
     * Accept one frame from the socket without consuming it.
     *
     * This is what makes the receive side delayed: an edit frame is only queued,
     * and only `consumePending()` turns it into a state change.
     *
     * @param message the frame as parsed JSON
     * @returns the log lines that describe what was queued
     */
    enqueue(message: ServerMessage): ActionResult {
        if (message.init) {
            this.frameSeq += 1;
            const label = `init#${this.frameSeq}`;
            this.queue.push({ label, message });
            return ok(
                line("receive", label, `reversion=${message.init.reversion}`, `queued=${this.queue.length}`),
                line("  content", JSON.stringify(message.init.content)),
                line("  hint   ", 'not applied yet, press "receive operator" to consume'),
            );
        }

        if (message.edit) {
            this.frameSeq += 1;
            const label = `edit#${this.frameSeq}`;
            this.queue.push({ label, message });

            const ops = message.edit.operator ?? [];
            const lines = [
                line(
                    "receive",
                    label,
                    `reversion=${message.edit.reversion}`,
                    `ops=${ops.length}`,
                    `queued=${this.queue.length}`,
                ),
            ];
            for (const [index, raw] of ops.entries()) {
                lines.push(line(`  op[${index}]`, formatOperator(Operator.fromJSON(raw))));
            }
            lines.push(line("  hint   ", 'not applied yet, press "receive operator" to consume'));
            return ok(...lines);
        }

        return fail(line("receive", "ignored: frame has neither init nor edit"));
    }

    /**
     * `receive operator`: consume the queued frames, oldest first, one operation
     * at a time.
     *
     * An `init` frame resets the whole session (document, revision, held
     * operators): everything before it describes a document that no longer
     * exists. Every other frame is replayed operation by operation through
     * `receiveOne()`, which is the pseudocode's "receive_reversion" body.
     *
     * @param textareaText what the textarea shows right now; when it differs from
     *   `applyText` it holds typing that was never calculated, which is folded in
     *   before the first server operation moves the text under it.
     */
    consumePending(textareaText: string): ActionResult {
        if (this.queue.length === 0) {
            return ok(line("consume", "queue is empty, nothing to consume"));
        }

        const lines: string[] = [];

        if (textareaText !== this.applyText) {
            lines.push(line("sync", "textarea differs from apply_text, folding the typing in first"));
            lines.push(...this.foldInput(textareaText));
        }

        const frames = this.queue;
        this.queue = [];

        lines.push(line("consume", `frames=${frames.length}`, `receive=${this.reversion}`));

        let index = 0;
        let failed = false;

        while (index < frames.length) {
            const frame = frames[index];
            const step = frame.message.init
                ? this.consumeInit(frame.label, frame.message.init)
                : frame.message.edit
                    ? this.consumeEdit(frame.label, frame.message.edit)
                    : { lines: [line("  skip", frame.label, "unknown frame")], ok: false, consumed: 0 };

            lines.push(...step.lines);

            if (!step.ok) {
                this.requeue(frame, step.consumed, lines);
                failed = true;
                break;
            }

            index += 1;
        }

        for (const rest of frames.slice(index + (failed ? 1 : 0))) {
            this.queue.push(rest);
            lines.push(line("  requeue", rest.label, "left for the next press"));
        }

        lines.push(this.stateLine("consume", this.reversion));
        return failed ? fail(...lines) : ok(...lines);
    }

    /** Put a frame - or what is left of it - back in the queue. */
    private requeue(frame: PendingFrame, consumed: number, lines: string[]): void {
        const edit = frame.message.edit;
        const ops = edit?.operator ?? [];

        if (edit && consumed > 0 && consumed < ops.length) {
            const rest: PendingFrame = {
                label: frame.label + "#rest",
                message: { edit: { reversion: edit.reversion, operator: ops.slice(consumed) } },
            };
            this.queue.push(rest);
            lines.push(line("  requeue", `${rest.label} (${ops.length - consumed} operation(s))`, "left for the next press"));
            return;
        }

        this.queue.push(frame);
        lines.push(line("  requeue", frame.label, "left for the next press"));
    }

    /** Apply one `init` frame; the server document replaces the local one. */
    private consumeInit(label: string, init: ServerInitMsg): Step {
        const droppedSend = this.sendOperator ? 1 : 0;
        const droppedWait = this.waitOperator ? 1 : 0;

        this.baseText = init.content;
        this.applyText = init.content;
        this.reversion = init.reversion;
        this.sendOperator = null;
        this.waitOperator = null;
        this.dispatched = false;
        this.sentBaseRevision = -1;
        this.desynced = false;

        return {
            consumed: 0,
            ok: true,
            lines: [
                line(
                    `  apply ${label}`,
                    "init",
                    `receive=${this.reversion}`,
                    `base=${utf8Length(this.baseText)}B`,
                ),
                line("    content", JSON.stringify(init.content)),
                line(
                    "    reset  ",
                    `send_operator dropped=${droppedSend}`,
                    `wait_operator dropped=${droppedWait}`,
                    "> server document wins",
                ),
            ],
        };
    }

    /**
     * Replay one `edit` frame: a batch of whole operators, oldest first, each one
     * merged through `receiveOne()`.
     */
    private consumeEdit(label: string, edit: ServerEditMsg): Step {
        const ops = edit.operator ?? [];
        const lines: string[] = [
            line(`  apply ${label}`, `ops=${ops.length}`, `receive=${this.reversion}`, `frame-reversion=${edit.reversion}`),
        ];

        if (ops.length === 0) {
            lines.push(line("    note", "empty batch, nothing to apply"));
            return { lines, ok: true, consumed: 0 };
        }

        // The frame says it produced revision `edit.reversion` while its
        // operations would take us to `receive + ops.length`. A frame we have
        // already consumed is skipped; anything else is reported and then checked
        // operation by operation, because the position of an operation is what
        // makes it applicable at all.
        const expectedEnd = this.reversion + ops.length;
        if (edit.reversion <= this.reversion) {
            lines.push(
                line("    skip  ", `frame reversion ${edit.reversion} <= receive ${this.reversion}`, "already consumed"),
            );
            return { lines, ok: true, consumed: ops.length };
        }
        if (edit.reversion !== expectedEnd) {
            lines.push(
                line("    warn  ", `frame reversion ${edit.reversion}, expected ${expectedEnd}`, "checking operation by operation"),
            );
        }

        for (const [index, raw] of ops.entries()) {
            let remote: Operator;
            try {
                remote = Operator.fromJSON(raw);
            } catch (err) {
                lines.push(line(`    op[${index}]`, "unreadable: " + String(err)));
                this.desynced = true;
                return { lines, ok: false, consumed: index };
            }

            const step = this.receiveOne(index, remote);
            lines.push(...step.lines);
            if (!step.ok) {
                return { lines, ok: false, consumed: index };
            }
        }

        return { lines, ok: true, consumed: ops.length };
    }

    /**
     * Whether `remote` is our own operation coming back, and by which rule.
     *
     * The primary rule is the pseudocode's: `result_operator.id == userId`. The
     * server stamps `protocol.Operator.UserID` from the socket the edit arrived
     * on, so a broadcast carrying our id is our own operation - which means the
     * local text already shows it and it must not be applied again.
     *
     * The revision comparison (`result_reversion == send_reversion`) is *not* a
     * sound test on its own: a foreign operation can occupy the revision we
     * predicted, and our own operation then lands one revision later. It is
     * reported next to the answer instead, so a trace where the prediction was
     * taken over by somebody else is visible.
     *
     * @returns `mine` plus the rule that decided it: `id` (the protocol said so),
     *   `identity` (the id was empty and the base revision plus the predicted
     *   atoms matched), or `none`.
     */
    private ownOperation(remote: Operator): { mine: boolean; by: "id" | "identity" | "none" } {
        if (remote.userId !== "") {
            return { mine: remote.userId === this.userId, by: "id" };
        }

        // `Transform` builds its results without copying `UserID`, so an operator
        // that had to be rebased onto history arrives anonymous. Reconstruct
        // identity from the two things we do know: the base revision our operator
        // claimed, and the document it must have produced.
        //
        // The comparison is on the *effect*, not on the atoms: a rebase of the
        // same operation through two call orders can spell the same edit as
        // `Retain(1) Insert("X") Retain(10)` or `Insert("X") Retain(1) Retain(10)`,
        // and the server's call order is not the client's. Equal effects also mean
        // the local text already holds exactly what the operation did, which is
        // the whole reason a confirmation is not applied.
        if (this.dispatched && this.sendOperator && remote.reversion === this.sentBaseRevision) {
            if (remote.apply(this.baseText) === this.pendingBaseText()) {
                return { mine: true, by: "identity" };
            }
        }

        return { mine: false, by: "none" };
    }

    /**
     * `Operator.apply` copies what the atoms ask for and silently drops the rest,
     * so an operator whose base length does not match the text it is applied to
     * would truncate the document. Check before applying.
     *
     * @returns the new text, or null when the operator does not fit.
     */
    private applyFit(operator: Operator, text: string): string | null {
        if (operatorInputBytes(operator) !== utf8Length(text)) {
            return null;
        }
        return operator.apply(text);
    }

    /**
     * One server operation: the body of the pseudocode's "receive_reversion".
     *
     * @param index position of the operation inside its frame, for the log
     * @param remote the operation, already rebased by the server onto the history
     *   this client has seen, i.e. applicable to `baseText`
     */
    private receiveOne(index: number, remote: Operator): Step {
        const lines: string[] = [];
        const position = this.reversion + 1;

        if (operatorInputBytes(remote) !== utf8Length(this.baseText)) {
            this.desynced = true;
            lines.push(
                line(
                    `    op[${index}]`,
                    "rejected",
                    formatOperator(remote),
                    `consumes ${operatorInputBytes(remote)}B of a ${utf8Length(this.baseText)}B document`,
                ),
                line("    hint  ", "the client and the server disagree: re-link to resync"),
            );
            return { lines, ok: false, consumed: 0 };
        }

        // Our own operation: the local text already shows it, so it is not applied
        // again. What it does do is move the revision on and make the confirmed
        // document the one the waiting operator has been based on all along, which
        // is why the waiting operator is promoted here.
        const ownership = this.ownOperation(remote);

        // The pseudocode's confirmation test, kept as a cross-check: the revision
        // we predicted being taken by somebody else is exactly the trace that
        // makes "the revision decides ownership" unsound.
        const predicted = this.dispatched && position === this.sentBaseRevision + 1;

        if (ownership.mine) {
            const newBase = remote.apply(this.baseText);

            // Only an operation we were actually waiting for confirms the in-flight
            // one and promotes what was buffered behind it. An own operation
            // arriving with nothing in flight (a duplicate delivery) must not
            // disturb the slot the next send uses.
            const confirmed = this.dispatched;
            const promoted = this.waitOperator;

            this.baseText = newBase;
            this.reversion = position;

            if (confirmed) {
                this.sendOperator = promoted;
                this.waitOperator = null;
                this.dispatched = false;
                this.sentBaseRevision = -1;
            }

            lines.push(
                line(
                    `    op[${index}]`,
                    "own operation (confirmation)",
                    `by=${ownership.by}`,
                    `receive=${this.reversion}`,
                    ownership.by === "id" ? `id=${shortId(remote.userId)}` : "id missing, identity reconstructed",
                ),
                line(
                    "    base  ",
                    JSON.stringify(this.baseText),
                    "text unchanged",
                    !confirmed
                        ? "(nothing was in flight)"
                        : this.sendOperator
                            ? `next send=${formatOperator(this.sendOperator)}`
                            : "nothing left to send",
                ),
            );

            if (ownership.by === "identity") {
                lines.push(
                    line(
                        "    note  ",
                        "the operation carries no id",
                        "the backend's Transform does not copy UserID",
                        "identity reconstructed from the base revision and the atoms",
                    ),
                );
            }

            // A misclassified operation (a foreign edit read as ours) would leave
            // the local text out of step with the confirmed document, which is
            // exactly what this check looks for; it repairs and reports.
            lines.push(...this.checkInvariant("confirmation"));

            return { lines, ok: true, consumed: 1 };
        }

        if (predicted) {
            lines.push(
                line(
                    `    op[${index}]`,
                    "another author took the revision we predicted",
                    `id=${remote.userId ? shortId(remote.userId) : "(none)"}`,
                    "our own operation will land later",
                ),
            );
        }

        // A foreign operation. The local text already contains every held
        // operator, so the operation has to travel past them before it can be
        // applied - and both halves of each transform are kept.
        //
        // THE ARGUMENT ORDER MATTERS, and it has to mirror the server's:
        // `Ot.applyEdit` rebases an arriving operator as
        // `incoming.Transform(&historyOper)`, i.e. the operation being rebased is
        // the receiver and the one it is rebased onto is the argument. When two
        // clients insert at the same position the transform gives its *second*
        // operand the earlier slot (see the insert branch of
        // `Operator.transform`), so calling it the other way round orders the two
        // insertions differently from the server: the confirmed document and the
        // local text disagree ("helloworld12" against "helloworld21" in the
        // harness scenario S10) even though both sides think they converged.
        let localOp = remote;
        let sendPrime = this.sendOperator;
        let waitPrime = this.waitOperator;

        if (sendPrime) {
            const transformed = this.tryTransform(sendPrime, localOp);
            if (!transformed) {
                this.desynced = true;
                return { lines: [...lines, ...this.transformFailedLines(index, sendPrime, localOp)], ok: false, consumed: 0 };
            }
            // `[0]` is our operator rebased onto the arriving one - exactly what the
            // server stores when our operator reaches it. `[1]` is the arriving
            // operation rebased onto ours - what the local text absorbs.
            sendPrime = transformed[0];
            localOp = transformed[1];
            sendPrime.reversion = position;
        }

        if (waitPrime) {
            const transformed = this.tryTransform(waitPrime, localOp);
            if (!transformed) {
                this.desynced = true;
                return { lines: [...lines, ...this.transformFailedLines(index, waitPrime, localOp)], ok: false, consumed: 0 };
            }
            waitPrime = transformed[0];
            localOp = transformed[1];
            waitPrime.reversion = position + 1;
        }

        const newBase = remote.apply(this.baseText);
        const newApply = this.applyFit(localOp, this.applyText);
        if (newApply === null) {
            this.desynced = true;
            lines.push(
                line(
                    `    op[${index}]`,
                    "rejected",
                    "the operation does not fit the local text after the rebase",
                    `consumes ${operatorInputBytes(localOp)}B of ${utf8Length(this.applyText)}B`,
                ),
                line("    hint  ", "the client and the server disagree: re-link to resync"),
            );
            return { lines, ok: false, consumed: 0 };
        }

        this.baseText = newBase;
        this.applyText = newApply;
        this.sendOperator = sendPrime;
        this.waitOperator = waitPrime;
        this.reversion = position;

        lines.push(
            line(
                `    op[${index}]`,
                formatOperator(remote),
                `receive=${this.reversion}`,
                `base=${utf8Length(this.baseText)}B`,
            ),
            line("    rebase", `send_operator -> ${sendPrime ? formatOperator(sendPrime) : "(none)"}`),
            line("    rebase", `wait_operator -> ${waitPrime ? formatOperator(waitPrime) : "(none)"}`),
            line("    text  ", JSON.stringify(this.baseText)),
        );
        lines.push(...this.checkInvariant("rebase"));

        return { lines, ok: true, consumed: 1 };
    }

    /** Transform two operations based on the same document, or null on failure. */
    private tryTransform(a: Operator, b: Operator): [Operator, Operator] | null {
        try {
            return a.transform(b);
        } catch {
            // The backend answers "unsupport operator" for the same pair; there is
            // no result that would converge, so the caller stops instead of
            // guessing.
            return null;
        }
    }

    /** Log lines for a transform the two operations cannot survive. */
    private transformFailedLines(index: number, a: Operator, b: Operator): string[] {
        return [
            line(
                `    op[${index}]`,
                "cannot be merged with the local operator",
                formatOperator(a),
                "vs",
                formatOperator(b),
            ),
            line("    hint  ", "the two operators are not compatible: re-link to resync"),
        ];
    }

    /**
     * The local text must stay equal to the document plus the two held
     * operators. When it does not, the client and the server rebased the same
     * operations differently - the local text is the user's intent, so it is kept
     * and the waiting operator is re-derived from it (deviation from "trust the
     * transforms blindly", reported loudly because it means a diverging
     * `Transform`).
     */
    private checkInvariant(tag: string): string[] {
        const composed = this.waitOperator
            ? this.waitOperator.apply(this.pendingBaseText())
            : this.pendingBaseText();

        if (composed === this.applyText) {
            return [];
        }

        const chunks = diffText(this.pendingBaseText(), this.applyText);
        this.waitOperator = chunks.length > 0 ? chunksToOperator(chunks, this.pendingBaseReversion()) : null;

        return [
            line(
                "    warn  ",
                `apply_text != base + send + wait (${tag})`,
                "client and server transforms disagreed",
            ),
            line(
                "    repair",
                "wait_operator re-derived from the local text:",
                this.waitOperator ? formatOperator(this.waitOperator) : "(empty)",
            ),
        ];
    }

    /* ---------------------------------------------------------------------- */
    /* helpers for the UI                                                      */
    /* ---------------------------------------------------------------------- */

    /**
     * The text the textarea should show: the confirmed document with everything
     * unconfirmed applied on top.
     */
    renderText(): string {
        return this.applyText;
    }

    /**
     * Discard the local state and adopt `content` as the confirmed document -
     * used when the socket is (re)linked or an init message arrived.
     */
    reset(content: string, reversion: number): void {
        this.baseText = content;
        this.applyText = content;
        this.reversion = reversion;
        this.sendOperator = null;
        this.waitOperator = null;
        this.dispatched = false;
        this.sentBaseRevision = -1;
        this.queue = [];
        this.frameSeq = 0;
        this.desynced = false;
    }

    /** Format a `key=value` state summary; also used by the UI after an action. */
    stateLine(tag: string, reversion?: number): string {
        const state = this.getState();
        const rev = reversion === undefined ? state.receiveReversion : reversion;
        return line(
            tag,
            `receive=${rev}`,
            `send=${state.sendReversion}`,
            `user=${state.userId ? shortId(state.userId) : "(none)"}`,
            `send_operator=${state.hasSend ? (state.dispatched ? "sent" : "ready") : "none"}`,
            `wait_operator=${state.hasWait ? "held" : "none"}`,
            `queued=${state.queued}`,
            `desync=${state.desynced ? "yes" : "no"}`,
        );
    }

    /** The label of the batch that "receive operator" will apply next. */
    peekNextFrame(): string | null {
        return this.queue.length > 0 ? this.queue[0].label : null;
    }
}

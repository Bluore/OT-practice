/**
 * Operational Transformation core.
 *
 * Ported from the backend implementation at `../protocol/operator.go` (the Go
 * module one level above `front/`), so that the browser client and the server
 * share exactly one operator dialect:
 *
 *  - an operator is an ordered list of atoms: `retain(n)` / `insert(str)` /
 *    `remove(n)`, mirroring `protocol.Retain` / `protocol.Insert` /
 *    `protocol.Delete`;
 *  - the JSON form is `{"ops": [<string> | <positive number> | <negative number>], "reversion": <n>}`,
 *    where a string is an insert, a positive number a retain and a negative
 *    number a delete - the encoding `protocol.Operator.MarshalJSON` produces;
 *  - `transform(a, b)` returns `[a', b']` so that replaying `b` then `a'` and
 *    replaying `a` then `b'` reach the same document, using the same case
 *    analysis and remainder bookkeeping as Go's `Transform`;
 *  - `apply(op, text)` replays an operator over a document, as `Apply` does.
 *
 * LENGTH UNIT: every position and length inside an operator is a UTF-8 **byte**
 * offset, because that is what `len(string)` / `[]byte` mean on the Go side.
 * JS `String.prototype.length` counts UTF-16 code units and is therefore NOT
 * interchangeable with it: "中文" is 6 bytes but 2 code units. Use
 * `utf8Length()` when measuring text that an operator will refer to.
 *
 * Two backend behaviours are deliberately not reproduced, each marked where it
 * happens below:
 *  1. an atom pair the backend cannot consume is reported as an error (the Go
 *     `Transform` logs "unsupport operator" and returns it); here it throws, so a
 *     caller cannot end up applying half an operator, and the client can stop and
 *     ask for a re-link;
 *  2. the retain-vs-delete branch (`a.n < b.n`) carries two copy/paste slips in
 *     the Go code that make the result diverge; they are corrected here.
 */

/** Kind of a single atom; the values mirror Go's `protocol.TypeOperator`. */
export enum TypeOperator {
    Retain = 1,
    Insert = 2,
    Delete = 3,
}

/** Keep `n` bytes of the base document. Mirrors Go's `protocol.Retain`. */
export interface Retain {
    readonly type: TypeOperator.Retain;
    readonly n: number;
}

/** Insert `str` at the current position. Mirrors Go's `protocol.Insert`. */
export interface Insert {
    readonly type: TypeOperator.Insert;
    readonly str: string;
}

/** Drop `n` bytes of the base document. Mirrors Go's `protocol.Delete`. */
export interface Delete {
    readonly type: TypeOperator.Delete;
    readonly n: number;
}

/** One atom of an operator; mirrors Go's `protocol.OperatorAtomic`. */
export type OperatorAtomic = Retain | Insert | Delete;

/** Build a retain atom. Mirrors Go's `protocol.NewRetain`. */
export function retain(n: number): Retain {
    return { type: TypeOperator.Retain, n };
}

/** Build an insert atom. Mirrors Go's `protocol.NewInsert`. */
export function insert(str: string): Insert {
    return { type: TypeOperator.Insert, str };
}

/**
 * Build a delete atom. Mirrors Go's `protocol.NewDelete`.
 *
 * Named `remove` because `delete` is a reserved word in TypeScript. `n` is a
 * positive count, exactly like `protocol.Delete.N`.
 */
export function remove(n: number): Delete {
    return { type: TypeOperator.Delete, n };
}

/** UTF-8 byte length of an insert atom; mirrors Go's `Insert.len()`. */
export function insertLength(atom: Insert): number {
    return utf8Length(atom.str);
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

/** UTF-8 bytes of `text`; the counterpart of Go's `[]byte(str)`. */
export function encodeText(text: string): Uint8Array {
    return textEncoder.encode(text);
}

/**
 * Decode UTF-8 bytes back into a string; the counterpart of Go's `string(b)`.
 *
 * Invalid sequences become U+FFFD, because a JS string cannot hold arbitrary
 * bytes the way a Go `[]byte` can.
 */
export function decodeText(bytes: Uint8Array): string {
    return textDecoder.decode(bytes);
}

/** UTF-8 byte length of `text`; the counterpart of Go's `len(str)`. */
export function utf8Length(text: string): number {
    return textEncoder.encode(text).length;
}

/** One atom in its wire form: a string is an insert, a number a retain/delete. */
export type OperatorOpJson = string | number;

/** Wire form of a whole operator, as `protocol.Operator.MarshalJSON` emits it. */
export interface OperatorJson {
    ops: OperatorOpJson[];
    reversion: number;
}

/** Wire form of one atom to a single JSON value. */
function atomToJson(atom: OperatorAtomic): OperatorOpJson {
    switch (atom.type) {
        case TypeOperator.Retain:
            return atom.n;
        case TypeOperator.Insert:
            return atom.str;
        case TypeOperator.Delete:
            return -atom.n;
    }
}

/**
 * Parse one wire atom; mirrors the branch structure of
 * `protocol.Operator.UnmarshalJSON`.
 *
 * The backend normalises the sign the same way (`Delete{int(-v)}` for a negative
 * wire number), so `-5` decodes to `remove(5)` on both sides, matching
 * `NewDelete(5)`. Numbers are truncated to integers the way Go's `int(float64)`
 * conversion does.
 */
function atomFromJson(item: unknown): OperatorAtomic {
    if (typeof item === "string") {
        return insert(item);
    }
    if (typeof item === "number") {
        const n = Math.trunc(item);
        return n >= 0 ? retain(n) : remove(-n);
    }
    throw new Error(`operator atom must be a string or a number, got ${JSON.stringify(item)}`);
}

/**
 * An operator: the atoms to replay plus the revision they are based on.
 * Mirrors Go's `protocol.Operator`.
 */
export class Operator {
    /** The atoms, in document order. Atoms are treated as immutable. */
    ops: OperatorAtomic[];

    /** Revision of the document the atoms are based on. */
    reversion: number;

    constructor(ops: OperatorAtomic[] = [], reversion = 0) {
        this.ops = ops;
        this.reversion = reversion;
    }

    /** Number of atoms; mirrors Go's `(*Operator).len()`. */
    get length(): number {
        return this.ops.length;
    }

    /** Bytes of the base document the operator consumes (retains + deletes). */
    get baseLength(): number {
        let total = 0;
        for (const atom of this.ops) {
            switch (atom.type) {
                case TypeOperator.Retain:
                case TypeOperator.Delete:
                    total += atom.n;
                    break;
                case TypeOperator.Insert:
                    break;
            }
        }
        return total;
    }

    /** Bytes of the document the operator produces (retains + inserts). */
    get targetLength(): number {
        let total = 0;
        for (const atom of this.ops) {
            switch (atom.type) {
                case TypeOperator.Retain:
                    total += atom.n;
                    break;
                case TypeOperator.Insert:
                    total += insertLength(atom);
                    break;
                case TypeOperator.Delete:
                    break;
            }
        }
        return total;
    }

    /**
     * Replay the operator over `text`; the string-facing counterpart of Go's
     * `Apply([]byte) []byte`. `text` is encoded to UTF-8 first, because the
     * lengths in the atoms are byte offsets.
     */
    apply(text: string): string {
        return decodeText(this.applyToBytes(encodeText(text)));
    }

    /**
     * Replay the operator over `text` byte by byte; the port of Go's
     * `(*Operator).Apply`.
     *
     * As in Go, a retain that runs past the end of `text` is skipped and the
     * scan continues with the next atom, while a delete is not bounds-checked.
     */
    applyToBytes(text: Uint8Array): Uint8Array {
        const chunks: Uint8Array[] = [];
        let total = 0;
        let idx = 0;

        for (const atom of this.ops) {
            switch (atom.type) {
                case TypeOperator.Insert: {
                    const bytes = encodeText(atom.str);
                    chunks.push(bytes);
                    total += bytes.length;
                    break;
                }
                case TypeOperator.Retain: {
                    if (idx + atom.n > text.length) {
                        break;
                    }
                    const part = text.subarray(idx, idx + atom.n);
                    chunks.push(part);
                    total += part.length;
                    idx += atom.n;
                    break;
                }
                case TypeOperator.Delete:
                    idx += atom.n;
                    break;
            }
        }

        const out = new Uint8Array(total);
        let at = 0;
        for (const chunk of chunks) {
            out.set(chunk, at);
            at += chunk.length;
        }
        return out;
    }

    /**
     * Transform this operator against `other`; the port of Go's
     * `(*Operator).Transform`.
     *
     * @param other an operator based on the same revision
     * @returns `[this', other']`, where `this'` applies to `other`'s output and
     * `other'` applies to `this`'s output; both describe one convergent state.
     * @throws when the two operators cannot be reconciled, i.e. the backend
     * branch that can only log "unsupport operator".
     */
    transform(other: Operator): [Operator, Operator] {
        const aIt = new OperatorIterator(this);
        const bIt = new OperatorIterator(other);
        const aPrime = new Operator([], this.reversion);
        const bPrime = new Operator([], other.reversion);

        for (;;) {
            if (aIt.get() === null && bIt.get() === null) {
                break;
            }

            // An insert exists in only one side, so the other side merely
            // retains over it.
            const bInsert = bIt.getInsert();
            if (bInsert !== null) {
                aPrime.ops.push(retain(insertLength(bInsert)));
                bPrime.ops.push(bInsert);
                bIt.next();
                continue;
            }

            const aInsert = aIt.getInsert();
            if (aInsert !== null) {
                aPrime.ops.push(aInsert);
                bPrime.ops.push(retain(insertLength(aInsert)));
                aIt.next();
                continue;
            }

            // Both delete the same region: consume the shorter run and keep the
            // remainder of the longer one, which no side has to record.
            const aDelete = aIt.getDelete();
            const bDelete = bIt.getDelete();
            if (aDelete !== null && bDelete !== null) {
                if (aDelete.n === bDelete.n) {
                    aIt.next();
                    bIt.next();
                } else if (aDelete.n > bDelete.n) {
                    aIt.refresh(remove(aDelete.n - bDelete.n));
                    bIt.next();
                } else {
                    aIt.next();
                    bIt.refresh(remove(bDelete.n - aDelete.n));
                }
                continue;
            }

            const bRetain = bIt.getRetain();
            const aRetain = aIt.getRetain();

            // a deletes while b retains: the overlap is really deleted, so it
            // belongs to a' only; leftovers keep their own kind.
            if (aDelete !== null && bRetain !== null) {
                if (aDelete.n === bRetain.n) {
                    aPrime.ops.push(aDelete);
                    aIt.next();
                    bIt.next();
                } else if (aDelete.n > bRetain.n) {
                    aPrime.ops.push(remove(bRetain.n));
                    aIt.refresh(remove(aDelete.n - bRetain.n));
                    bIt.next();
                } else {
                    aPrime.ops.push(remove(aDelete.n));
                    aIt.next();
                    bIt.refresh(retain(bRetain.n - aDelete.n));
                }
                continue;
            }

            // a retains while b deletes: the mirror image of the branch above,
            // now recorded on b'.
            if (aRetain !== null && bDelete !== null) {
                if (aRetain.n === bDelete.n) {
                    bPrime.ops.push(bDelete);
                    aIt.next();
                    bIt.next();
                } else if (aRetain.n > bDelete.n) {
                    bPrime.ops.push(remove(bDelete.n));
                    aIt.refresh(retain(aRetain.n - bDelete.n));
                    bIt.next();
                } else {
                    // Backend fix 2: `protocol/operator.go` appends this atom to
                    // aPrime (copy/paste slip) and refreshes b with a Retain, so
                    // the rest of b's delete is lost. Both are corrected here.
                    bPrime.ops.push(remove(aRetain.n));
                    aIt.next();
                    bIt.refresh(remove(bDelete.n - aRetain.n));
                }
                continue;
            }

            // Both retain the same region: the overlap is untouched by either.
            if (aRetain !== null && bRetain !== null) {
                if (aRetain.n === bRetain.n) {
                    aPrime.ops.push(aRetain);
                    bPrime.ops.push(bRetain);
                    aIt.next();
                    bIt.next();
                } else if (aRetain.n > bRetain.n) {
                    aPrime.ops.push(retain(bRetain.n));
                    bPrime.ops.push(bRetain);
                    aIt.refresh(retain(aRetain.n - bRetain.n));
                    bIt.next();
                } else {
                    aPrime.ops.push(aRetain);
                    bPrime.ops.push(retain(aRetain.n));
                    aIt.next();
                    bIt.refresh(retain(bRetain.n - aRetain.n));
                }
                continue;
            }

            // One side is exhausted, so whatever it did not mention is retained
            // by the other side as well.
            if (aIt.get() === null) {
                const bTail = bIt.getRetain();
                if (bTail !== null) {
                    aPrime.ops.push(bTail);
                    bPrime.ops.push(bTail);
                    bIt.next();
                    continue;
                }
            }

            if (bIt.get() === null) {
                const aTail = aIt.getRetain();
                if (aTail !== null) {
                    aPrime.ops.push(aTail);
                    bPrime.ops.push(aTail);
                    aIt.next();
                    continue;
                }
            }

            // Backend fix 1: this is the pair `protocol.Transform` reports as
            // "unsupport operator"; the two operators are based on different
            // lengths, so no pair of results can be produced.
            throw new Error(
                "unsupported operator pair: the two operators are not compatible " +
                `(a=${JSON.stringify(this.toJSON())}, b=${JSON.stringify(other.toJSON())})`,
            );
        }

        return [aPrime, bPrime];
    }

    /** The atoms in wire form: insert as a string, retain as `n`, delete as `-n`. */
    toOpsArray(): OperatorOpJson[] {
        return this.ops.map(atomToJson);
    }

    /** The operator in the JSON shape `protocol.Operator.MarshalJSON` emits. */
    toJSON(): OperatorJson {
        return { ops: this.toOpsArray(), reversion: this.reversion };
    }

    /**
     * The bare atom array `protocol.Operator.UnmarshalJSON` accepts as input.
     *
     * The backend marshals an object (`{"ops": ...}`) but unmarshals an array,
     * so this is the form to put into `edit.operator` when sending an edit.
     */
    toOperatorField(): OperatorOpJson[] {
        return this.toOpsArray();
    }

    /**
     * Build an operator from an already parsed wire value.
     *
     * Both shapes are accepted: the object form the backend emits and the bare
     * atom array it reads, so a payload that travelled through the server can be
     * rebuilt without guessing which side produced it.
     */
    static fromJSON(value: unknown): Operator {
        let rawOps: unknown;
        let reversion = 0;

        if (Array.isArray(value)) {
            rawOps = value;
        } else if (typeof value === "object" && value !== null) {
            const record = value as { ops?: unknown; reversion?: unknown };
            rawOps = record.ops;
            if (typeof record.reversion === "number") {
                reversion = Math.trunc(record.reversion);
            }
        } else {
            throw new Error(`operator must be an object or an array, got ${JSON.stringify(value)}`);
        }

        if (!Array.isArray(rawOps)) {
            throw new Error(`operator "ops" must be an array, got ${JSON.stringify(rawOps)}`);
        }

        return new Operator(rawOps.map(atomFromJson), reversion);
    }

    /** Build an operator from JSON text; accepts either wire shape. */
    static parse(json: string): Operator {
        return Operator.fromJSON(JSON.parse(json) as unknown);
    }
}

/**
 * Transform `a` against `b`; a thin alias of `Operator.prototype.transform` for
 * callers that prefer a free function.
 */
export function transform(a: Operator, b: Operator): [Operator, Operator] {
    return a.transform(b);
}

/**
 * Cursor over the atoms of an operator; the port of Go's `operatorIterator`.
 *
 * `idx` points at the atom in use and `cur` overrides it once a branch has
 * consumed part of that atom, so an atom can be shortened in place and the scan
 * resumes at the next one.
 */
class OperatorIterator {
    private readonly ops: readonly OperatorAtomic[];
    private cur: OperatorAtomic | null = null;
    private idx = 0;

    constructor(oper: Operator) {
        this.ops = oper.ops;
    }

    /** The atom at the cursor, or null once the operator is exhausted. */
    get(): OperatorAtomic | null {
        if (this.cur !== null) {
            return this.cur;
        }
        if (this.idx >= this.ops.length) {
            return null;
        }
        return this.ops[this.idx];
    }

    /** Consume the atom at the cursor and move on. */
    next(): void {
        if (this.idx >= this.ops.length) {
            return;
        }
        this.cur = null;
        this.idx += 1;
    }

    /** Replace the atom at the cursor with what is left of it. */
    refresh(atom: OperatorAtomic): void {
        this.cur = atom;
    }

    /** The atom at the cursor when it is an insert, otherwise null. */
    getInsert(): Insert | null {
        const atom = this.get();
        return atom !== null && atom.type === TypeOperator.Insert ? atom : null;
    }

    /** The atom at the cursor when it is a retain, otherwise null. */
    getRetain(): Retain | null {
        const atom = this.get();
        return atom !== null && atom.type === TypeOperator.Retain ? atom : null;
    }

    /** The atom at the cursor when it is a delete, otherwise null. */
    getDelete(): Delete | null {
        const atom = this.get();
        return atom !== null && atom.type === TypeOperator.Delete ? atom : null;
    }
}

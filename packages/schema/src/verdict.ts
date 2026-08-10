export * as Verdict from "./verdict"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema"

/**
 * The contract the board renders.
 *
 * BOARD-01. The harness does not compute any of this: the kernel judges, signs
 * and journals outside the process, and the harness only shows the result. This
 * file is the shape of that result and nothing else — there is deliberately no
 * evaluation logic here, because a second implementation of a verdict is a
 * second verdict.
 *
 * Field names mirror `Evaluation.as_record()` in the kernel
 * (`src/ranex/governed_execution/domain/verdict.py`) so the two cannot drift
 * apart silently, plus two additions the kernel record does not carry today:
 * `causes` (BOARD-02) and `rejections`, which come from the admission layer
 * below the kernel.
 */

/** `X | null`, spelled the way effect 4 spells a union. */
const nullable = <S extends Schema.Top>(schema: S) => Schema.Union([schema, Schema.Null])

/**
 * Two values, closed. Absence is already FAIL by the kernel's own invariant —
 * *a required claim with no satisfying evidence is FAIL, never a default* — so
 * there is no third state and no rank.
 */
export const Outcome = Schema.Literals(["PASS", "FAIL"]).annotate({
  identifier: "ranex.verdict.outcome",
})
export type Outcome = Schema.Schema.Type<typeof Outcome>

/**
 * Why a required claim went unsatisfied. Seven kinds, and **unordered**:
 * `absent` is not a worse `failed`, and `refused` is not a worse `stale`. They
 * demand different actions — produce the evidence, fix the code, re-run against
 * this tree, or investigate an attack.
 *
 * Five come from the kernel's `_diagnosis`; `refused` and `unattributable` come
 * from admission, below it. Only one of the seven means work never done, and
 * reporting any other under that wording lets an attacker choose the wording of
 * the report by choosing which field to tamper with — the defect that reopened
 * SLICE-002.
 */
export const KNOWN_CAUSES = [
  "contradicted",
  "failed",
  "mismatched",
  "stale",
  "absent",
  "refused",
  "unattributable",
] as const
export type KnownCause = (typeof KNOWN_CAUSES)[number]

export function isKnownCause(value: string): value is KnownCause {
  return (KNOWN_CAUSES as readonly string[]).includes(value)
}

/**
 * Per-claim cause.
 *
 * `cause` is a plain string on the wire, not a closed literal, and that is
 * deliberate. If the kernel gains an eighth cause, a strict union would reject
 * the whole record and the operator would see no verdict at all — strictly
 * worse than seeing one cause they cannot name. Renderers match exhaustively
 * over `KNOWN_CAUSES` and show anything else as unclassified.
 *
 * `claim_id` is nullable because an admission rejection can carry no usable
 * claim. Coercing that null to a claim is exactly how a forgery gets filed as
 * honest absence, so the null survives to the screen.
 */
export const ClaimCause = Schema.Struct({
  claim_id: nullable(Schema.String),
  cause: Schema.String,
  detail: optional(Schema.String),
}).annotate({ identifier: "ranex.verdict.claim-cause" })
export interface ClaimCause extends Schema.Schema.Type<typeof ClaimCause> {}

/**
 * A record refused before the kernel ever saw it. Rendered whatever the
 * verdict: a forgery a gate happened to pass without is still a forgery.
 */
export const Rejection = Schema.Struct({
  index: NonNegativeInt,
  reason: Schema.String,
  detail: Schema.String,
  claim_id: nullable(Schema.String),
}).annotate({ identifier: "ranex.verdict.rejection" })
export interface Rejection extends Schema.Schema.Type<typeof Rejection> {}

/**
 * One evaluation of one subject against one gate.
 *
 * Every field is required. There is no partial verdict: a record missing its
 * subject digest describes no tree, and a record missing its outcome is not a
 * verdict. Absence blocks here too, so the decode fails rather than defaulting.
 */
export const Record = Schema.Struct({
  verdict: Outcome,
  gate_id: Schema.String,
  /** The tree this verdict is about. Evidence proves nothing without it. */
  subject_digest: Schema.String,
  subject_lane: Schema.String,
  /** Policy provenance: which catalog decided. Null when none was bound. */
  catalog_digest: nullable(Schema.String),
  approver_id: Schema.String,
  failing_rule: nullable(Schema.String),
  missing_claims: Schema.Array(Schema.String),
  considered: Schema.Array(Schema.String),
  causes: Schema.Array(ClaimCause),
  rejections: Schema.Array(Rejection),
  /**
   * The kernel's own sentence, for humans and for the journal. Renderers must
   * never parse it to recover a cause — the wording is not an interface, and
   * reworded prose would mislabel a forgery as absence. Use `causes`.
   */
  reason: nullable(Schema.String),
  record_digest: Schema.String,
}).annotate({ identifier: "ranex.verdict.record" })
export interface Record extends Schema.Schema.Type<typeof Record> {}

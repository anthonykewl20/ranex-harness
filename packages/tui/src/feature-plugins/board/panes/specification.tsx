import type { TuiPluginApi } from "@ranex/plugin/tui"
import { detectGlyphs } from "../../../theme/glyphs"
import type { BoardPaneProps } from "../pane"

const glyphs = detectGlyphs()

export const SPECIFICATION_NOT_YET_SPECIFIED = "not yet specified"
export const SPECIFICATION_APPROVED = "APPROVED"
export const SPECIFICATION_UNPROVEN = "UNPROVEN"
export const SPECIFICATION_SELF_APPROVAL = "SELF-APPROVAL FLAG"
export const SPECIFICATION_SUITE_MISMATCH = "MISMATCH"

export const SPECIFICATION_ROW_LABELS = [
  "A SpecPacket",
  "approved scope",
  "approved outcomes",
  "packet digest",
  "B Artifact manifest",
  "generated paths",
  "protected paths",
  "manifest digest",
  "C ApprovalEnvelope",
  "approver identity",
  "producer identity",
  "envelope digest",
  "expiry / revocation",
  "self-approval check",
  "frozen suite manifest digest",
  "running suite",
  "red then green",
  "pane capability",
] as const

/**
 * Rendering vocabulary only, not an upstream contract for A, B, or C.
 *
 * Those contracts do not exist yet, and BoardData intentionally cannot expose
 * fields it never read. These states keep the specified failure presentations
 * testable without guessing any packet, manifest, or envelope wire shape.
 */
export type SpecificationPresentation = {
  readonly approval: "missing" | "approved" | "expired" | "revoked" | "not-yet-specified"
  readonly identity:
    | { readonly state: "not-yet-specified" }
    | { readonly state: "known"; readonly approver: string; readonly producer: string }
  readonly suite: "matches" | "mismatch" | "not-yet-specified"
  readonly redThenGreen: "observed" | "unproven" | "not-yet-specified"
}

const CURRENT_PRESENTATION = {
  approval: "not-yet-specified",
  identity: { state: "not-yet-specified" },
  suite: "not-yet-specified",
  redThenGreen: "not-yet-specified",
} satisfies SpecificationPresentation

type Color = TuiPluginApi["theme"]["current"]["text"]

export function SpecificationDetails(props: {
  readonly api: TuiPluginApi
  readonly presentation: SpecificationPresentation
}) {
  const theme = () => props.api.theme.current
  const approval = () => approvalPresentation(props.presentation.approval, props.api)
  const identity = () => identityPresentation(props.presentation.identity, props.api)
  const suite = () => suitePresentation(props.presentation.suite, props.api)
  const redThenGreen = () => redThenGreenPresentation(props.presentation.redThenGreen, props.api)

  return (
    <box>
      <SpecificationRow api={props.api} label="A SpecPacket" value={SPECIFICATION_NOT_YET_SPECIFIED} color={theme().primary} />
      <SpecificationRow api={props.api} label="approved scope" value={SPECIFICATION_NOT_YET_SPECIFIED} />
      <SpecificationRow api={props.api} label="approved outcomes" value={SPECIFICATION_NOT_YET_SPECIFIED} />
      <SpecificationRow api={props.api} label="packet digest" value={SPECIFICATION_NOT_YET_SPECIFIED} />
      <SpecificationRow
        api={props.api}
        label="B Artifact manifest"
        value={SPECIFICATION_NOT_YET_SPECIFIED}
        color={theme().primary}
      />
      <SpecificationRow api={props.api} label="generated paths" value={SPECIFICATION_NOT_YET_SPECIFIED} />
      <SpecificationRow api={props.api} label="protected paths" value={SPECIFICATION_NOT_YET_SPECIFIED} />
      <SpecificationRow api={props.api} label="manifest digest" value={SPECIFICATION_NOT_YET_SPECIFIED} />
      <SpecificationRow api={props.api} label="C ApprovalEnvelope" value={approval().summary} color={approval().color} />
      <SpecificationRow api={props.api} label="approver identity" value={identity().approver} />
      <SpecificationRow api={props.api} label="producer identity" value={identity().producer} />
      <SpecificationRow api={props.api} label="envelope digest" value={SPECIFICATION_NOT_YET_SPECIFIED} />
      <SpecificationRow api={props.api} label="expiry / revocation" value={approval().validity} color={approval().color} />
      <SpecificationRow api={props.api} label="self-approval check" value={identity().check} color={identity().color} />
      <SpecificationRow
        api={props.api}
        label="frozen suite manifest digest"
        value={SPECIFICATION_NOT_YET_SPECIFIED}
      />
      <SpecificationRow api={props.api} label="running suite" value={suite().text} color={suite().color} />
      <SpecificationRow
        api={props.api}
        label="red then green"
        value={redThenGreen().text}
        color={redThenGreen().color}
      />
      <SpecificationRow
        api={props.api}
        label="pane capability"
        value="READ-ONLY — approves nothing and holds no key"
        color={theme().textMuted}
      />
    </box>
  )
}

function Specification(props: BoardPaneProps) {
  if (props.data.state === "unread") {
    return (
      <box>
        <text fg={props.api.theme.current.warning}>{glyphs.warn} Specification unavailable.</text>
        <text fg={props.api.theme.current.text}>No specification approval was read.</text>
        <text fg={props.api.theme.current.textMuted}>{props.data.why}</text>
        <SpecificationDetails api={props.api} presentation={CURRENT_PRESENTATION} />
      </box>
    )
  }

  return (
    <box>
      <text fg={props.api.theme.current.warning}>{glyphs.warn} Specification contracts unavailable.</text>
      <text fg={props.api.theme.current.text}>A verdict was read, but no A, B, or C data source was provided.</text>
      <text fg={props.api.theme.current.textMuted}>subject {props.data.record.subject_digest}</text>
      <SpecificationDetails api={props.api} presentation={CURRENT_PRESENTATION} />
    </box>
  )
}

function SpecificationRow(props: {
  readonly api: TuiPluginApi
  readonly label: (typeof SPECIFICATION_ROW_LABELS)[number]
  readonly value: string
  readonly color?: Color
}) {
  return (
    <box flexDirection="row">
      <text width={31} fg={props.api.theme.current.textMuted}>
        {props.label}
      </text>
      <text flexGrow={1} fg={props.color ?? props.api.theme.current.text}>
        {props.value}
      </text>
    </box>
  )
}

function approvalPresentation(state: SpecificationPresentation["approval"], api: TuiPluginApi) {
  switch (state) {
    case "missing":
      return {
        summary: `${glyphs.warn} NO APPROVAL EXISTS — absence blocks`,
        validity: "not applicable — no envelope exists",
        color: api.theme.current.error,
      }
    case "approved":
      return {
        summary: `${glyphs.ok} ${SPECIFICATION_APPROVED} — envelope active`,
        validity: `${glyphs.ok} ACTIVE — neither expired nor revoked`,
        color: api.theme.current.success,
      }
    case "expired":
      return {
        summary: `${glyphs.no} EXPIRED — approval invalid`,
        validity: `${glyphs.no} EXPIRED — envelope cannot approve this run`,
        color: api.theme.current.error,
      }
    case "revoked":
      return {
        summary: `${glyphs.no} REVOKED — approval invalid`,
        validity: `${glyphs.no} REVOKED — envelope cannot approve this run`,
        color: api.theme.current.error,
      }
    case "not-yet-specified":
      return {
        summary: `${SPECIFICATION_NOT_YET_SPECIFIED} — approval unavailable`,
        validity: SPECIFICATION_NOT_YET_SPECIFIED,
        color: api.theme.current.warning,
      }
  }
  const exhaustive: never = state
  return exhaustive
}

function identityPresentation(identity: SpecificationPresentation["identity"], api: TuiPluginApi) {
  if (identity.state === "not-yet-specified") {
    return {
      approver: SPECIFICATION_NOT_YET_SPECIFIED,
      producer: SPECIFICATION_NOT_YET_SPECIFIED,
      check: `${SPECIFICATION_NOT_YET_SPECIFIED} — independence cannot be established`,
      color: api.theme.current.warning,
    }
  }

  if (identity.approver === identity.producer) {
    return {
      approver: identity.approver,
      producer: identity.producer,
      check: `${glyphs.flag} ${SPECIFICATION_SELF_APPROVAL} — approver equals producer; blocks`,
      color: api.theme.current.error,
    }
  }

  return {
    approver: identity.approver,
    producer: identity.producer,
    check: `${glyphs.ok} INDEPENDENT — approver differs from producer`,
    color: api.theme.current.success,
  }
}

function suitePresentation(state: SpecificationPresentation["suite"], api: TuiPluginApi) {
  switch (state) {
    case "matches":
      return {
        text: `${glyphs.ok} MATCH — running suite matches frozen suite`,
        color: api.theme.current.success,
      }
    case "mismatch":
      return {
        text: `${glyphs.no} ${SPECIFICATION_SUITE_MISMATCH} — run not judged against frozen suite`,
        color: api.theme.current.error,
      }
    case "not-yet-specified":
      return {
        text: `${SPECIFICATION_NOT_YET_SPECIFIED} — suite comparison unavailable`,
        color: api.theme.current.warning,
      }
  }
  const exhaustive: never = state
  return exhaustive
}

function redThenGreenPresentation(state: SpecificationPresentation["redThenGreen"], api: TuiPluginApi) {
  switch (state) {
    case "observed":
      return {
        text: `${glyphs.ok} OBSERVED — red then green`,
        color: api.theme.current.success,
      }
    case "unproven":
      return {
        text: `${glyphs.warn} ${SPECIFICATION_UNPROVEN} — red then green was not observed`,
        color: api.theme.current.warning,
      }
    case "not-yet-specified":
      return {
        text: `${glyphs.warn} ${SPECIFICATION_UNPROVEN} — observation ${SPECIFICATION_NOT_YET_SPECIFIED}`,
        color: api.theme.current.warning,
      }
  }
  const exhaustive: never = state
  return exhaustive
}

export const SpecificationPane = {
  id: "ranex.board.specification",
  title: "Specification",
  order: 300,
  render: (props) => <Specification {...props} />,
} satisfies import("../pane").BoardPane

import {
  evaluateSpecificationAdmission,
  type SpecificationAdmissionEnvelope,
  type SpecificationAdmissionFacts,
  type SpecificationAdmissionRequest,
  type SpecificationGrantFacts,
} from "@opencode-ai/core/tool/specification-admission"

export interface ControlPlaneSpecificationAdmissionInput {
  readonly request: SpecificationAdmissionRequest
  readonly grant: SpecificationGrantFacts
  readonly observed_caller_principal_id?: string
  readonly observed_caller_key?: string
  readonly observed_event_head?: string
  readonly observed_position?: number
  readonly now?: number
  readonly child_capabilities?: SpecificationGrantFacts["capabilities"]
}

export function admitSpecification(input: ControlPlaneSpecificationAdmissionInput): SpecificationAdmissionEnvelope {
  const facts: SpecificationAdmissionFacts = {
    grant: input.grant,
    observed_caller_principal_id: input.observed_caller_principal_id,
    observed_caller_key: input.observed_caller_key,
    observed_event_head: input.observed_event_head,
    observed_position: input.observed_position,
    now: input.now,
    child_capabilities: input.child_capabilities,
  }
  return evaluateSpecificationAdmission(input.request, facts)
}

export const evaluateControlPlaneSpecificationAdmission = admitSpecification
